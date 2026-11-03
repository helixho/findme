import { randomUUID } from "node:crypto";
import {
  UnderstandingAudit,
  type UnderstandingFeedbackReceipt,
  type UnderstandingOverallRequest,
  type UnderstandingRecoveryRequest,
  UnderstandingReport,
} from "@findme/core";
import {
  PROMPTS,
  assignReport,
  validateAudit,
  validateReport,
} from "../domain/understanding/policy.js";
import type { Selection } from "../domain/understanding/types.js";
import { digest, fail } from "../shared/primitives.js";
import { providerAttempt } from "./attempts.js";
import { dependencyMap, overallBlock, overallSelection, relevantFeedback } from "./dependencies.js";
import { UnderstandingQualification } from "./qualification-schema.js";
import {
  QUALIFICATION_AUDIT_PROMPT,
  QUALIFICATION_PROMPT,
  type QualificationCheckpoint,
  qualificationAssigned,
  qualificationFacts,
  qualifiedDependencies,
} from "./qualification.js";
import { type BaselineSnapshot, readBaseline } from "./read.js";
import { type FeedbackState, readState, writeState } from "./state.js";

import {
  attachInvalidity,
  blockedVersions,
  dependentRoots,
  invalidRoots,
  validFeedbackState,
} from "./lifecycle.js";

import type { RepositoryAccess } from "./repository-helpers.js";
import {
  accepted,
  activeAttempts,
  pendingNotes,
  qualificationPlan,
  recoveryFeedback,
  required,
  revisionSelection,
} from "./repository-helpers.js";
type JobTarget = {
  id?: string;
  overall?: UnderstandingOverallRequest;
  topic?: { domain: string; version: string };
};
function resolveTarget(snapshot: BaselineSnapshot, s: FeedbackState, targetRequest: JobTarget) {
  const target = targetRequest.id
    ? s.entries.find((e) => e.receipt.id === targetRequest.id)?.receipt
    : undefined;
  if (targetRequest.id && (!target || target.input.type === "helpful"))
    fail("FEEDBACK_NOT_PROCESSABLE");
  const domain = targetRequest.topic?.domain ?? target?.input.domain ?? "overall";
  const reports = accepted(snapshot, s);
  const prior = reports.get(domain);
  const usable = validFeedbackState(s);
  const blocked = blockedVersions(s);
  const recovering =
    Boolean(targetRequest.topic) || (domain === "overall" && blocked.has(prior?.version ?? ""));
  const retiredRoots = [...invalidRoots(s).keys()].filter(
    (id) =>
      !recovering ||
      dependentRoots(s)
        .get(prior?.version ?? "")
        ?.has(id),
  );
  if (target && invalidRoots(s).has(target.source_id)) fail("REPORT_SOURCE_BLOCKED");
  if (
    targetRequest.topic &&
    (!blocked.has(prior?.version ?? "") || targetRequest.topic.version !== prior?.version)
  )
    fail("STALE_REPORT_VERSION");
  if (recovering && retiredRoots.some((id) => !s.lifecycle.some((a) => a.source_id === id)))
    fail("EXPLICIT_SOURCE_RETIREMENT_REQUIRED");
  if (!recovering && domain !== "overall" && blocked.has(prior?.version ?? ""))
    fail("REPORT_SOURCE_BLOCKED");
  const baseSelection = recovering
    ? required(snapshot.accepted.get(domain)).selection
    : prior?.selection;
  const deps = dependencyMap(snapshot, usable, reports);
  return {
    target,
    domain,
    reports,
    prior,
    usable,
    blocked,
    recovering,
    retiredRoots,
    baseSelection,
    deps,
  };
}
type ResolvedTarget = ReturnType<typeof resolveTarget>;
function overallAlreadyCurrent(
  snapshot: BaselineSnapshot,
  s: FeedbackState,
  targetRequest: JobTarget,
  resolved: ResolvedTarget,
) {
  const { domain, reports, blocked, usable, prior, deps: dependencies } = resolved;
  if (domain === "overall") {
    const block = [...reports.entries()].some(([d, r]) => d !== "overall" && blocked.has(r.version))
      ? "TOPICS_NOT_CURRENT"
      : overallBlock(snapshot, usable, reports);
    if (block) fail(block);
    const accepted = [...s.revisions]
      .reverse()
      .find(
        (r) =>
          r.domain === "overall" &&
          r.status === "accepted" &&
          r.baseline_version === snapshot.version,
      );
    if (
      targetRequest.overall &&
      (targetRequest.overall.baseline_version !== snapshot.version ||
        targetRequest.overall.input_hash !== snapshot.input.input_hash ||
        targetRequest.overall.dependency_digest !== digest(dependencies) ||
        (targetRequest.overall.prior_overall_version !== prior?.version &&
          targetRequest.overall.prior_overall_version !== accepted?.previous_version))
    )
      fail("STALE_OVERALL_DEPENDENCY");
    if (accepted?.dependency_digest === digest(dependencies)) return true;
  }
  return false;
}
function recoverInterruptedJob(
  s: FeedbackState,
  snapshot: BaselineSnapshot,
  domain: string,
  recovery: UnderstandingRecoveryRequest,
) {
  const running = [...s.revisions]
    .reverse()
    .find(
      (r) =>
        r.domain === domain && r.baseline_version === snapshot.version && r.status === "processing",
    );
  if (running) {
    if (activeAttempts.has(String(running.id))) fail("FEEDBACK_PROCESSING_BUSY");
    if (typeof running.owner_pid === "number" && running.owner_pid !== process.pid) {
      try {
        process.kill(running.owner_pid, 0);
        fail("FEEDBACK_PROCESSING_BUSY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
    if (!recovery.recover) fail("EXPLICIT_RECOVERY_REQUIRED");
    Object.assign(running, { status: "failed", error: "PROCESS_INTERRUPTED" });
    for (const a of s.attempts.filter((a) => a.job_id === running.id && a.status === "reserved"))
      Object.assign(a, {
        status: "interrupted",
        completed_at: new Date().toISOString(),
        error: "PROCESS_INTERRUPTED",
      });
  }
}
function inheritedQualifications(
  s: FeedbackState,
  resolved: ResolvedTarget,
  prior: NonNullable<ResolvedTarget["prior"]>,
) {
  const { recovering, domain, reports, blocked } = resolved;
  return recovering && domain !== "overall"
    ? []
    : [
        ...new Set(
          (domain === "overall"
            ? [...reports.entries()]
                .filter(([d, r]) => d !== "overall" || !blocked.has(r.version))
                .map(([, r]) => r)
            : [prior]
          ).flatMap((r) => {
            const revision = s.revisions.find(
              (v) => v.version === r.version && v.status === "accepted",
            );
            return (revision?.qualification_versions ?? []) as string[];
          }),
        ),
      ];
}
function createJobAttempt(
  snapshot: BaselineSnapshot,
  s: FeedbackState,
  resolved: ResolvedTarget,
  prior: NonNullable<ResolvedTarget["prior"]>,
  selection: Selection,
  feedback: UnderstandingFeedbackReceipt[],
  qualification: ReturnType<typeof qualificationPlan>,
  recovery: UnderstandingRecoveryRequest,
  inputDigest: string,
  inheritedVersions: string[],
) {
  const { domain, recovering, retiredRoots, blocked, reports, deps: dependencies } = resolved;
  const analysis = {
    task: domain === "overall" ? "u3_overall_feedback_revision" : "u3_topic_feedback_revision",
    source_recovery: recovering,
    retired_roots: recovering ? retiredRoots : [],
    lifecycle_revision: s.lifecycle.length,
    lifecycle_frontier: digest([...invalidRoots(s)].sort()),
    selection,
    feedback: feedback.map((f) => ({
      id: f.id,
      type: f.input.type,
      note: f.input.note,
      finding_key: recovering ? null : (f.input.finding_key ?? null),
      context: recovering ? null : (f.input.context ?? null),
    })),
    previous_report_target_only: recovering || blocked.has(prior.version) ? null : prior.report,
    topics_navigation_only:
      domain === "overall"
        ? snapshot.baseline.topics.map((t) => ({
            domain: t.domain,
            version: reports.get(t.domain)?.version ?? t.version,
            report: reports.get(t.domain)?.report ?? null,
          }))
        : undefined,
    recovery_reason: recovery.reason ?? null,
    dependency_map: domain === "overall" ? dependencies : null,
    previous_version: prior.version,
    instruction:
      "Previous report and feedback objections are targets, not independent proof. Helpful attitude is never evidence. Only independently audited qualified propositions with permitted purpose may support report-only interpretations. Full notes and qualifiers remain context, not independent support. Unknown author and nested quotations must not become subject facts. Report timestamps are disclosure times, not event times. Topic reports are navigation only. Recovery reasons are fallible hints, never author-confirmed facts.",
  };
  const attempt = {
    id: randomUUID(),
    owner_pid: process.pid,
    status: "processing",
    domain,
    baseline_version: snapshot.version,
    input_hash: snapshot.input.input_hash,
    previous_version: prior.version,
    feedback_revision: s.revision,
    lifecycle_revision: s.lifecycle.length,
    lifecycle_frontier: digest([...invalidRoots(s)].sort()),
    source_recovery: recovering,
    retired_roots: recovering ? retiredRoots : [],
    dependency_map: domain === "overall" ? dependencies : null,
    dependency_digest: domain === "overall" ? digest(dependencies) : null,
    input_digest: inputDigest,
    recovery_reason: recovery.reason ?? null,
    feedback_ids: feedback.map((f) => f.id),
    analysis_input: analysis,
    selection,
    candidate: null as unknown,
    audit: null as unknown,
    generation_raw: null as string | null,
    audit_raw: null as string | null,
    version: null as string | null,
    qualification:
      qualification.checkpoint ??
      (qualification.input
        ? ({
            input: qualification.input,
            fingerprint: digest(qualification.input),
            status: "pending",
            candidate: null,
            audit: null,
            version: null,
            provenance: [],
          } satisfies QualificationCheckpoint)
        : null),
    qualification_versions: inheritedVersions,
  };
  return attempt;
}
async function prepareJob(
  deps: RepositoryAccess,
  targetRequest: JobTarget,
  recovery: UnderstandingRecoveryRequest,
) {
  const snapshot = await readBaseline(deps.options);
  const s = await deps.verifiedState();
  const resolved = resolveTarget(snapshot, s, targetRequest);
  const {
    target,
    domain,
    reports,
    prior,
    usable,
    recovering,
    baseSelection,
    deps: dependencies,
  } = resolved;
  if (overallAlreadyCurrent(snapshot, s, targetRequest, resolved)) return null;
  if (
    !prior ||
    (target &&
      (target.input.baseline_version !== snapshot.version ||
        target.input.input_hash !== snapshot.input.input_hash ||
        prior.version !== target.input.report_version))
  )
    fail("STALE_REPORT_VERSION");
  if (!deps.options.gateway || (deps.options.feedbackMaxCalls ?? 0) === 0)
    fail("FEEDBACK_PROCESSING_DISABLED");
  recoverInterruptedJob(s, snapshot, domain, recovery);
  const last = [...s.revisions]
    .reverse()
    .find((r) => r.domain === domain && r.previous_version === prior.version);
  if (last?.status === "failed" && !recovery.recover) fail("EXPLICIT_RECOVERY_REQUIRED");
  const feedback = recovering
    ? domain === "overall"
      ? relevantFeedback(snapshot, usable).filter((f) => f.input.domain === "overall")
      : recoveryFeedback(snapshot, s, domain, prior.version)
    : pendingNotes(snapshot, usable, domain, prior.version);
  const selection =
    domain === "overall"
      ? overallSelection(snapshot, usable, reports)
      : revisionSelection(required(baseSelection), feedback);
  const qualification = qualificationPlan(s, feedback, recovery.reason, recovering);
  const inheritedVersions = inheritedQualifications(s, resolved, prior);
  const inputDigest = digest([
    selection,
    feedback.map((f) => f.id),
    domain === "overall" ? dependencies : null,
    qualification.input,
  ]);
  if (
    last?.status === "rejected" &&
    last.input_digest === inputDigest &&
    (!recovery.reason || recovery.reason === last.recovery_reason)
  )
    fail("SEMANTIC_REJECTION_REQUIRES_CHANGE");
  if (
    s.calls_reserved + (qualification.input && !qualification.checkpoint ? 4 : 2) >
    (deps.options.feedbackMaxCalls ?? 0)
  )
    fail("FEEDBACK_BUDGET_EXHAUSTED");
  const attempt = createJobAttempt(
    snapshot,
    s,
    resolved,
    prior,
    selection,
    feedback,
    qualification,
    recovery,
    inputDigest,
    inheritedVersions,
  );
  for (const f of feedback) f.status = "processing";
  s.revisions.push(attempt);
  await writeState(deps.options, s);
  activeAttempts.add(attempt.id);
  return { snapshot, attempt, feedback, prior, reports, baseSelection };
}
type PreparedJob = NonNullable<Awaited<ReturnType<typeof prepareJob>>>;
type JobOutcome = {
  status: "accepted" | "rejected" | "failed";
  error: string | null;
  semantic: boolean;
};
type ProviderCall = <T>(
  phase: FeedbackState["attempts"][number]["phase"],
  system: string,
  text: string,
  schema: import("zod").z.ZodType<T, import("zod").z.ZodTypeDef, unknown>,
) => Promise<T>;
async function qualifyFeedback(
  deps: RepositoryAccess,
  prepared: PreparedJob,
  call: ProviderCall,
  persistAttempt: () => Promise<void>,
  outcome: JobOutcome,
) {
  const { attempt } = prepared;
  const q = attempt.qualification;
  if (q && !q.version) {
    q.candidate = UnderstandingQualification.parse(
      await call(
        "qualification_generation",
        QUALIFICATION_PROMPT,
        JSON.stringify(q.input),
        UnderstandingQualification,
      ),
    );
    await persistAttempt();
    outcome.semantic = true;
    qualificationFacts(q.input, q.candidate);
    outcome.semantic = false;
    q.audit = UnderstandingAudit.parse(
      await call(
        "qualification_audit",
        QUALIFICATION_AUDIT_PROMPT,
        JSON.stringify({
          task: "u3_independent_qualification_audit",
          analysis_input: q.input,
          analysis_input_hash: q.fingerprint,
          candidate: q.candidate,
          assigned: qualificationAssigned(q.input, q.candidate),
        }),
        UnderstandingAudit,
      ),
    );
    await persistAttempt();
    outcome.semantic = true;
    validateAudit(
      q.audit,
      q.fingerprint,
      qualificationAssigned(q.input, q.candidate),
      q.input.notes.map((n) => n.source_id),
    );
    const current = await deps.verifiedState();
    q.provenance = current.attempts.filter(
      (a) =>
        a.job_id === attempt.id &&
        ["qualification_generation", "qualification_audit"].includes(a.phase),
    );
    q.status = qualificationFacts(q.input, q.candidate).some((f) => f.use !== "context")
      ? "ready"
      : "context_only";
    q.version = digest([q.input, q.candidate, q.audit, q.provenance]);
    outcome.semantic = false;
    await persistAttempt();
  }
  if (q?.version && !attempt.qualification_versions.includes(q.version))
    attempt.qualification_versions.push(q.version);
}
async function verifyCompletionFrontier(
  deps: RepositoryAccess,
  prepared: PreparedJob,
  s: FeedbackState,
  assertFrontier: (s: FeedbackState) => void,
) {
  const { snapshot, attempt } = prepared;
  const verified = await deps.verifiedState();
  attachInvalidity(s, invalidRoots(verified));
  assertFrontier(s);
  await snapshot.input.fresh();
  const latest = await readBaseline(deps.options);
  if (
    latest.version !== snapshot.version ||
    (attempt.domain !== "overall" && s.revision !== attempt.feedback_revision)
  )
    fail("REVISION_SOURCE_RACE");
  const current = accepted(latest, s);
  if (
    attempt.domain === "overall" &&
    (overallBlock(latest, validFeedbackState(s), current) ||
      digest(dependencyMap(latest, validFeedbackState(s), current)) !== attempt.dependency_digest)
  )
    fail("REVISION_SOURCE_RACE");
  if (current.get(attempt.domain)?.version !== attempt.previous_version)
    fail("REVISION_SOURCE_RACE");
}
async function finishJob(
  deps: RepositoryAccess,
  prepared: PreparedJob,
  assertFrontier: (s: FeedbackState) => void,
  outcome: JobOutcome,
) {
  const { attempt } = prepared;
  const s = await readState(deps.options);
  try {
    await verifyCompletionFrontier(deps, prepared, s, assertFrontier);
  } catch {
    outcome.status = "failed";
    outcome.error = "REVISION_SOURCE_RACE";
  }
  const stored = s.revisions.find((r) => r.id === attempt.id);
  if (!stored) fail("REVISION_STATE_MISSING");
  if (stored.status !== "processing") return;
  attempt.generation_raw =
    s.attempts.find((a) => a.job_id === attempt.id && a.phase === "generation")?.raw ?? null;
  attempt.audit_raw =
    s.attempts.find((a) => a.job_id === attempt.id && a.phase === "audit")?.raw ?? null;
  Object.assign(stored, attempt, { status: outcome.status, error: outcome.error });
  for (const e of s.entries.filter((e) => attempt.feedback_ids.includes(e.receipt.id))) {
    e.receipt.status = outcome.status;
    e.receipt.error = outcome.error;
    e.receipt.result_version = outcome.status === "accepted" ? attempt.version : null;
  }
  await writeState(deps.options, s);
  return;
}
async function reviseReport(
  deps: RepositoryAccess,
  prepared: PreparedJob,
  call: ProviderCall,
  persistAttempt: () => Promise<void>,
  outcome: JobOutcome,
) {
  const { snapshot, attempt, feedback, reports, baseSelection } = prepared;
  const currentState = await deps.verifiedState();
  const qualified = qualifiedDependencies(currentState, attempt.qualification_versions);
  attempt.selection =
    attempt.domain === "overall"
      ? overallSelection(snapshot, validFeedbackState(currentState), reports, qualified)
      : revisionSelection(required(baseSelection), feedback, qualified);
  attempt.analysis_input.selection = attempt.selection;
  Object.assign(attempt.analysis_input, {
    qualification_versions: attempt.qualification_versions,
  });
  await persistAttempt();
  await snapshot.input.fresh();
  const report = UnderstandingReport.parse(
    await call(
      "generation",
      attempt.domain === "overall" ? PROMPTS.overall : PROMPTS.topic,
      JSON.stringify(attempt.analysis_input),
      UnderstandingReport,
    ),
  );
  attempt.candidate = report;
  await persistAttempt();
  outcome.semantic = true;
  validateReport(report, attempt.selection);
  outcome.semantic = false;
  const assigned = assignReport(report, digest(attempt.analysis_input));
  await snapshot.input.fresh();
  const audit = UnderstandingAudit.parse(
    await call(
      "audit",
      PROMPTS.audit,
      JSON.stringify({
        task: "u3_independent_feedback_audit",
        analysis_input: attempt.analysis_input,
        analysis_input_hash: digest(attempt.analysis_input),
        candidate: report,
        assigned,
      }),
      UnderstandingAudit,
    ),
  );
  attempt.audit = audit;
  outcome.semantic = true;
  validateAudit(
    audit,
    digest(attempt.analysis_input),
    assigned,
    attempt.selection.evidence.map((e) => e.id),
  );
  attempt.version = digest([attempt.analysis_input, report, audit]);
  outcome.status = "accepted";
}
async function runPreparedJob(deps: RepositoryAccess, prepared: PreparedJob) {
  const { snapshot, attempt } = prepared;
  const assertFrontier = (s: FeedbackState) => {
    if (
      s.lifecycle.length !== attempt.lifecycle_revision ||
      digest([...invalidRoots(s)].sort()) !== attempt.lifecycle_frontier
    )
      fail("REVISION_SOURCE_RACE");
  };
  const update = <T>(fn: (s: FeedbackState) => Promise<T> | T) =>
    deps.locked(async () => {
      const s = await readState(deps.options);
      const before = s.calls_reserved;
      const result = await fn(s);
      if (s.calls_reserved > before) {
        const verified = await deps.verifiedState();
        assertFrontier(verified);
      }
      await writeState(deps.options, s);
      return result;
    });
  const call = <T>(
    phase: FeedbackState["attempts"][number]["phase"],
    system: string,
    text: string,
    schema: import("zod").z.ZodType<T, import("zod").z.ZodTypeDef, unknown>,
  ) =>
    deps.verifiedState().then((s) => {
      assertFrontier(s);
      return providerAttempt({
        gateway: required(deps.options.gateway),
        update,
        budget: deps.options.feedbackMaxCalls ?? 0,
        job: attempt.id,
        phase,
        timeoutMs: deps.options.providerTimeoutMs ?? 120000,
        system,
        text,
        schema,
      });
    });
  const outcome: JobOutcome = { status: "failed", error: null, semantic: false };
  const persistAttempt = () =>
    deps.locked(async () => {
      const s = await deps.verifiedState();
      const stored = s.revisions.find((r) => r.id === attempt.id);
      if (!stored) fail("REVISION_STATE_MISSING");
      assertFrontier(s);
      Object.assign(stored, attempt);
      await writeState(deps.options, s);
    });
  try {
    await snapshot.input.fresh();
    await qualifyFeedback(deps, prepared, call, persistAttempt, outcome);
    await reviseReport(deps, prepared, call, persistAttempt, outcome);
  } catch (e) {
    outcome.status =
      outcome.semantic || (e instanceof Error && e.message === "PROVIDER_SCHEMA_VALIDATION")
        ? "rejected"
        : "failed";
    outcome.error =
      e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "FEEDBACK_ANALYSIS_FAILED";
    if (outcome.status === "rejected" && attempt.qualification && !attempt.qualification.version)
      attempt.qualification.status = "rejected";
  }
  try {
    return await deps.locked(async () => {
      return finishJob(deps, prepared, assertFrontier, outcome);
    });
  } finally {
    activeAttempts.delete(attempt.id);
  }
}
export async function processJob(
  deps: RepositoryAccess,
  targetRequest: JobTarget,
  recovery: UnderstandingRecoveryRequest,
) {
  const prepared = await deps.locked(() => prepareJob(deps, targetRequest, recovery));
  if (prepared) return runPreparedJob(deps, prepared);
}
