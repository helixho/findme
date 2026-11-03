import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FreezeManifest, RawSession } from "./freeze.js";
import {
  type Batch,
  DogfoodError,
  type Feedback,
  FeedbackInput,
  type State,
  hash,
  sourcesFrom,
} from "./model.js";
import {
  invalidateReviewDependencies,
  reviewCandidate,
  reviewClaim,
  reviewSource,
} from "./store-review.js";

export class BatchStore {
  constructor(readonly directory: string) {}
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.directory, ".staging-lock");
    let acquired = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      acquired = true;
    } catch {
      // Serialize stale-lock recovery so a late recovering process cannot remove a new lock.
      const recovery = path.join(this.directory, ".staging-lock-recovery");
      try {
        await mkdir(recovery, { mode: 0o700 });
      } catch {
        throw new DogfoodError("BATCH_BUSY");
      }
      try {
        let pid: number;
        try {
          pid = Number(await readFile(path.join(lock, "pid"), "utf8"));
        } catch {
          throw new DogfoodError("BATCH_BUSY");
        }
        if (!Number.isSafeInteger(pid) || pid < 1) throw new DogfoodError("BATCH_BUSY");
        try {
          process.kill(pid, 0);
          throw new DogfoodError("BATCH_BUSY");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            throw new DogfoodError("BATCH_BUSY");
        }
        await rm(lock, { recursive: true });
        try {
          await mkdir(lock, { mode: 0o700 });
          acquired = true;
          await writeFile(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
        } catch {
          throw new DogfoodError("BATCH_BUSY");
        }
      } finally {
        await rm(recovery, { recursive: true, force: true });
      }
    }
    if (!acquired) throw new DogfoodError("BATCH_BUSY");
    try {
      await writeFile(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  private async atomic(state: State) {
    const temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path.join(this.directory, "state.json"));
    } catch {
      await rm(temporary, { force: true });
      throw new DogfoodError("PERSIST_FAILED");
    }
  }
  async load(): Promise<Batch> {
    try {
      const manifestText = await readFile(path.join(this.directory, "manifest.json"), "utf8");
      const rawText = await readFile(path.join(this.directory, "raw.json"), "utf8");
      const manifest = JSON.parse(manifestText) as FreezeManifest;
      const rawValue = JSON.parse(rawText) as RawSession[] | { sessions: RawSession[] };
      const raw = Array.isArray(rawValue) ? rawValue : rawValue.sessions;
      if (manifest.format !== "findme-av-dogfood-v0.1" || !Array.isArray(raw))
        throw new DogfoodError("BATCH_INTEGRITY");
      if (
        raw.length !== manifest.sessions.length ||
        new Set(raw.map((s) => s.id)).size !== raw.length
      )
        throw new DogfoodError("BATCH_INTEGRITY");
      for (const session of raw) {
        const entry = manifest.sessions.find((s) => s.id === session.id);
        if (
          !entry ||
          entry.fingerprint !== hash(session.messages) ||
          session.fingerprint !== entry.fingerprint ||
          entry.groupId !== session.groupId ||
          hash(entry.messageIds) !== hash(session.messages.map((m) => m.id))
        )
          throw new DogfoodError("BATCH_INTEGRITY");
      }
      const sources = sourcesFrom(manifest, raw);
      let state: State;
      try {
        state = JSON.parse(
          await readFile(path.join(this.directory, "state.json"), "utf8"),
        ) as State;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = {
          format: "findme-av-staging@1",
          version: 1,
          manifestFingerprint: hash(manifestText),
          rawFingerprint: hash(rawText),
          model: null,
          scope: [],
          candidates: [],
          claims: [],
          runs: [],
          sourceReviews: {},
          feedback: [],
          requests: {},
          usage: {
            attempts: [],
            reservedInput: 0,
            outputCap: 2500,
            requestCap: 30,
            inputCap: 200000,
          },
        };
      }
      if (
        state.format !== "findme-av-staging@1" ||
        state.manifestFingerprint !== hash(manifestText) ||
        state.rawFingerprint !== hash(rawText)
      )
        throw new DogfoodError("BATCH_INTEGRITY");
      return { manifest, raw, sources, state };
    } catch (error) {
      if (error instanceof DogfoodError) throw error;
      throw new DogfoodError("BATCH_READ_FAILED");
    }
  }
  async update<T>(fn: (batch: Batch) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const batch = await this.load();
      const result = await fn(batch);
      await this.atomic(batch.state);
      return result;
    });
  }
  async recover() {
    await this.update((batch) => {
      for (const run of batch.state.runs.filter((r) => r.status === "running")) {
        if (run.ownerPid) {
          try {
            process.kill(run.ownerPid, 0);
            if (!run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) > Date.now()) continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        }
        run.status = "failed";
        run.error = "INTERRUPTED_RETRY_REQUIRED";
        for (const attempt of batch.state.usage.attempts.filter(
          (a) => a.runId === run.id && a.status === "reserved",
        ))
          attempt.status = "interrupted";
      }
    });
  }
  async review(input: Feedback) {
    const review = FeedbackInput.parse(input);
    return this.update((batch) => {
      const state = batch.state;
      const fp = hash(review);
      const prior = state.feedback.find((item) => item.idempotencyKey === review.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fp) throw new DogfoodError("IDEMPOTENCY_CONFLICT");
        return state.version;
      }
      if (review.expectedVersion !== state.version) throw new DogfoodError("STALE_VERSION");
      const candidate = state.candidates.find((c) => c.id === review.targetId);
      const claim = state.claims.find((c) => c.id === review.targetId);
      const source = batch.sources.find((s) => s.id === review.targetId && s.split === "dev");
      const note = review.note?.trim() ?? "";
      const affected = new Set<string>();
      if (candidate) reviewCandidate(candidate, review, note, affected);
      else if (source) reviewSource(batch, source, review, note, affected);
      else if (claim) reviewClaim(claim, review, note);
      else throw new DogfoodError("TARGET_NOT_FOUND");
      invalidateReviewDependencies(batch, review, affected, source, candidate);
      state.version++;
      state.feedback.push({
        ...review,
        at: new Date().toISOString(),
        version: state.version,
        fingerprint: fp,
      });
      return state.version;
    });
  }
}

export async function outsideRepo(directory: string, repoRoot: string) {
  if (!path.isAbsolute(directory)) throw new DogfoodError("ABSOLUTE_BATCH_REQUIRED");
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch {
    throw new DogfoodError("BATCH_READ_FAILED");
  }
  const repo = await realpath(repoRoot);
  const relative = path.relative(repo, resolved);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new DogfoodError("OUTSIDE_REPO_REQUIRED");
  return resolved;
}
