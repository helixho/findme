import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { UnderstandingReport } from "@findme/core";
import { loadInputs } from "./input.js";
import { digest, fail, inside, optionalJson, sha256 } from "./io.js";
import { type Job, jobRunner } from "./jobs.js";
import { validateReport } from "./policy.js";
import type { Domain, Selection } from "./prepare.js";
import { verifyProviderMigration } from "./provider-migration.js";

export const PRUNE_VERSION = "u2-audit-object-prune@1";
const ALLOWED: Partial<Record<Domain, Set<string>>> = {
  collaboration: new Set(["unsupported_delegation_limit"]),
  expression_design: new Set(["unsupported_revision_history"]),
  resources_tradeoffs: new Set(["source_modality_mismatch", "stance_mismatch"]),
};

export async function pruneRejectedCandidate(options: {
  out: string;
  batch: string;
  coverage: string;
  domain: Domain;
}) {
  const allowed = ALLOWED[options.domain];
  if (!allowed) fail("DETERMINISTIC_PRUNE_NOT_ALLOWED");
  const run = await optionalJson<any>(path.join(options.out, "run.json"));
  const progress = await optionalJson<{ max_calls: number }>(
    path.join(options.out, "progress.json"),
  );
  const usage = await optionalJson<{ attempts: unknown[] }>(path.join(options.out, "usage.json"));
  if (!run || !progress || !usage) fail("DETERMINISTIC_PRUNE_EXISTING_RUN_REQUIRED");
  if (!run.continuation_model) fail("DETERMINISTIC_PRUNE_CONTINUATION_REQUIRED");
  await verifyProviderMigration(options.out, run);
  const input = await loadInputs(options.batch, options.coverage);
  if (input.input_hash !== run.input_hash) fail("DETERMINISTIC_PRUNE_SOURCE_CHANGED");
  await input.fresh();

  const pointer = await optionalJson<any>(path.join(options.out, "latest-partial.json"));
  if (!pointer || pointer.input_hash !== run.input_hash)
    fail("DETERMINISTIC_PRUNE_BASELINE_REQUIRED");
  const baseline = JSON.parse(
    await readFile(
      await inside(options.out, path.join(pointer.directory, "baseline.json")),
      "utf8",
    ),
  );
  if (digest(baseline) !== pointer.version || baseline.input_hash !== run.input_hash)
    fail("DETERMINISTIC_PRUNE_BASELINE_CHANGED");
  const topic = baseline.topics.find((t: any) => t.domain === options.domain);
  if (!topic || topic.status !== "partial" || !topic.candidate || topic.audit)
    fail("DETERMINISTIC_PRUNE_TOPIC_NOT_ELIGIBLE");
  const selection = topic.selection as Selection;
  const matches: {
    job: string;
    job_hash: string;
    payload: any;
    issues: any[];
  }[] = [];
  const root = path.join(options.out, "jobs");
  for (const name of await readdir(root)) {
    if (!/^audit-[a-f0-9]{32}\.json$/.test(name)) continue;
    const bytes = await readFile(path.join(root, name));
    const job = JSON.parse(bytes.toString()) as Job<unknown>;
    if (job.status !== "failed" || !job.input_file || !job.result) continue;
    const audit = job.result as any;
    const issues = Array.isArray(audit.issues) ? audit.issues : [];
    if (
      !issues.length ||
      issues.some(
        (x: { code?: string; target_id?: string | null }) =>
          !x.code || !allowed.has(x.code) || !x.target_id,
      )
    )
      continue;
    const payload = JSON.parse(await readFile(await inside(root, job.input_file), "utf8")).payload;
    const domain = payload?.analysis_input?.selection?.domain;
    if (domain !== options.domain || digest(payload?.candidate) !== digest(topic.candidate))
      continue;
    if (digest(payload?.assigned) !== digest(topic.assigned))
      fail("DETERMINISTIC_PRUNE_ASSIGNED_CHANGED");
    matches.push({
      job: name.replace(/\.json$/, ""),
      job_hash: sha256(bytes),
      payload,
      issues,
    });
  }
  const [match] = matches;
  if (matches.length !== 1 || !match) fail("DETERMINISTIC_PRUNE_AUDIT_AMBIGUOUS");
  const assigned = new Map(match.payload.assigned.map((a: any) => [a.id, a]));
  const removed = match.issues.map((issue) => {
    const target = assigned.get(issue.target_id) as any;
    if (!target) fail("DETERMINISTIC_PRUNE_TARGET_MISSING");
    return { id: issue.target_id, key: target.key, category: target.category, code: issue.code };
  });
  const removedKeys = new Set(removed.map((x) => x.key));
  const removedNodes = new Set(removed.filter((x) => x.category === "node").map((x) => x.key));
  const candidate = structuredClone(topic.candidate);
  let currentRemoved = false;
  if (candidate.current_understanding && removedKeys.has(candidate.current_understanding.key)) {
    candidate.current_understanding = null;
    currentRemoved = true;
  }
  candidate.findings = candidate.findings.filter((x: any) => !removedKeys.has(x.key));
  candidate.resources_conditions_costs = candidate.resources_conditions_costs.filter(
    (x: any) => !removedKeys.has(x.key),
  );
  candidate.nodes = candidate.nodes.filter((x: any) => !removedKeys.has(x.key));
  candidate.links = candidate.links.filter(
    (x: any) => !removedKeys.has(x.key) && !removedNodes.has(x.from) && !removedNodes.has(x.to),
  );
  let promotedKey: string | undefined;
  if (currentRemoved && !candidate.current_understanding && candidate.findings.length) {
    const promoted = candidate.findings.shift();
    if (!promoted) fail("DETERMINISTIC_PRUNE_PROMOTION_MISSING");
    candidate.current_understanding = promoted;
    promotedKey = promoted.key;
  }
  const parsed = UnderstandingReport.parse(candidate);
  validateReport(parsed, selection);
  if (digest(parsed) === digest(topic.candidate)) fail("DETERMINISTIC_PRUNE_NO_CHANGE");

  const analysisInput = match.payload.analysis_input;
  if (analysisInput?.task !== "u2_domain_understanding")
    fail("DETERMINISTIC_PRUNE_ANALYSIS_INPUT_INVALID");
  const jobs = await jobRunner({
    out: options.out,
    inputHash: run.input_hash,
    model: run.model,
    continuationModel: run.continuation_model,
    live: false,
    maxCalls: progress.max_calls,
    fresh: input.fresh,
  });
  await jobs.seedDeterministic(
    "topic",
    analysisInput,
    UnderstandingReport,
    (report) => validateReport(report, selection),
    parsed,
    {
      version: PRUNE_VERSION,
      source_job: match.job,
      source_hash: match.job_hash,
      removed_targets: removed.map((x) => x.id),
      ...(promotedKey ? { promoted_key: promotedKey } : {}),
    },
  );
  await input.fresh();
  return {
    domain: options.domain,
    transform: PRUNE_VERSION,
    source_audit_job: match.job,
    removed: removed.map(({ id, key, category, code }) => ({ id, key, category, code })),
    promoted_key: promotedKey ?? null,
    candidate_hash_before: digest(topic.candidate),
    candidate_hash_after: digest(parsed),
    calls_total: usage.attempts.length,
    provider_calls_added: 0,
  };
}
