import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { createCodexGateway } from "../llm/codex-cli.js";
import type { createGateway } from "../llm/gateway.js";
import { loadInputs } from "./input.js";
import { atomic, digest, fail, inside, optionalJson, privateDirectory, sha256 } from "./io.js";
import { type Job, codexPatchCompatible, jobRunner } from "./jobs.js";
import {
  POLICY,
  PROMPTS,
  UnderstandingAudit,
  UnderstandingReport,
  assignReport,
  isReportTimeNormalizer,
  normalizeReportTimes,
  validateAudit,
  validateReport,
} from "./policy.js";
import { DOMAINS, type Fact, type Selection } from "./prepare.js";
import { verifyProviderMigration } from "./provider-migration.js";
import { recoveryPublication } from "./recovery-publication.js";
import {
  technicalRetryable,
  transportMigrationRetryable,
  unclassifiedTransportDiagnosticRetryable,
} from "./recovery-retry.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const JobId = z.string().regex(/^(topic|audit)-[a-f0-9]{32}$/);
export const RECOVERY_VERSION = "u2-reason-scoped-recovery@1";
export const OVERLAY_VERSION = "u2-proposition-qualification@1";
export const MAX_RECOVERY_CHAIN = 2;
export const QualificationProposal = z
  .object({
    base_fact_id: z.string().min(1),
    base_fact_hash: Hash,
    quote: z.string().min(1),
    proposition: z.string().min(1).max(3000),
    stance: z.enum(["endorsed", "not_endorsed", "opposed", "reported", "unknown"]),
    use: z.enum(["personal_expression", "project_report", "context"]),
    purpose: z.enum(["personal_expression", "project_report", "command_context", "context_only"]),
    rationale: z.string().min(20).max(3000),
  })
  .strict();
export const RecoveryPlan = z
  .object({
    format: z.literal(RECOVERY_VERSION),
    input_hash: Hash,
    model: z.string().min(1),
    domain: z.enum(
      Object.keys(DOMAINS).filter((d) => d !== "unresolved") as [
        "role_direction",
        ...(
          | "collaboration"
          | "judgment_learning"
          | "information_systems"
          | "expression_design"
          | "resources_tradeoffs"
          | "daily_conditions"
        )[],
      ],
    ),
    failed: z
      .object({
        job: JobId,
        fingerprint: Hash,
        job_sha256: Hash,
        input_sha256: Hash,
        raw_sha256: Hash,
        error: z.string().regex(/^[A-Z0-9_]+$/),
      })
      .strict(),
    error_class: z.enum([
      "constraint_semantic_drift",
      "revision_history_scope",
      "proposition_stance_mismatch",
      "non_time_label",
    ]),
    correction_instruction: z.string().min(30).max(5000),
    parent_plan_hash: Hash.optional(),
    proposals: z.array(QualificationProposal).max(4).default([]),
  })
  .strict();
export type RecoveryPlan = z.infer<typeof RecoveryPlan>;
export type QualificationProposal = z.infer<typeof QualificationProposal>;
export type OverlayProof = {
  version: typeof OVERLAY_VERSION;
  proposal: QualificationProposal;
  original: Fact;
  projected: Fact;
  analysis_input: Record<string, unknown>;
  assigned: { id: string; key: string; category: string }[];
  audit: z.infer<typeof UnderstandingAudit>;
};
export type RecoveryProof = {
  plan_hash: string;
  plan: RecoveryPlan;
  base_selection: Selection;
  overlays: OverlayProof[];
  report_payload: Record<string, unknown>;
  audit_payload: Record<string, unknown>;
  candidate: z.infer<typeof UnderstandingReport>;
  assigned: ReturnType<typeof assignReport>;
  audit: z.infer<typeof UnderstandingAudit>;
  runtime_model?: string;
};
export type Checkpoint = {
  plan: RecoveryPlan;
  plan_hash: string;
  base_selection: Selection;
  overlays?: OverlayProof[];
  status: "pending" | "failed" | "completed";
  failed_job?: string;
  proof?: RecoveryProof;
  runtime_model?: string;
  diagnostic_transport_retry_used?: boolean;
};
type Chain = {
  format: typeof RECOVERY_VERSION;
  input_hash: string;
  model: string;
  domain: string;
  plans: string[];
};
const chainFile = (out: string, inputHash: string, model: string, domain: string) =>
  path.join(out, "recovery", `chain-${digest([inputHash, model, domain])}.json`);
const checkpointFile = (out: string, hash: string) => path.join(out, "recovery", `${hash}.json`);

/** Only explicitly supplied, proposition-scoped changes. All source identity fields are inherited. */
export function projectQualification(original: Fact, raw: QualificationProposal): Fact {
  const p = QualificationProposal.parse(raw);
  if (
    original.id !== p.base_fact_id ||
    digest(original) !== p.base_fact_hash ||
    original.quote !== p.quote
  )
    fail("OVERLAY_ORIGINAL_MISMATCH");
  if (original.content_author !== "subject" || p.use !== original.use || original.use === "context")
    fail("OVERLAY_QUALIFICATION_ESCALATION");
  if (
    (p.use === "project_report" && (p.stance !== "reported" || p.purpose !== "project_report")) ||
    (p.use === "personal_expression" && p.purpose !== "personal_expression")
  )
    fail("OVERLAY_PURPOSE_MISMATCH");
  return {
    ...original,
    id: `qualification-${digest([OVERLAY_VERSION, original, p]).slice(0, 32)}`,
    proposition: p.proposition,
    stance: p.stance,
    purpose: p.purpose,
    provenance: `${OVERLAY_VERSION}:${original.id}:${digest(p)}`,
  };
}
export function qualificationAnalysis(
  selection: Selection,
  proposal: QualificationProposal,
  original: Fact,
) {
  return {
    task: "u2_proposition_qualification",
    protocol: OVERLAY_VERSION,
    domain: selection.domain,
    original,
    proposal,
    qualifier_role: "context_only",
    instruction:
      "Independently compare the supplied proposition, stance and purpose against the SAME exact original quote and its qualifier. Original source-level stance is not automatically proposition-level stance. Unknown must never be upgraded without explicit source support. Preserve author, object, actor, source time and source identity. Reject unsupported negation, purpose, event or actor inference. This supplied proposal has no inherited approval.",
  };
}
export function verifyOverlay(proof: OverlayProof, current: Map<string, Fact>, domain: string) {
  if (proof.version !== OVERLAY_VERSION) fail("OVERLAY_VERSION_INVALID");
  const original = current.get(proof.proposal.base_fact_id);
  if (!original || digest(original) !== digest(proof.original)) fail("OVERLAY_SOURCE_CHANGED");
  const projected = projectQualification(original, proof.proposal);
  const analysis = qualificationAnalysis({ domain } as Selection, proof.proposal, original);
  const assigned = [{ id: projected.id, key: projected.id, category: "proposition" }];
  if (
    digest(projected) !== digest(proof.projected) ||
    digest(analysis) !== digest(proof.analysis_input) ||
    digest(assigned) !== digest(proof.assigned)
  )
    fail("OVERLAY_RECONSTRUCTION_MISMATCH");
  validateAudit(UnderstandingAudit.parse(proof.audit), digest(analysis), assigned, [
    original.id,
    projected.id,
  ]);
  return projected;
}
export function recoverySelection(base: Selection, overlays: OverlayProof[]) {
  const current = new Map(base.evidence.map((e) => [e.id, e]));
  const added = overlays.map((p) => verifyOverlay(p, current, base.domain));
  if (
    new Set(added.map((e) => e.id)).size !== added.length ||
    new Set(overlays.map((p) => p.original.id)).size !== overlays.length
  )
    fail("DUPLICATE_RECOVERY_PROPOSAL");
  return overlays.length
    ? {
        ...base,
        evidence: [...base.evidence, ...added],
        bytes: Buffer.byteLength(JSON.stringify([...base.evidence, ...added])),
        recovery_dependencies: overlays.map((p) => ({
          version: p.version,
          overlay_id: p.projected.id,
          original_id: p.original.id,
          original_hash: digest(p.original),
          analysis_input_hash: digest(p.analysis_input),
          audit_result_hash: digest(p.audit),
        })),
      }
    : base;
}

export async function verifyRecoveryProof(
  proof: RecoveryProof,
  current: Map<string, Fact>,
  inputHash: string,
  model: string,
  domain: string,
  auditPayload: (
    candidate: unknown,
    audit: unknown,
  ) => Promise<{ payload: Record<string, unknown> }>,
) {
  const plan = RecoveryPlan.parse(proof.plan);
  if (
    digest(plan) !== proof.plan_hash ||
    plan.input_hash !== inputHash ||
    plan.model !== model ||
    plan.domain !== domain ||
    proof.base_selection.domain !== domain ||
    digest(proof.overlays.map((p) => p.proposal)) !== digest(plan.proposals)
  )
    fail("RECOVERY_READER_BINDING_MISMATCH");
  for (const e of proof.base_selection.evidence)
    if (digest(current.get(e.id)) !== digest(e)) fail("RECOVERY_SOURCE_CHANGED");
  for (const p of proof.overlays) {
    verifyOverlay(p, current, domain);
    const { payload } = await auditPayload(p.projected, p.audit);
    const expected = {
      task: "u2_recovery_proposition_audit",
      analysis_input: p.analysis_input,
      analysis_input_hash: digest(p.analysis_input),
      candidate: p.projected,
      assigned: p.assigned,
    };
    if (digest(payload) !== digest(expected)) fail("RECOVERY_OVERLAY_AUDIT_BINDING_MISMATCH");
  }
  const selection = recoverySelection(proof.base_selection, proof.overlays);
  if (
    digest(proof.report_payload.selection) !== digest(selectionForModel(selection)) ||
    proof.report_payload.recovery_plan_hash !== proof.plan_hash ||
    digest(proof.report_payload.recovery_failure) !== digest(plan.failed) ||
    proof.report_payload.correction_instruction !== plan.correction_instruction ||
    proof.report_payload.prior_candidate !== undefined ||
    proof.report_payload.prior_assigned !== undefined ||
    proof.report_payload.review_feedback_unverified !== undefined
  )
    fail("RECOVERY_REPORT_BINDING_MISMATCH");
  const candidate = UnderstandingReport.parse(proof.candidate);
  validateReport(candidate, selection);
  const assigned = assignReport(candidate, digest(proof.report_payload));
  const { payload } = await auditPayload(candidate, proof.audit);
  if (
    digest(payload) !== digest(proof.audit_payload) ||
    digest(payload.analysis_input) !== digest(proof.report_payload) ||
    digest(payload.candidate) !== digest(candidate) ||
    digest(payload.assigned) !== digest(assigned) ||
    digest(proof.assigned) !== digest(assigned)
  )
    fail("RECOVERY_REPORT_AUDIT_BINDING_MISMATCH");
  validateAudit(
    UnderstandingAudit.parse(proof.audit),
    digest(proof.report_payload),
    assigned,
    selection.evidence.map((e) => e.id),
  );
  return selection;
}
export function recoveryManifestDependencies(
  topics: { domain: string; recovery?: RecoveryProof }[],
) {
  return topics
    .filter((t) => t.recovery)
    .map((t) => ({
      domain: t.domain,
      plan_hash: required(t.recovery).plan_hash,
      ...(required(t.recovery).runtime_model
        ? { execution_model: required(t.recovery).runtime_model }
        : {}),
      overlays: required(t.recovery).overlays.map((p) => ({
        overlay_id: p.projected.id,
        original_hash: digest(p.original),
        analysis_input_hash: digest(p.analysis_input),
        audit_result_hash: digest(p.audit),
      })),
      report_audit_hash: digest(required(t.recovery).audit),
    }));
}
function recoveryJobModel(planModel: string, executionModel?: string) {
  return executionModel && !codexPatchCompatible(planModel, executionModel)
    ? executionModel
    : planModel;
}

async function cachedRecoveryJob(
  out: string,
  plan: RecoveryPlan,
  stage: "topic" | "audit",
  payload: Record<string, unknown>,
  executionModel?: string,
) {
  const jobModel = recoveryJobModel(plan.model, executionModel);
  const fingerprint = digest([plan.input_hash, POLICY, PROMPTS[stage], jobModel, stage, payload]);
  const id = `${stage}-${fingerprint.slice(0, 32)}`;
  const root = path.join(out, "jobs");
  const job = await optionalJson<Job<unknown>>(path.join(root, `${id}.json`));
  if (!job || job.status !== "completed") return undefined;
  if (
    job.id !== id ||
    job.fingerprint !== fingerprint ||
    !job.input_file ||
    !job.raw_file ||
    digest(job.result) !== job.result_hash
  )
    fail("RECOVERY_CHECKPOINT_JOB_MISSING");
  const inputBytes = await readFile(await inside(root, job.input_file));
  const raw = await readFile(await inside(root, job.raw_file));
  const input = JSON.parse(inputBytes.toString());
  if (
    sha256(inputBytes) !== job.input_sha256 ||
    sha256(raw) !== job.raw_sha256 ||
    input.fingerprint !== fingerprint ||
    input.input_hash !== plan.input_hash ||
    input.model !== jobModel ||
    (jobModel !== plan.model && input.lineage_model !== plan.model) ||
    input.policy !== POLICY ||
    input.prompt !== PROMPTS[stage] ||
    digest(input.payload) !== digest(payload)
  )
    fail("RECOVERY_CHECKPOINT_ARTIFACT_CHANGED");
  let result =
    stage === "audit"
      ? UnderstandingAudit.parse(JSON.parse(raw.toString()))
      : UnderstandingReport.parse(JSON.parse(raw.toString()));
  if (stage === "topic" && job.transform) {
    if (
      !isReportTimeNormalizer(job.transform.version) ||
      job.transform.raw_sha256 !== job.raw_sha256 ||
      job.transform.input_sha256 !== job.input_sha256 ||
      digest([job.transform, job.result]) !== job.projection_hash
    )
      fail("REPORT_PROJECTION_INTEGRITY");
    result = normalizeReportTimes(
      UnderstandingReport.parse(result),
      payload.selection as Selection,
      job.transform.version,
    );
  }
  if (digest(result) !== job.result_hash) fail("RECOVERY_CHECKPOINT_ARTIFACT_CHANGED");
  return job;
}
async function verifyCompletedCheckpoint(out: string, proof: RecoveryProof) {
  async function cached(stage: "topic" | "audit", payload: Record<string, unknown>) {
    const job = await cachedRecoveryJob(out, proof.plan, stage, payload, proof.runtime_model);
    if (!job) fail("RECOVERY_CHECKPOINT_JOB_MISSING");
    return job;
  }
  const current = new Map(proof.base_selection.evidence.map((e) => [e.id, e]));
  await verifyRecoveryProof(
    proof,
    current,
    proof.plan.input_hash,
    proof.plan.model,
    proof.plan.domain,
    async (candidate, audit) => {
      const overlay = proof.overlays.find((p) => digest(p.projected) === digest(candidate));
      const payload = overlay
        ? {
            task: "u2_recovery_proposition_audit",
            analysis_input: overlay.analysis_input,
            analysis_input_hash: digest(overlay.analysis_input),
            candidate: overlay.projected,
            assigned: overlay.assigned,
          }
        : proof.audit_payload;
      const job = await cached("audit", payload);
      if (digest(job.result) !== digest(audit)) fail("RECOVERY_CHECKPOINT_ARTIFACT_CHANGED");
      return { payload };
    },
  );
  const report = await cached("topic", proof.report_payload);
  if (digest(report.result) !== digest(proof.candidate))
    fail("RECOVERY_CHECKPOINT_ARTIFACT_CHANGED");
}

/** Exact bytes and semantic identity, including failed audit inputs, checked before any mutation. */
export async function boundFailure(
  out: string,
  plan: RecoveryPlan,
  readBytes: (root: string, file: string) => Promise<Buffer> = async (root, file) =>
    readFile(await inside(root, file)),
) {
  const root = path.join(out, "jobs");
  const bytes = await readBytes(root, `${plan.failed.job}.json`);
  const job = JSON.parse(bytes.toString()) as Job<unknown>;
  if (job.status !== "failed") fail("RECOVERY_REQUIRES_FAILED_JOB");
  if (
    sha256(bytes) !== plan.failed.job_sha256 ||
    job.id !== plan.failed.job ||
    job.fingerprint !== plan.failed.fingerprint ||
    job.error !== plan.failed.error
  )
    fail("RECOVERY_FAILURE_CHANGED");
  if (!job.input_file || !job.raw_file) fail("RECOVERY_FAILURE_ARTIFACT_MISSING");
  const inputBytes = await readBytes(root, job.input_file);
  const raw = await readBytes(root, job.raw_file);
  if (
    sha256(inputBytes) !== plan.failed.input_sha256 ||
    sha256(raw) !== plan.failed.raw_sha256 ||
    job.input_sha256 !== plan.failed.input_sha256 ||
    job.raw_sha256 !== plan.failed.raw_sha256
  )
    fail("RECOVERY_FAILURE_ARTIFACT_CHANGED");
  const input = JSON.parse(inputBytes.toString());
  const stage = job.id.startsWith("audit-") ? "audit" : "topic";
  const fingerprint = digest([
    plan.input_hash,
    POLICY,
    PROMPTS[stage],
    plan.model,
    stage,
    input.payload,
  ]);
  const analysis = stage === "audit" ? input.payload.analysis_input : input.payload;
  const qualification = stage === "audit" && input.payload.task === "u2_recovery_proposition_audit";
  if (
    input.input_hash !== plan.input_hash ||
    input.model !== plan.model ||
    input.policy !== POLICY ||
    input.prompt !== PROMPTS[stage] ||
    input.fingerprint !== fingerprint ||
    job.fingerprint !== fingerprint ||
    job.id !== `${stage}-${fingerprint.slice(0, 32)}` ||
    (qualification ? analysis?.domain : analysis?.selection?.domain) !== plan.domain ||
    (stage === "audit" &&
      !["u2_domain_audit", "u2_recovery_proposition_audit"].includes(input.payload.task))
  )
    fail("RECOVERY_INPUT_BINDING_MISMATCH");
  const expected =
    plan.error_class === "proposition_stance_mismatch"
      ? [
          "STANCE_ESCALATION",
          "SEMANTIC_AUDIT_REJECTED",
          "INCOMPLETE_SAME_INPUT_AUDIT",
          "UNKNOWN_AUDIT_REFERENCE",
        ]
      : plan.error_class === "non_time_label"
        ? ["TIME_SCOPE_MISMATCH", "RELATION_TIME_MISMATCH"]
        : ["SEMANTIC_AUDIT_REJECTED", "INCOMPLETE_SAME_INPUT_AUDIT", "UNKNOWN_AUDIT_REFERENCE"];
  if (
    !expected.includes(plan.failed.error) ||
    (plan.error_class === "proposition_stance_mismatch") !== Boolean(plan.proposals.length)
  )
    fail("RECOVERY_REASON_MISMATCH");
  return { job, input, analysis };
}
async function verifyRecoveryChain(
  out: string,
  chain: Chain | undefined,
  plan: RecoveryPlan,
  planHash: string,
  prior: Checkpoint | undefined,
) {
  if (chain) {
    if (
      chain.format !== RECOVERY_VERSION ||
      chain.input_hash !== plan.input_hash ||
      chain.model !== plan.model ||
      chain.domain !== plan.domain ||
      new Set(chain.plans).size !== chain.plans.length ||
      chain.plans.length > MAX_RECOVERY_CHAIN
    )
      fail("RECOVERY_CHAIN_INTEGRITY");
    if (!chain.plans.includes(planHash)) {
      const lastHash = required(chain.plans.at(-1));
      const last = await optionalJson<Checkpoint>(checkpointFile(out, lastHash));
      if (chain.plans.length >= MAX_RECOVERY_CHAIN) fail("RECOVERY_CHAIN_EXHAUSTED");
      if (
        !last ||
        last.status !== "failed" ||
        plan.parent_plan_hash !== lastHash ||
        last.failed_job !== plan.failed.job ||
        digest(last.plan) !== lastHash
      )
        fail("RECOVERY_NEW_DIAGNOSED_FAILURE_REQUIRED");
    } else if (!prior || digest(prior.plan) !== planHash) fail("RECOVERY_CHECKPOINT_INTEGRITY");
  } else if (plan.parent_plan_hash) fail("RECOVERY_PARENT_MISSING");
}

function verifyRecoveryPlanSelection(
  baseline: {
    topics: { domain: string; status: string; selection: Selection; recovery?: RecoveryProof }[];
  },
  plan: RecoveryPlan,
  prior: Checkpoint | undefined,
  failure: Awaited<ReturnType<typeof boundFailure>>,
) {
  const topic = baseline.topics.find((t: { domain: string }) => t.domain === plan.domain);
  if (
    !topic ||
    topic.status === "ready_candidate" ||
    topic.status === "no_evidence" ||
    !topic.selection.evidence.length
  )
    fail("RECOVERY_DOMAIN_NOT_FAILED");
  const baseSelection = prior?.base_selection ?? topic.recovery?.base_selection ?? topic.selection;
  if (new Set(plan.proposals.map((p) => p.base_fact_id)).size !== plan.proposals.length)
    fail("DUPLICATE_RECOVERY_PROPOSAL");
  if (
    !plan.parent_plan_hash &&
    digest(failure.analysis.selection?.evidence) !== digest(baseSelection.evidence)
  )
    fail("RECOVERY_SELECTION_CHANGED");
  for (const p of plan.proposals) {
    const original = baseSelection.evidence.find((e: Fact) => e.id === p.base_fact_id);
    if (!original) fail("OVERLAY_ORIGINAL_MISSING");
    projectQualification(original, p);
  }
  return baseSelection;
}

export async function recoveryPreflight(
  out: string,
  rawPlan?: unknown,
  domains?: string[],
  requestedBudget?: number,
  source?: { batch: string; coverage: string },
  runtimeModel?: string,
) {
  const run = await optionalJson<{
    input_hash: string;
    model: string;
    continuation_model?: string;
    provider_migration_hash?: string;
    batch?: string;
    coverage?: string;
  }>(path.join(out, "run.json"));
  const usage = await optionalJson<{
    attempts: { job: string; status: string }[];
    integrity: string;
  }>(path.join(out, "usage.json"));
  const progress = await optionalJson<{ max_calls: number }>(path.join(out, "progress.json"));
  if (!run || !usage || !progress) fail("RECOVERY_EXISTING_LEDGER_REQUIRED");
  if (run.continuation_model) await verifyProviderMigration(out, run);
  if (digest(usage.attempts) !== usage.integrity) fail("USAGE_INTEGRITY");
  if (
    new Set(usage.attempts.map((a: unknown) => (a as { id: string }).id)).size !==
    usage.attempts.length
  )
    fail("DUPLICATE_ATTEMPT");
  if (
    !Number.isSafeInteger(progress.max_calls) ||
    progress.max_calls < 0 ||
    progress.max_calls > 71
  )
    fail("RECOVERY_CURRENT_CAP_INVALID");
  let sourceHashVerification = "not_requested";
  if (source) {
    if (run.batch !== source.batch || run.coverage !== source.coverage)
      fail("RECOVERY_SOURCE_PATH_MISMATCH");
    const current = await loadInputs(source.batch, source.coverage);
    if (current.input_hash !== run.input_hash) fail("RECOVERY_SOURCE_CHANGED");
    await current.fresh();
    sourceHashVerification = "verified_current_source_and_u1_bytes";
  }
  const { pointer, baseline } = await recoveryPublication(out, run);
  const selected = domains ?? Object.keys(DOMAINS).filter((d) => d !== "unresolved");
  if (selected.some((d) => !(d in DOMAINS))) fail("UNKNOWN_TOPIC");
  if (
    requestedBudget !== undefined &&
    (!Number.isSafeInteger(requestedBudget) || requestedBudget < 0 || requestedBudget > 71)
  )
    fail("MAX_CALLS_0_TO_71_REQUIRED");
  let plan: RecoveryPlan | undefined;
  let remainingStages: string[] = [];
  let planHash: string | undefined;
  let resumable = false;
  let haltedFailureJob: string | undefined;
  if (rawPlan) {
    plan = RecoveryPlan.parse(rawPlan);
    planHash = digest(plan);
    if (
      plan.input_hash !== run.input_hash ||
      plan.model !== run.model ||
      !selected.includes(plan.domain)
    )
      fail("RECOVERY_RUN_BINDING_MISMATCH");
    const semanticModel = run.continuation_model ?? plan.model;
    if (
      runtimeModel &&
      runtimeModel !== semanticModel &&
      !codexPatchCompatible(semanticModel, runtimeModel)
    )
      fail("RECOVERY_MODEL_CHANGED");
    const failure = await boundFailure(out, plan);
    const chain = await optionalJson<Chain>(
      chainFile(out, plan.input_hash, plan.model, plan.domain),
    );
    const prior = await optionalJson<Checkpoint>(checkpointFile(out, planHash));
    const technicalRetry = await technicalRetryable(out, prior);
    const diagnosticRetry = await unclassifiedTransportDiagnosticRetryable(out, prior);
    const providerContinuation = Boolean(
      run.continuation_model && run.continuation_model !== plan.model,
    );
    const migrationRetry =
      Boolean(
        runtimeModel &&
          runtimeModel !== semanticModel &&
          codexPatchCompatible(semanticModel, runtimeModel),
      ) && (await transportMigrationRetryable(out, prior, runtimeModel));
    resumable =
      prior?.status === "pending" ||
      technicalRetry ||
      diagnosticRetry ||
      migrationRetry ||
      providerContinuation;
    await verifyRecoveryChain(out, chain, plan, planHash, prior);
    const baseSelection = verifyRecoveryPlanSelection(baseline, plan, prior, failure);
    if (prior?.status === "completed") {
      if (
        !prior.proof ||
        digest(prior.proof.plan) !== planHash ||
        prior.proof.plan_hash !== planHash
      )
        fail("RECOVERY_CHECKPOINT_INTEGRITY");
      await verifyCompletedCheckpoint(out, prior.proof);
    }
    if (
      prior?.status !== "completed" &&
      (prior?.status !== "failed" ||
        technicalRetry ||
        diagnosticRetry ||
        migrationRetry ||
        providerContinuation)
    ) {
      const stages = await remainingRecoveryStages(
        out,
        plan,
        baseSelection,
        failure.analysis,
        run.continuation_model,
      );
      remainingStages = stages.remaining;
      haltedFailureJob = stages.failedJob;
      if (
        (technicalRetry || diagnosticRetry || migrationRetry || providerContinuation) &&
        remainingStages.length === 0 &&
        prior?.failed_job
      ) {
        remainingStages = prior.failed_job.startsWith("topic-")
          ? ["topic_generation", "topic_audit"]
          : ["topic_audit"];
      }
    }
  } else {
    remainingStages = baseline.topics
      .filter(
        (t: { domain: string; status: string }) =>
          selected.includes(t.domain) &&
          t.domain !== "unresolved" &&
          !["ready_candidate", "no_evidence", "context_required"].includes(t.status),
      )
      .flatMap((t: { domain: string }) => [
        `${t.domain}:topic_generation`,
        `${t.domain}:topic_audit`,
      ]);
    if (!baseline.overall_audit)
      remainingStages.push("overall_generation:topics_gate", "overall_audit:topics_gate");
    if (!baseline.old_claim_review) remainingStages.push("old_review", "old_audit");
  }
  const cap = requestedBudget ?? progress.max_calls;
  const remainingBudget = Math.max(0, cap - usage.attempts.length);
  return {
    run,
    baseline_version: pointer.version,
    status: baseline.status,
    calls_total: usage.attempts.length,
    current_cap: progress.max_calls,
    requested_budget: requestedBudget ?? null,
    remaining_current_budget: Math.max(0, progress.max_calls - usage.attempts.length),
    remaining_requested_budget: remainingBudget,
    selected_domains: selected,
    domains: baseline.topics
      .filter((t: { domain: string; status: string }) => selected.includes(t.domain))
      .map((t: { domain: string; status: string }) => ({ domain: t.domain, status: t.status })),
    plan,
    plan_hash: planHash,
    remaining_stages: remainingStages,
    stage_estimate: plan
      ? "bounded_plan"
      : "minimum_excluding_unsupplied_overlay_audits_and_future_failures",
    required_calls: remainingStages.length,
    executable:
      Boolean(plan) &&
      (remainingStages.length > 0 || resumable) &&
      remainingBudget >= remainingStages.length,
    budget_blocked: remainingStages.length > remainingBudget,
    halted_failure_job: haltedFailureJob ?? null,
    source_hash_verification: sourceHashVerification,
    token_cost_prediction: null,
  };
}

/** Targeted execution writes checkpoints/jobs only. Publication remains the original full runner's job. */
export async function executeRecovery(options: {
  out: string;
  plan: unknown;
  requestedBudget: number;
  maxCallsThisRun?: number;
  live?: boolean;
  gateway?: ReturnType<typeof createCodexGateway> | ReturnType<typeof createGateway>;
  baseSelection: Selection;
  fresh: () => Promise<void>;
}) {
  const runtimeModel = options.gateway?.describe("extraction_model").model;
  const preflight = await recoveryPreflight(
    options.out,
    options.plan,
    [RecoveryPlan.parse(options.plan).domain],
    options.requestedBudget,
    undefined,
    runtimeModel,
  );
  const plan = required(preflight.plan);
  const hash = required(preflight.plan_hash);
  const semanticModel = preflight.run.continuation_model ?? plan.model;
  await options.fresh();
  const bound = await boundFailure(options.out, plan);
  if (
    runtimeModel &&
    runtimeModel !== semanticModel &&
    !codexPatchCompatible(semanticModel, runtimeModel)
  )
    fail("RECOVERY_MODEL_CHANGED");
  const existing = await optionalJson<Checkpoint>(checkpointFile(options.out, hash));
  if (existing && digest(existing.base_selection) !== digest(options.baseSelection))
    fail("RECOVERY_REPLAY_SOURCE_CHANGED");
  if (existing?.status === "completed")
    return { status: existing.status, calls_this_run: 0, proof: existing.proof ?? null };
  const technicalRetry = await technicalRetryable(options.out, existing);
  const diagnosticRetry = await unclassifiedTransportDiagnosticRetryable(options.out, existing);
  const providerContinuation = semanticModel !== plan.model;
  const migrationRetry =
    Boolean(
      runtimeModel &&
        runtimeModel !== semanticModel &&
        codexPatchCompatible(semanticModel, runtimeModel),
    ) && (await transportMigrationRetryable(options.out, existing, runtimeModel));
  if (
    existing?.status === "failed" &&
    !technicalRetry &&
    !diagnosticRetry &&
    !migrationRetry &&
    !providerContinuation
  )
    return { status: existing.status, calls_this_run: 0, proof: existing.proof ?? null };
  if (!options.live || !options.gateway || !preflight.executable)
    return { status: "not_executed", calls_this_run: 0, preflight };
  const base = options.baseSelection;
  if (base.domain !== plan.domain) fail("RECOVERY_QUALIFIED_SELECTION_MISMATCH");
  if (plan.parent_plan_hash) {
    const parent = await optionalJson<Checkpoint>(
      checkpointFile(options.out, plan.parent_plan_hash),
    );
    if (
      !parent ||
      digest(parent.plan) !== plan.parent_plan_hash ||
      digest(parent.base_selection) !== digest(base)
    )
      fail("RECOVERY_PARENT_SOURCE_CHANGED");
    const previous = recoverySelection(base, parent.overlays ?? []);
    if (bound.analysis.task === "u2_proposition_qualification") {
      if (
        digest(base.evidence.find((e) => e.id === bound.analysis.original?.id)) !==
        digest(bound.analysis.original)
      )
        fail("RECOVERY_QUALIFIED_SELECTION_MISMATCH");
    } else if (digest(previous.evidence) !== digest(bound.analysis.selection?.evidence))
      fail("RECOVERY_QUALIFIED_SELECTION_MISMATCH");
  } else if (digest(base.evidence) !== digest(bound.analysis.selection.evidence))
    fail("RECOVERY_QUALIFIED_SELECTION_MISMATCH");
  await privateDirectory(path.join(options.out, "recovery"));
  const chainPath = chainFile(options.out, plan.input_hash, plan.model, plan.domain);
  const chain = (await optionalJson<Chain>(chainPath)) ?? {
    format: RECOVERY_VERSION,
    input_hash: plan.input_hash,
    model: plan.model,
    domain: plan.domain,
    plans: [],
  };
  if (!chain.plans.includes(hash)) {
    chain.plans.push(hash);
    await atomic(chainPath, chain);
  }
  const checkpoint: Checkpoint = {
    plan,
    plan_hash: hash,
    base_selection: base,
    status: "pending",
    ...(runtimeModel && runtimeModel !== plan.model ? { runtime_model: runtimeModel } : {}),
    ...(existing?.diagnostic_transport_retry_used || diagnosticRetry
      ? { diagnostic_transport_retry_used: true }
      : {}),
  };
  await atomic(checkpointFile(options.out, hash), checkpoint);
  const jobs = await jobRunner({
    out: options.out,
    inputHash: plan.input_hash,
    model: plan.model,
    continuationModel: providerContinuation ? semanticModel : undefined,
    runtimeModel:
      runtimeModel &&
      runtimeModel !== semanticModel &&
      codexPatchCompatible(semanticModel, runtimeModel)
        ? runtimeModel
        : undefined,
    live: true,
    retryFailed: true,
    technicalRetryJob:
      existing?.status === "failed" &&
      (technicalRetry || diagnosticRetry || migrationRetry || providerContinuation)
        ? existing.failed_job
        : undefined,
    gateway: options.gateway,
    maxCalls: options.requestedBudget,
    maxCallsThisRun: options.maxCallsThisRun,
    fresh: options.fresh,
  });
  const proofs: OverlayProof[] = [];
  for (const proposal of plan.proposals) {
    const original = base.evidence.find((e) => e.id === proposal.base_fact_id);
    if (!original) fail("OVERLAY_ORIGINAL_MISSING");
    const projected = projectQualification(original, proposal);
    const analysis = qualificationAnalysis(base, proposal, original);
    const assigned = [{ id: projected.id, key: projected.id, category: "proposition" }];
    const payload = {
      task: "u2_recovery_proposition_audit",
      analysis_input: analysis,
      analysis_input_hash: digest(analysis),
      candidate: projected,
      assigned,
    };
    const audit = await jobs.job(
      "audit",
      payload,
      UnderstandingAudit,
      (a) => validateAudit(a, digest(analysis), assigned, [original.id, projected.id]),
      { once: true },
    );
    if (!audit) break;
    proofs.push({
      version: OVERLAY_VERSION,
      proposal,
      original,
      projected,
      analysis_input: analysis,
      assigned,
      audit,
    });
  }
  let proof: RecoveryProof | undefined;
  if (proofs.length === plan.proposals.length) {
    const selection = recoverySelection(base, proofs);
    // History never enters the current independent audit. Exact failure binding is metadata, not evidence.
    const reportPayload = recoveryReportPayload(plan, selection, bound.analysis);
    const candidate = await jobs.job(
      "topic",
      reportPayload,
      UnderstandingReport,
      (r) => validateReport(r, selection),
      { once: true },
    );
    if (candidate) {
      const assigned = assignReport(candidate, digest(reportPayload));
      const auditPayload = recoveryAuditPayload(
        reportPayload,
        candidate,
        assigned,
        jobs.provenance("topic", reportPayload),
      );
      const audit = await jobs.job(
        "audit",
        auditPayload,
        UnderstandingAudit,
        (a) =>
          validateAudit(
            a,
            digest(reportPayload),
            assigned,
            selection.evidence.map((e) => e.id),
          ),
        { once: true },
      );
      if (audit)
        proof = {
          plan_hash: hash,
          plan,
          base_selection: base,
          overlays: proofs,
          report_payload: reportPayload,
          audit_payload: auditPayload,
          candidate,
          assigned,
          audit,
          ...(runtimeModel && runtimeModel !== plan.model ? { runtime_model: runtimeModel } : {}),
        };
    }
  }
  checkpoint.status = proof
    ? "completed"
    : jobs.pending.some((p) => p.reason === "cumulative_call_budget_exhausted")
      ? "pending"
      : "failed";
  checkpoint.overlays = proofs;
  checkpoint.failed_job =
    [...jobs.usedJobs].reverse().find((j) => j.status === "failed")?.job ??
    jobs.failedJobs().at(-1)?.job;
  checkpoint.proof = proof;
  await atomic(checkpointFile(options.out, hash), checkpoint);
  return { status: checkpoint.status, calls_this_run: jobs.callsThisRun, proof: proof ?? null };
}
function selectionForModel(selection: Selection) {
  const { omitted, ...rest } = selection;
  return {
    ...rest,
    omitted_count: omitted.length,
    omission_reasons: [...new Set(omitted.map((o) => o.reason))],
  };
}
function recoveryReportPayload(
  plan: RecoveryPlan,
  selection: Selection,
  analysis: Record<string, unknown>,
) {
  // Carry structural navigation, never rejected model contents or processing-history commentary.
  const originalPayload = {
    task: "u2_domain_understanding",
    ...(analysis.topics ? { topics: analysis.topics } : {}),
    ...(analysis.semantic_scope ? { semantic_scope: analysis.semantic_scope } : {}),
  };
  return {
    ...originalPayload,
    selection: selectionForModel(selection),
    report_revision: RECOVERY_VERSION,
    recovery_plan_hash: digest(plan),
    recovery_failure: plan.failed,
    correction_instruction: plan.correction_instruction,
    correction_scope:
      "Use ONLY qualified originals and independently reviewed proposition overlays. The diagnosed error and prior failure are fallible hints, never evidence. Preserve scoped negation, investment conditions, actors and source time. Remove processing-history commentary from personal findings; do not infer success from history.",
  };
}
function recoveryAuditPayload(
  reportPayload: Record<string, unknown>,
  candidate: z.infer<typeof UnderstandingReport>,
  assigned: ReturnType<typeof assignReport>,
  provenance: unknown,
) {
  return {
    task: "u2_domain_audit",
    analysis_input: reportPayload,
    analysis_input_hash: digest(reportPayload),
    candidate,
    assigned,
    candidate_provenance: provenance,
    audited_assertion_scope:
      "Independently audit ALL assigned current objects against SAME selected originals/qualifiers and audited overlay dependencies. Recovery failure/correction instructions are not evidence. Reject unsupported conditions, actors, dates, stance or claims; no prior pass is inherited.",
  };
}
async function remainingRecoveryStages(
  out: string,
  plan: RecoveryPlan,
  base: Selection,
  analysis: Record<string, unknown>,
  executionModel?: string,
) {
  const stages: string[] = [];
  const proofs: OverlayProof[] = [];
  for (const [i, proposal] of plan.proposals.entries()) {
    const original = required(base.evidence.find((e) => e.id === proposal.base_fact_id));
    const projected = projectQualification(original, proposal);
    const input = qualificationAnalysis(base, proposal, original);
    const assigned = [{ id: projected.id, key: projected.id, category: "proposition" }];
    const payload = {
      task: "u2_recovery_proposition_audit",
      analysis_input: input,
      analysis_input_hash: digest(input),
      candidate: projected,
      assigned,
    };
    const failedJob = await recoveryStageFailure(out, plan, "audit", payload, executionModel);
    if (failedJob) return { remaining: [], failedJob };
    const cached = await cachedRecoveryJob(out, plan, "audit", payload, executionModel);
    if (!cached) {
      stages.push(`overlay_audit:${i}`);
      continue;
    }
    const audit = UnderstandingAudit.parse(cached.result);
    validateAudit(audit, digest(input), assigned, [original.id, projected.id]);
    proofs.push({
      version: OVERLAY_VERSION,
      proposal,
      original,
      projected,
      analysis_input: input,
      assigned,
      audit,
    });
  }
  if (proofs.length !== plan.proposals.length)
    return { remaining: [...stages, "topic_generation", "topic_audit"] };
  const selection = recoverySelection(base, proofs);
  const payload = recoveryReportPayload(plan, selection, analysis);
  const cached = await cachedRecoveryJob(out, plan, "topic", payload, executionModel);
  const failedTopic = await recoveryStageFailure(out, plan, "topic", payload, executionModel);
  if (failedTopic) return { remaining: [], failedJob: failedTopic };
  if (!cached) return { remaining: ["topic_generation", "topic_audit"] };
  const candidate = UnderstandingReport.parse(cached.result);
  validateReport(candidate, selection);
  const assigned = assignReport(candidate, digest(payload));
  const auditPayload = recoveryAuditPayload(
    payload,
    candidate,
    assigned,
    cached.transform
      ? { transform: cached.transform, projection_hash: cached.projection_hash }
      : undefined,
  );
  const audited = await cachedRecoveryJob(out, plan, "audit", auditPayload, executionModel);
  const failedAudit = await recoveryStageFailure(out, plan, "audit", auditPayload, executionModel);
  if (failedAudit) return { remaining: [], failedJob: failedAudit };
  if (!audited) return { remaining: ["topic_audit"] };
  validateAudit(
    UnderstandingAudit.parse(audited.result),
    digest(payload),
    assigned,
    selection.evidence.map((e) => e.id),
  );
  return { remaining: [] };
}
async function recoveryStageFailure(
  out: string,
  plan: RecoveryPlan,
  stage: "topic" | "audit",
  payload: Record<string, unknown>,
  executionModel?: string,
) {
  const jobModel = recoveryJobModel(plan.model, executionModel);
  const fingerprint = digest([plan.input_hash, POLICY, PROMPTS[stage], jobModel, stage, payload]);
  const id = `${stage}-${fingerprint.slice(0, 32)}`;
  const job = await optionalJson<Job<unknown>>(path.join(out, "jobs", `${id}.json`));
  if (job && (job.fingerprint !== fingerprint || job.id !== id))
    fail("RECOVERY_STAGE_FINGERPRINT_MISMATCH");
  return job?.status === "failed" ? job.id : undefined;
}

/** Load successful recovery without granting another attempt; validate via ordinary cached jobs. */
export async function replayRecovery(
  out: string,
  inputHash: string,
  model: string,
  base: Selection,
  jobs: Awaited<ReturnType<typeof jobRunner>>,
) {
  const chain = await optionalJson<Chain>(chainFile(out, inputHash, model, base.domain));
  if (!chain) return undefined;
  if (
    chain.format !== RECOVERY_VERSION ||
    chain.input_hash !== inputHash ||
    chain.model !== model ||
    chain.domain !== base.domain ||
    chain.plans.length > MAX_RECOVERY_CHAIN ||
    new Set(chain.plans).size !== chain.plans.length
  )
    fail("RECOVERY_CHAIN_INTEGRITY");
  for (const hash of [...chain.plans].reverse()) {
    const checkpoint = await optionalJson<Checkpoint>(checkpointFile(out, hash));
    if (!checkpoint || digest(checkpoint.plan) !== hash || checkpoint.plan_hash !== hash)
      fail("RECOVERY_CHECKPOINT_INTEGRITY");
    if (checkpoint.status !== "completed") continue;
    const proof = checkpoint.proof;
    if (
      !proof ||
      proof.plan_hash !== hash ||
      digest(proof.plan) !== hash ||
      proof.plan.input_hash !== inputHash ||
      proof.plan.model !== model ||
      proof.plan.domain !== base.domain ||
      digest(proof.base_selection) !== digest(base) ||
      digest(proof.overlays.map((p) => p.proposal)) !== digest(proof.plan.proposals)
    )
      fail("RECOVERY_REPLAY_SOURCE_CHANGED");
    await boundFailure(out, proof.plan);
    await verifyCompletedCheckpoint(out, proof);
    const selection = recoverySelection(base, proof.overlays);
    for (const p of proof.overlays) {
      const payload = {
        task: "u2_recovery_proposition_audit",
        analysis_input: p.analysis_input,
        analysis_input_hash: digest(p.analysis_input),
        candidate: p.projected,
        assigned: p.assigned,
      };
      const audit = await jobs.job(
        "audit",
        payload,
        UnderstandingAudit,
        (a) =>
          validateAudit(a, digest(p.analysis_input), p.assigned, [p.original.id, p.projected.id]),
        { cacheOnly: true, once: true },
      );
      if (!audit || digest(audit) !== digest(p.audit)) fail("RECOVERY_OVERLAY_AUDIT_MISSING");
    }
    if (
      digest((proof.report_payload.selection as Selection).evidence) !==
        digest(selection.evidence) ||
      digest(assignReport(proof.candidate, digest(proof.report_payload))) !== digest(proof.assigned)
    )
      fail("RECOVERY_REPORT_BINDING_MISMATCH");
    const candidate = await jobs.job(
      "topic",
      proof.report_payload,
      UnderstandingReport,
      (r) => validateReport(r, selection),
      { cacheOnly: true, once: true },
    );
    const audit = await jobs.job(
      "audit",
      proof.audit_payload,
      UnderstandingAudit,
      (a) =>
        validateAudit(
          a,
          digest(proof.report_payload),
          proof.assigned,
          selection.evidence.map((e) => e.id),
        ),
      { cacheOnly: true, once: true },
    );
    if (
      !candidate ||
      !audit ||
      digest(candidate) !== digest(proof.candidate) ||
      digest(audit) !== digest(proof.audit)
    )
      fail("RECOVERY_CHECKPOINT_JOB_MISSING");
    return { proof, selection, candidate, assigned: proof.assigned, audit };
  }
  return undefined;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) fail("RECOVERY_REFERENCE_MISSING");
  return value;
}
