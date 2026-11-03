import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  OldClaimReview,
  UNDERSTANDING_VERSION,
  UnderstandingAudit,
  UnderstandingReport,
  UseRepairs,
} from "@findme/core";
import { z } from "zod";
import {
  type Assigned,
  POLICY,
  PROMPTS,
  assignReport,
  validateAudit,
  validateOld,
  validateReport,
} from "../domain/understanding/policy.js";
import { loadInputs } from "../understanding-baseline/input.js";
import { contains, digest, fail, inside, noLinks, sha256 } from "../understanding-baseline/io.js";
import {
  DOMAINS,
  type Domain,
  type Overlay,
  type Selection,
  facts,
  repairRequests,
  resolveRepairs,
} from "../understanding-baseline/prepare.js";
import {
  type RecoveryProof,
  boundFailure,
  recoveryManifestDependencies,
  verifyRecoveryProof,
} from "../understanding-baseline/recovery.js";
import { VerifiedSnapshotCache } from "./read-cache.js";

export type PrivateUnderstandingPaths = {
  repoRoot: string;
  batch: string;
  coverage: string;
  baselineDir: string;
  stateDir: string;
};
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Pointer = z.object({ version: Hash, directory: z.string(), input_hash: Hash });
const Topic = z.object({
  domain: z.enum(Object.keys(DOMAINS) as [Domain, ...Domain[]]),
  status: z.enum(["ready_candidate", "partial", "no_evidence", "context_required", "not_selected"]),
  version: Hash,
  candidate: z.unknown().nullable(),
  audit: z.unknown().nullable(),
  assigned: z.array(z.object({ id: z.string(), key: z.string(), category: z.string() })),
  selection: z.custom<Selection>(),
  recovery: z.custom<RecoveryProof>().optional(),
});
const Baseline = z
  .object({
    format: z.literal(UNDERSTANDING_VERSION),
    policy: z.literal(POLICY),
    prompt_hash: Hash,
    model: z.string(),
    input_hash: Hash,
    source_version_directory: z.string(),
    status: z.enum(["ready_candidate", "partial"]),
    overall: z.unknown().nullable(),
    overall_audit: z.unknown().nullable(),
    overall_assigned: z.array(z.object({ id: z.string(), key: z.string(), category: z.string() })),
    overall_selection: z.custom<Selection>(),
    topics: z.array(Topic),
    old_claim_review: z.unknown().nullable(),
    jobs: z.array(z.object({ stage: z.string(), job: z.string(), status: z.string() })),
  })
  .passthrough();
export type AcceptedReport = { version: string; report: UnderstandingReport; selection: Selection };
export async function validatePaths(p: PrivateUnderstandingPaths) {
  for (const name of ["repoRoot", "batch", "coverage", "baselineDir", "stateDir"] as const) {
    const value = p[name];
    if (!path.isAbsolute(value)) fail("ABSOLUTE_PATH_REQUIRED");
    await noLinks(value);
  }
  for (const name of ["repoRoot", "batch", "coverage", "baselineDir"] as const)
    if ((await realpath(p[name])) !== path.resolve(p[name])) fail("CANONICAL_PATH_REQUIRED");
  for (const root of [p.repoRoot, p.batch, p.coverage, p.baselineDir])
    if (
      contains(path.resolve(root), path.resolve(p.stateDir)) ||
      contains(path.resolve(p.stateDir), path.resolve(root))
    )
      fail("PROTECTED_FEEDBACK_STATE_PATH");
}
/** Pointer mtime orders publications; it is not an event or evidence timestamp. */
export function latestPublication<T extends { publishedAtMs: number; ptr: { version: string } }>(
  items: T[],
): T {
  const ordered = [...items].sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  if (!ordered[0]) fail("BASELINE_UNAVAILABLE");
  if (
    ordered[1] &&
    ordered[0].publishedAtMs === ordered[1].publishedAtMs &&
    ordered[0].ptr.version !== ordered[1].ptr.version
  )
    fail("AMBIGUOUS_BASELINE_PUBLICATION");
  return ordered[0];
}
/** Read only: never invokes a model, takes a U2 lock, or changes a pointer. */
async function loadBaseline(p: PrivateUnderstandingPaths) {
  await validatePaths(p);
  const input = await loadInputs(p.batch, p.coverage);
  const artifacts = new Map<string, { root: string; hash: string | null }>();
  const bytesCache = new Map<string, Buffer>();
  const publicationTimes = new Map<string, number>();
  const readBytes = async (root: string, file: string) => {
    const resolved = path.resolve(root, file);
    if (!contains(root, resolved)) fail("REFERENCE_PATH_ESCAPE");
    const cached = bytesCache.get(resolved);
    if (cached) return cached;
    const actual = await inside(root, file);
    const bytes = await readFile(actual);
    const hash = sha256(bytes);
    const prior = artifacts.get(actual);
    if (prior && prior.hash !== hash) fail("BASELINE_READ_RACE");
    artifacts.set(actual, { root, hash });
    bytesCache.set(actual, bytes);
    return bytes;
  };
  const read = async (root: string, file: string) =>
    JSON.parse((await readBytes(root, file)).toString());
  const sourceFresh = input.fresh;
  input.fresh = async () => {
    await sourceFresh();
    for (const [file, a] of artifacts) {
      let hash: string | null = null;
      try {
        hash = sha256(await readFile(await inside(a.root, file)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (hash !== a.hash) fail("BASELINE_READ_RACE");
    }
    for (const [file, published] of publicationTimes)
      if ((await stat(await inside(p.baselineDir, file))).mtimeMs !== published)
        fail("BASELINE_PUBLICATION_CHANGED");
  };
  const run = await read(p.baselineDir, "run.json");
  if (
    run.batch !== p.batch ||
    run.coverage !== p.coverage ||
    run.input_hash !== input.input_hash ||
    run.policy !== POLICY ||
    run.prompt_hash !== digest(PROMPTS) ||
    run.format !== UNDERSTANDING_VERSION
  )
    fail("U2_RUN_SOURCE_MISMATCH");
  const pointers = [];
  for (const name of ["latest-ready.json", "latest-partial.json"]) {
    let raw: unknown;
    try {
      raw = await read(p.baselineDir, name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      artifacts.set(path.join(p.baselineDir, name), { root: p.baselineDir, hash: null });
    }
    if (raw === undefined) continue;
    const ptr = Pointer.parse(raw);
    if (ptr.input_hash !== input.input_hash) fail("STALE_BASELINE_POINTER");
    const dir = await inside(p.baselineDir, ptr.directory);
    if (dir !== path.join(p.baselineDir, "versions", ptr.version)) fail("BASELINE_POINTER_ESCAPE");
    const manifest = await read(dir, "manifest.json");
    if (
      manifest.version !== ptr.version ||
      manifest.input_hash !== input.input_hash ||
      manifest.format !== UNDERSTANDING_VERSION
    )
      fail("BASELINE_MANIFEST_INVALID");
    const requiredFiles = [
      "input-hashes.json",
      "plan.json",
      "source-refs.json",
      "repairs.json",
      "context.json",
      ...Object.keys(DOMAINS).map((d) => `topics/${d}.json`),
      "baseline.json",
      "report.md",
      "old-claim-review.json",
      "unresolved.json",
    ];
    if (digest(Object.keys(manifest.files ?? {}).sort()) !== digest(requiredFiles.sort()))
      fail("BASELINE_MANIFEST_FILES_INVALID");
    for (const [file, hash] of Object.entries(manifest.files))
      if (sha256(await readBytes(dir, file)) !== hash) fail("BASELINE_ARTIFACT_INTEGRITY");
    const rawBaseline = await read(dir, "baseline.json");
    if (digest(rawBaseline) !== ptr.version) fail("BASELINE_VERSION_INTEGRITY");
    const b = Baseline.parse(rawBaseline);
    if (
      b.topics.some((t) => t.recovery) &&
      digest(manifest.recovery_dependencies) !== digest(recoveryManifestDependencies(b.topics))
    )
      fail("RECOVERY_MANIFEST_DEPENDENCY_MISMATCH");
    if (
      b.input_hash !== input.input_hash ||
      b.model !== run.model ||
      b.prompt_hash !== digest(PROMPTS) ||
      b.source_version_directory !== input.source_version_directory ||
      digest(await read(dir, "input-hashes.json")) !== digest(input.artifacts)
    )
      fail("BASELINE_SOURCE_MISMATCH");
    if ((await read(dir, "plan.json")).topic !== null) fail("TOPIC_ONLY_IS_NOT_BASELINE");
    if (
      b.status !== manifest.status ||
      (name === "latest-ready.json" && b.status !== "ready_candidate")
    )
      fail("BASELINE_STATUS_MISMATCH");
    const publishedAtMs = (await stat(path.join(p.baselineDir, name))).mtimeMs;
    publicationTimes.set(path.join(p.baselineDir, name), publishedAtMs);
    pointers.push({ ptr, dir, b, publishedAtMs });
  }
  if (!pointers.length) fail("BASELINE_UNAVAILABLE");
  // Both pointers are validated; choose the latest publication, not a fixed status preference.
  const { ptr, dir, b } = latestPublication(pointers);
  const jobsRoot = path.join(p.baselineDir, "jobs");
  async function auditPayload(candidate: unknown, auditRaw: unknown) {
    const audit = UnderstandingAudit.parse(auditRaw);
    for (const used of b.jobs.filter((j) => j.stage === "audit" && j.status === "completed")) {
      const job = await read(jobsRoot, `${used.job}.json`);
      if (job.status !== "completed" || digest(job.result) !== digest(audit)) continue;
      const inputBytes = await readBytes(jobsRoot, job.input_file);
      const rawBytes = await readBytes(jobsRoot, job.raw_file);
      if (
        job.result_hash !== digest(audit) ||
        sha256(inputBytes) !== job.input_sha256 ||
        sha256(rawBytes) !== job.raw_sha256 ||
        digest(UnderstandingAudit.parse(JSON.parse(rawBytes.toString()))) !== digest(audit)
      )
        fail("AUDIT_ARTIFACT_INTEGRITY");
      const ji = JSON.parse(inputBytes.toString());
      const payload = ji.payload;
      const fingerprint = digest([
        input.input_hash,
        POLICY,
        PROMPTS.audit,
        b.model,
        "audit",
        payload,
      ]);
      if (
        ji.input_hash !== input.input_hash ||
        ji.policy !== POLICY ||
        ji.prompt !== PROMPTS.audit ||
        ji.model !== b.model ||
        ji.fingerprint !== fingerprint ||
        job.fingerprint !== fingerprint ||
        job.id !== `audit-${fingerprint.slice(0, 32)}` ||
        used.job !== job.id
      )
        fail("AUDIT_FINGERPRINT_INVALID");
      if (
        digest(payload.analysis_input) !== audit.input_hash ||
        payload.analysis_input_hash !== audit.input_hash ||
        digest(payload.candidate) !== digest(candidate)
      )
        fail("AUDIT_BASIS_MISMATCH");
      return { audit, payload };
    }
    fail("ACCEPTED_AUDIT_JOB_MISSING");
  }
  async function audited(
    candidate: unknown,
    auditRaw: unknown,
    assigned: Assigned[],
    selection: Selection,
    old = false,
  ) {
    const { audit, payload } = await auditPayload(candidate, auditRaw);
    if (
      !old &&
      digest(assignReport(UnderstandingReport.parse(candidate), digest(payload.analysis_input))) !==
        digest(assigned)
    )
      fail("AUDIT_ASSIGNED_BASIS_MISMATCH");
    if (
      digest(payload.assigned) !== digest(assigned) ||
      digest(payload.analysis_input.selection?.evidence) !== digest(selection.evidence)
    )
      fail("AUDIT_SELECTION_MISMATCH");
    validateAudit(
      audit,
      digest(payload.analysis_input),
      assigned,
      selection.evidence.map((e) => e.id),
      old ? OldClaimReview.parse(candidate) : undefined,
    );
  }
  // Reconstruct current qualification and exact originals instead of trusting source-refs.
  const repairs = await read(dir, "repairs.json");
  const overlays: Overlay[] = [];
  const allRequests = repairRequests(input);
  for (const batch of repairs.batches ?? []) {
    if (!batch.audit) {
      if (batch.overlays?.length) fail("UNAUDITED_OVERLAY");
      continue;
    }
    const requests = allRequests.filter((r) => batch.requests.includes(r.id));
    const candidate = UseRepairs.parse(batch.candidate);
    const proposed = resolveRepairs(input, requests, candidate);
    if (digest(proposed) !== digest(batch.overlays)) fail("REPAIR_OVERLAY_MISMATCH");
    const { audit, payload } = await auditPayload(batch.candidate, batch.audit);
    if (
      digest(payload.resolved_propositions) !== digest(proposed) ||
      digest(payload.analysis_input.requests?.map((r: { id: string }) => r.id)) !==
        digest(requests.map((r) => r.id))
    )
      fail("REPAIR_AUDIT_BASIS_MISMATCH");
    const assigned = candidate.repairs.flatMap((r, i) => [
      {
        id: `repair-${i + 1}-${digest(payload.analysis_input).slice(0, 16)}`,
        key: r.request_id,
        category: "repair_decision",
      },
      ...proposed
        .filter((o) => o.request_id === r.request_id)
        .map((o) => ({ id: o.id, key: o.id, category: "proposition" })),
    ]);
    if (digest(assigned) !== digest(payload.assigned)) fail("REPAIR_AUDIT_ASSIGNED_MISMATCH");
    validateAudit(audit, digest(payload.analysis_input), payload.assigned, [
      ...requests.flatMap((r) => r.rows.map((e) => e.id)),
      ...proposed.map((e) => e.id),
    ]);
    overlays.push(...proposed);
  }
  if (digest(overlays) !== digest(repairs.overlays)) fail("REPAIR_SET_MISMATCH");
  const current = new Map(facts(input, overlays).map((e) => [e.id, e]));
  // Reconstruction always starts from the original qualified facts, never another recovery.
  const originals = new Map(current);
  for (const t of b.topics) {
    if (!t.recovery) continue;
    const proof = t.recovery;
    await boundFailure(p.baselineDir, proof.plan, readBytes);
    const selection = await verifyRecoveryProof(
      proof,
      originals,
      input.input_hash,
      b.model,
      t.domain,
      auditPayload,
    );
    if (
      t.status !== "ready_candidate" ||
      digest(selection) !== digest(t.selection) ||
      digest(proof.candidate) !== digest(t.candidate) ||
      digest(proof.audit) !== digest(t.audit) ||
      digest(proof.assigned) !== digest(t.assigned)
    )
      fail("RECOVERY_READER_RECONSTRUCTION_MISMATCH");
    for (const overlay of proof.overlays) current.set(overlay.projected.id, overlay.projected);
  }
  function qualified(s: Selection) {
    if (
      !Array.isArray(s.evidence) ||
      new Set(s.evidence.map((e) => e.id)).size !== s.evidence.length
    )
      fail("SELECTION_INVALID");
    for (const e of s.evidence)
      if (digest(current.get(e.id)) !== digest(e)) fail("SOURCE_QUALIFICATION_CHANGED");
  }
  const accepted = new Map<string, AcceptedReport>();
  if (
    b.topics.length !== Object.keys(DOMAINS).length ||
    new Set(b.topics.map((t) => t.domain)).size !== b.topics.length
  )
    fail("TOPIC_SET_INVALID");
  for (const t of b.topics) {
    if (digest(Topic.parse(await read(dir, `topics/${t.domain}.json`))) !== digest(t))
      fail("TOPIC_ARTIFACT_MISMATCH");
    qualified(t.selection);
    if (t.status === "no_evidence" && t.selection.evidence.length)
      fail("TOPIC_PROCESSING_STATUS_INVALID");
    if (t.selection.domain !== t.domain) fail("TOPIC_SELECTION_DOMAIN_INVALID");
    if (
      digest([
        input.input_hash,
        POLICY,
        b.model,
        t.domain,
        t.selection,
        t.candidate,
        t.audit,
        t.status,
      ]) !== t.version
    )
      fail("TOPIC_VERSION_INVALID");
    if (t.status === "ready_candidate") {
      const report = UnderstandingReport.parse(t.candidate);
      validateReport(report, t.selection);
      await audited(report, t.audit, t.assigned, t.selection);
      accepted.set(t.domain, { version: t.version, report, selection: t.selection });
    }
  }
  if (b.overall) {
    qualified(b.overall_selection);
    const report = UnderstandingReport.parse(b.overall);
    validateReport(report, b.overall_selection);
    await audited(report, b.overall_audit, b.overall_assigned, b.overall_selection);
    accepted.set("overall", { version: ptr.version, report, selection: b.overall_selection });
  }
  const oldFile = await read(dir, "old-claim-review.json");
  let old: OldClaimReview | null = null;
  if (b.old_claim_review) {
    old = OldClaimReview.parse(b.old_claim_review);
    if (digest(old) !== digest(oldFile.candidate) || oldFile.status !== "ready_candidate")
      fail("OLD_REVIEW_MISMATCH");
    qualified(oldFile.selection);
    validateOld(old, input.old, oldFile.selection.evidence);
    await audited(
      old,
      oldFile.audit,
      input.old.map((o) => ({ id: o.id, key: o.id, category: "old_disposition" })),
      oldFile.selection,
      true,
    );
  }
  await input.fresh();
  return { input, version: ptr.version, baseline: b, accepted, old };
}
export type BaselineSnapshot = Awaited<ReturnType<typeof loadBaseline>>;
const snapshotCache = new VerifiedSnapshotCache<BaselineSnapshot>(2);
/** Reuse interpretation only: recheck current dependency bytes before each reuse. */
export async function readBaseline(p: PrivateUnderstandingPaths): Promise<BaselineSnapshot> {
  await validatePaths(p);
  const key = digest([p.repoRoot, p.batch, p.coverage, p.baselineDir, p.stateDir, POLICY, PROMPTS]);
  const snapshot = await snapshotCache.get(
    key,
    () => loadBaseline(p),
    (s) => s.input.fresh(),
  );
  const { fresh, ...sourceData } = snapshot.input;
  // Isolate callers so mutation cannot poison the accepted in-memory snapshot.
  const copy = structuredClone({ ...snapshot, input: sourceData });
  return { ...copy, input: { ...copy.input, fresh } };
}
