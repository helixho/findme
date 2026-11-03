import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { type Batch, DogfoodError } from "../src/dogfood/model.js";
import { BatchStore } from "../src/dogfood/store.js";
import { digest } from "../src/understanding-baseline/io.js";
import { type JobOptions, jobRunner } from "../src/understanding-baseline/jobs.js";
import type { RepairRequest } from "../src/understanding-baseline/prepare.js";
import {
  buildPublishedVersion,
  verifyPublishedVersion,
} from "../src/understanding-baseline/publication.js";
import { recoveryPublication } from "../src/understanding-baseline/recovery-publication.js";
import { groupRepairRequests } from "../src/understanding-baseline/repair-jobs.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pipeline-structure-")));
  directories.push(dir);
  return dir;
}

it("bounds repair batches by serialized UTF-8 bytes and count without reordering eligible requests", () => {
  const request = (id: string, opinion: unknown = "synthetic"): RepairRequest =>
    ({ id, kind: "sample", canonical_id: id, windows: [], rows: [], opinion }) as RepairRequest;
  const excluded = { ...request("excluded"), unavailable: "synthetic_unavailable" };
  const oversized = request("oversized", "中".repeat(10000));
  const eligible = Array.from({ length: 33 }, (_, i) => request(`r${i}`));
  const result = groupRepairRequests([
    excluded,
    ...eligible.slice(0, 16),
    oversized,
    ...eligible.slice(16),
  ]);
  expect(result.groups.map((group) => group.length)).toEqual([16, 16, 1]);
  expect(result.groups.flat()).toEqual(eligible);
  expect(result.oversized).toEqual([oversized]);
  // The byte gate must split even when neither individual request is oversized.
  expect(
    groupRepairRequests([
      request("a", "中".repeat(5000)),
      request("b", "中".repeat(5000)),
    ]).groups.map((g) => g.length),
  ).toEqual([1, 1]);
});

it("keeps completed job bytes and usage frozen when provider output and usage arrive late", async () => {
  const out = await temporary();
  let controls: Parameters<NonNullable<JobOptions["gateway"]>["extract"]>[0]["controls"];
  const gateway: NonNullable<JobOptions["gateway"]> = {
    describe: (route) => ({ route, model: "synthetic" }),
    extract: async (args) => {
      controls = args.controls;
      await controls?.captureRawOutput?.('"accepted"');
      return args.schema.parse("accepted");
    },
  };
  const options = {
    out,
    inputHash: "a".repeat(64),
    model: "synthetic",
    gateway,
    live: true,
    maxCalls: 1,
    fresh: async () => {},
  };
  const jobs = await jobRunner(options);
  expect(await jobs.job("repair", { synthetic: true }, z.string())).toBe("accepted");
  const id = jobs.attempts[0]?.job;
  const file = path.join(out, "jobs", `${id}.json`);
  const before = await readFile(file, "utf8");
  const usage = await readFile(path.join(out, "usage.json"), "utf8");
  await controls?.captureRawOutput?.('"late"');
  const late = {
    route: "extraction_model",
    model: "synthetic",
    attempt: 1,
    estimate: {
      method: "serialized_utf8_bytes_conservative",
      serializedUtf8Bytes: 1,
      estimatedInputTokens: 1,
    },
    status: "ok",
    errorKind: null,
    latencyMs: 1,
    usage: null,
  } as const;
  await controls?.observer?.afterAttempt(late);
  await expect(controls?.observer?.beforeAttempt(late)).rejects.toThrow("ATTEMPT_NO_LONGER_ACTIVE");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readFile(path.join(out, "usage.json"), "utf8")).toBe(usage);
  const names = await readdir(path.join(out, "jobs"));
  const raw = names.find((name) => name.endsWith("-raw.txt"));
  expect(await readFile(path.join(out, "jobs", `${raw}.late`), "utf8")).toBe('"late"');
  expect(
    JSON.parse(await readFile(path.join(out, "jobs", `${raw}.late-usage.json`), "utf8")),
  ).toEqual(late);
  const replay = await jobRunner({ ...options, live: false });
  expect(await replay.job("repair", { synthetic: true }, z.string())).toBe("accepted");
  expect(replay.callsThisRun).toBe(0);
});

it("checks a cached manifest before dry-run decisions and preserves result-integrity error precedence", async () => {
  const out = await temporary();
  const options = {
    out,
    inputHash: "a".repeat(64),
    model: "synthetic",
    maxCalls: 0,
    fresh: async () => {},
  };
  const jobs = await jobRunner(options);
  const payload = { synthetic: true };
  const result = await jobs.seedDeterministic("repair", payload, z.string(), () => {}, "accepted", {
    version: "synthetic",
    source_job: "source",
    source_hash: "b".repeat(64),
    removed_targets: [],
  });
  expect(result).toBe("accepted");
  const file = path.join(out, "jobs", `${jobs.usedJobs[0]?.job}.json`);
  const cached = JSON.parse(await readFile(file, "utf8"));
  cached.result = "forged";
  delete cached.raw_file;
  await writeFile(file, JSON.stringify(cached));
  await expect(jobs.job("repair", payload, z.string())).rejects.toThrow("JOB_RESULT_INTEGRITY");
  expect(jobs.callsThisRun).toBe(0);
});

it("publishes only after freshness succeeds and validates manifest membership before artifact bytes", async () => {
  const versions = await temporary();
  const directory = path.join(versions, "published");
  const events: string[] = [];
  await expect(
    buildPublishedVersion(
      versions,
      directory,
      async (temp) => {
        events.push("write");
        await writeFile(path.join(temp, "baseline.json"), "{}");
      },
      async () => {
        events.push("fresh");
        throw new Error("SOURCE_CHANGED");
      },
    ),
  ).rejects.toThrow("SOURCE_CHANGED");
  expect(events).toEqual(["write", "fresh"]);
  expect(await readdir(versions)).not.toContain("published");
  await buildPublishedVersion(
    versions,
    directory,
    async (temp) => {
      await writeFile(
        path.join(temp, "manifest.json"),
        JSON.stringify({ version: "v", files: {} }),
      );
    },
    async () => {},
  );
  await expect(verifyPublishedVersion(directory, "v", ["baseline.json"])).rejects.toThrow(
    "VERSION_ARTIFACT_MANIFEST_INVALID",
  );
});

it("validates every recovery pointer before selecting the newest publication", async () => {
  const out = await temporary();
  const run = { input_hash: "a".repeat(64), model: "synthetic" };
  const baseline = { ...run, topics: [], status: "partial" };
  await writeFile(path.join(out, "baseline.json"), JSON.stringify(baseline));
  const pointer = { directory: out, version: digest(baseline), input_hash: run.input_hash };
  await writeFile(path.join(out, "latest-partial.json"), JSON.stringify(pointer));
  expect((await recoveryPublication(out, run)).pointer).toEqual(pointer);
  await writeFile(
    path.join(out, "latest-ready.json"),
    JSON.stringify({ ...pointer, input_hash: "b".repeat(64) }),
  );
  await expect(recoveryPublication(out, run)).rejects.toThrow("RECOVERY_BASELINE_CHANGED");
});

it("keeps candidate-before-source review precedence and checks idempotency before version or target", async () => {
  const batch = {
    sources: [{ id: "same", split: "dev" }],
    state: {
      version: 1,
      candidates: [{ id: "same", sourceId: "s", revision: 1, context: [] }],
      claims: [],
      runs: [],
      sourceReviews: {},
      feedback: [],
    },
  } as unknown as Batch;
  class MemoryStore extends BatchStore {
    override async update<T>(fn: (batch: Batch) => T | Promise<T>) {
      return fn(batch);
    }
  }
  const store = new MemoryStore("synthetic-unused");
  const input = {
    targetId: "same",
    action: "adopt",
    expectedVersion: 1,
    idempotencyKey: "synthetic-review-1",
  } as const;
  expect(await store.review(input)).toBe(2);
  expect(batch.state.candidates[0]?.status).toBe("adopted");
  expect(batch.state.sourceReviews).toEqual({});
  expect(await store.review(input)).toBe(2);
  expect(batch.state.feedback).toHaveLength(1);
  await expect(store.review({ ...input, targetId: "missing" })).rejects.toEqual(
    new DogfoodError("IDEMPOTENCY_CONFLICT"),
  );
  await expect(
    store.review({ ...input, idempotencyKey: "synthetic-review-2", targetId: "missing" }),
  ).rejects.toEqual(new DogfoodError("STALE_VERSION"));
});
