import {
  type CoreReportTarget,
  UNDERSTANDING_APP_VERSION,
  type UnderstandingAppView,
  UnderstandingAudit,
  type UnderstandingExactEvidence,
  type UnderstandingFeedbackReceipt,
  UnderstandingReport,
  type UnderstandingReportHistory,
  type UnderstandingVersionView,
} from "@findme/core";
import {
  assignReport,
  reportObjects,
  validateAudit,
  validateReport,
} from "../domain/understanding/policy.js";
import type { Fact, Selection } from "../domain/understanding/types.js";
import { digest, fail } from "../shared/primitives.js";
import { DOMAIN_TITLES } from "../understanding-baseline/runner.js";
import { type BaselineSnapshot, readBaseline } from "./read.js";
import type { FeedbackState } from "./state.js";

import { validateReportTarget } from "../core/report-bridge.js";
import {
  boundedSelection,
  dependencyMap,
  feedbackFact,
  overallBlock,
  overallSelection,
  relevantFeedback,
} from "./dependencies.js";
import {
  type QualificationCheckpoint,
  qualificationInput,
  qualificationStatus,
  qualifiedDependencies,
  reusableQualification,
} from "./qualification.js";

import {
  blockedVersions,
  dependentRoots,
  invalidRoots,
  redactReceipt,
  sourceStatuses,
  validFeedbackState,
} from "./lifecycle.js";

import type { UnderstandingRepositoryOptions } from "./repository.js";
export type RepositoryAccess = {
  options: UnderstandingRepositoryOptions;
  locked: <T>(fn: () => Promise<T>) => Promise<T>;
  verifiedState: () => Promise<FeedbackState>;
  readFrontier: (state: FeedbackState) => Promise<void>;
};
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) fail("UNDERSTANDING_STATE_INTEGRITY");
  return value;
}

export const activeAttempts = new Set<string>();
export function jobRunning(job: Record<string, unknown> | undefined) {
  if (!job || job.status !== "processing") return false;
  if (activeAttempts.has(String(job.id))) return true;
  if (typeof job.owner_pid === "number" && job.owner_pid !== process.pid) {
    try {
      process.kill(job.owner_pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return true;
    }
  }
  return false;
}
export function pendingNotes(
  snapshot: BaselineSnapshot,
  s: FeedbackState,
  domain: string,
  version: string,
) {
  return relevantFeedback(snapshot, s).filter(
    (f) =>
      f.input.domain === domain && f.status !== "accepted" && f.input.report_version === version,
  );
}
export function qualificationPlan(
  s: FeedbackState,
  notes: UnderstandingFeedbackReceipt[],
  reason?: string,
  redactTargets = false,
) {
  if (!notes.length) return { input: null, checkpoint: undefined };
  const last = [...s.revisions]
    .reverse()
    .map((r) => r.qualification as QualificationCheckpoint | undefined)
    .find(
      (q) =>
        q?.input?.notes.length === notes.length &&
        q.input.notes.every((n) => notes.some((f) => f.id === n.id)),
    );
  const hint = redactTargets
    ? (reason ?? null)
    : last?.version
      ? last.input.correction_hint
      : last?.status === "rejected"
        ? (reason ?? last.input.correction_hint)
        : null;
  const input = qualificationInput(notes, hint, s, redactTargets);
  return { input, checkpoint: reusableQualification(s, input) };
}

export function recoveryFeedback(
  snapshot: BaselineSnapshot,
  state: FeedbackState,
  domain: string,
  version: string,
) {
  const roots = dependentRoots(state).get(version) ?? new Set<string>();
  return relevantFeedback(snapshot, validFeedbackState(state)).filter(
    (f) =>
      f.input.domain === domain &&
      (roots.has(f.source_id) || (f.input.report_version === version && f.status !== "accepted")),
  );
}

export function accepted(snapshot: BaselineSnapshot, state: FeedbackState) {
  const reports = new Map(snapshot.accepted);
  for (const raw of state.revisions) {
    if (
      raw.status !== "accepted" ||
      raw.baseline_version !== snapshot.version ||
      raw.input_hash !== snapshot.input.input_hash
    )
      continue;
    const domain = String(raw.domain);
    const prior = reports.get(domain);
    if (!prior || raw.previous_version !== prior.version) fail("REVISION_CHAIN_INTEGRITY");
    const selection = raw.selection as Selection;
    const report = UnderstandingReport.parse(raw.candidate);
    const audit = UnderstandingAudit.parse(raw.audit);
    const analysis = raw.analysis_input as { selection: Selection };
    const qualified = raw.qualification_versions
      ? qualifiedDependencies(state, raw.qualification_versions as string[])
      : undefined;
    if (
      raw.qualification_versions &&
      digest(
        (raw.analysis_input as { qualification_versions?: unknown }).qualification_versions,
      ) !== digest(raw.qualification_versions)
    )
      fail("QUALIFICATION_DEPENDENCY_INTEGRITY");
    if (
      digest(analysis.selection) !== digest(selection) ||
      raw.version !== digest([raw.analysis_input, report, audit])
    )
      fail("REVISION_INTEGRITY");
    const original = raw.source_recovery
      ? required(snapshot.accepted.get(domain)).selection
      : prior.selection;
    if (
      raw.source_recovery &&
      (digest((raw.analysis_input as { retired_roots?: unknown }).retired_roots) !==
        digest(raw.retired_roots) ||
        (raw.analysis_input as { lifecycle_revision?: unknown }).lifecycle_revision !==
          raw.lifecycle_revision ||
        !(raw.retired_roots as string[]).length ||
        (raw.retired_roots as string[]).some(
          (id) =>
            !state.lifecycle.some(
              (a) => a.source_id === id && a.revision <= Number(raw.lifecycle_revision),
            ),
        ))
    )
      fail("SOURCE_LIFECYCLE_INTEGRITY");
    const expected =
      domain !== "overall" && !raw.input_digest
        ? legacySelection(
            original,
            state.entries
              .map((e) => e.receipt)
              .filter((f) => (raw.feedback_ids as string[]).includes(f.id)),
          )
        : domain === "overall"
          ? overallSelection(
              snapshot,
              {
                ...state,
                entries: state.entries.filter((e) =>
                  (raw.dependency_map as ReturnType<typeof dependencyMap>).feedback.some(
                    (f) => f.id === e.receipt.id,
                  ),
                ),
              },
              reports,
              qualified,
            )
          : revisionSelection(
              original,
              state.entries
                .map((e) => e.receipt)
                .filter((f) => (raw.feedback_ids as string[]).includes(f.id)),
              qualified,
            );
    if (domain === "overall") {
      const analysisDeps = (raw.analysis_input as { dependency_map?: unknown }).dependency_map;
      const deps = raw.dependency_map as ReturnType<typeof dependencyMap>;
      if (
        digest(deps) !== raw.dependency_digest ||
        digest(analysisDeps) !== digest(deps) ||
        digest(deps.topics) !== digest(dependencyMap(snapshot, state, reports).topics)
      )
        fail("OVERALL_DEPENDENCY_INTEGRITY");
    }
    if (digest(expected) !== digest(selection)) fail("REVISION_SOURCE_INTEGRITY");
    validateReport(report, selection);
    validateAudit(
      audit,
      digest(analysis),
      assignReport(report, digest(analysis)),
      selection.evidence.map((e) => e.id),
    );
    reports.set(domain, { version: String(raw.version), report, selection });
  }
  return reports;
}

export function affected(state: FeedbackState, snapshot: BaselineSnapshot, domain?: string) {
  return state.entries.some(
    ({ receipt: f }) =>
      f.input.baseline_version === snapshot.version &&
      f.input.type !== "helpful" &&
      (!domain || f.input.domain === domain) &&
      f.status !== "accepted",
  );
}

export async function read(access: RepositoryAccess): Promise<UnderstandingAppView> {
  const snapshot = await readBaseline(access.options);
  const s = await access.verifiedState();
  const reports = accepted(snapshot, s);
  const blocked = blockedVersions(s);
  const overall = reports.get("overall");
  const deps = dependencyMap(snapshot, validFeedbackState(s), reports);
  const currentOverall = [...s.revisions]
    .reverse()
    .find(
      (r) => r.domain === "overall" && r.status === "accepted" && r.version === overall?.version,
    );
  const overallPending =
    [...reports.entries()].some(([d, r]) => d !== "overall" && blocked.has(r.version)) ||
    blocked.has(overall?.version ?? "") ||
    (currentOverall
      ? currentOverall.dependency_digest !== digest(deps)
      : relevantFeedback(snapshot, validFeedbackState(s)).length > 0);
  const capability = capabilities(access, snapshot, validFeedbackState(s), reports, overallPending);
  capability.topic_recovery = snapshot.baseline.topics
    .filter((t) => blocked.has(reports.get(t.domain)?.version ?? ""))
    .map((t) => {
      const version = required(reports.get(t.domain)).version;
      const dependencies = dependentRoots(s).get(version) ?? new Set<string>();
      const roots = new Map([...invalidRoots(s)].filter(([id]) => dependencies.has(id)));
      const notes = recoveryFeedback(snapshot, s, t.domain, version);
      let requiredCalls = 2;
      let qualificationBlock: string | null = null;
      try {
        if (notes.length && !qualificationPlan(s, notes, undefined, true).checkpoint)
          requiredCalls = 4;
      } catch (e) {
        qualificationBlock = (e as Error).message;
      }
      const reason = [...roots.keys()].some((id) => !s.lifecycle.some((a) => a.source_id === id))
        ? "EXPLICIT_SOURCE_RETIREMENT_REQUIRED"
        : (qualificationBlock ??
          (!capability.provider_enabled
            ? "FEEDBACK_PROCESSING_DISABLED"
            : capability.remaining_calls < requiredCalls
              ? "FEEDBACK_BUDGET_EXHAUSTED"
              : null));
      return {
        domain: t.domain,
        version,
        action: reason ? null : "process",
        blocked_reason: reason,
      };
    });
  await snapshot.input.fresh();
  await access.readFrontier(s);
  return {
    format: UNDERSTANDING_APP_VERSION,
    baseline_version: snapshot.version,
    input_hash: snapshot.input.input_hash,
    overall: {
      version: overall?.version ?? snapshot.version,
      status: overallPending ? "needs_review" : overall ? "ready" : "unavailable",
      report: overallPending ? null : (overall?.report ?? null),
    },
    capabilities: capability,
    topics: snapshot.baseline.topics.map((t) => {
      const r = reports.get(t.domain);
      return {
        domain: t.domain,
        title: DOMAIN_TITLES[t.domain],
        version: r?.version ?? t.version,
        status: blocked.has(r?.version ?? "")
          ? "blocked"
          : affected(validFeedbackState(s), snapshot, t.domain)
            ? "needs_review"
            : r
              ? "ready"
              : t.status === "ready_candidate"
                ? "partial"
                : t.status,
        report: blocked.has(r?.version ?? "") ? null : (r?.report ?? null),
        selection: {
          scope: (r?.selection ?? t.selection).scope,
          selected_original_atoms: (r?.selection ?? t.selection).selected_original_atoms,
          canonical_count: (r?.selection ?? t.selection).canonical_count,
          omitted_count: (r?.selection ?? t.selection).omitted.length,
          repair_inputs_unavailable: (r?.selection ?? t.selection).repair_inputs_unavailable.length,
        },
      };
    }),
    old_dispositions: {
      version: snapshot.version,
      status: relevantFeedback(snapshot, s).length
        ? "needs_review"
        : snapshot.old
          ? "ready"
          : "partial",
      report: snapshot.old,
    },
    frameworks: { human_3: "not_run" },
    scope: {
      cutoff_before: snapshot.input.inventory.batch.manifest.cutoffBefore ?? "未指定",
      source_fingerprint: snapshot.input.inventory.batch.manifest.sourceFingerprint,
      exhaustive: false,
      owner_confirmed: false,
    },
    sources: sourceStatuses(s),
    feedback: s.entries.map((e) => ({
      ...redactReceipt(s, e.receipt, blocked),
      ...(blocked.has(e.receipt.input.report_version) && !invalidRoots(s).has(e.receipt.source_id)
        ? { input: { ...e.receipt.input, context: undefined } }
        : {}),
      qualification: invalidRoots(s).has(e.receipt.source_id)
        ? "pending"
        : qualificationStatus(s, e.receipt),
    })),
  };
}

export async function history(
  access: RepositoryAccess,
  domain: string,
  limit = 30,
): Promise<UnderstandingReportHistory> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("HISTORY_QUERY_INVALID");
  const snapshot = await readBaseline(access.options);
  const state = await access.verifiedState();
  const reports = accepted(snapshot, state);
  const blocked = blockedVersions(state);
  const baseline = snapshot.accepted.get(domain);
  const rows = [
    ...(baseline
      ? [
          {
            domain,
            version: baseline.version,
            previous_version: null,
            origin: "baseline" as const,
            feedback_types: [],
          },
        ]
      : []),
    ...state.revisions
      .filter(
        (r) =>
          r.status === "accepted" &&
          r.domain === domain &&
          r.baseline_version === snapshot.version &&
          r.input_hash === snapshot.input.input_hash,
      )
      .map((r) => ({
        domain,
        version: String(r.version),
        previous_version: String(r.previous_version),
        origin: r.source_recovery ? ("source_recovery" as const) : ("feedback" as const),
        feedback_types: [
          ...new Set(
            state.entries
              .filter((e) => (r.feedback_ids as string[]).includes(e.receipt.id))
              .map((e) => e.receipt.input.type),
          ),
        ],
      })),
  ].reverse();
  if (!rows.length) fail("REPORT_VERSION_NOT_FOUND");
  const current = reports.get(domain)?.version;
  const pending = affected(validFeedbackState(state), snapshot, domain);
  let overallPending =
    domain === "overall" &&
    [...reports.entries()].some(([d, r]) => d !== "overall" && blocked.has(r.version));
  if (domain === "overall") {
    const r = state.revisions.find((r) => r.version === current && r.status === "accepted");
    overallPending ||= r
      ? r.dependency_digest !== digest(dependencyMap(snapshot, validFeedbackState(state), reports))
      : relevantFeedback(snapshot, validFeedbackState(state)).length > 0;
  }
  await snapshot.input.fresh();
  await access.readFrontier(state);
  return {
    truncated: rows.length > limit,
    versions: rows.slice(0, limit).map((r) => ({
      ...r,
      status: blocked.has(r.version)
        ? "blocked"
        : r.version !== current
          ? "superseded"
          : pending || overallPending
            ? "needs_review"
            : "accepted",
    })),
  };
}

export async function version(
  access: RepositoryAccess,
  domain: string,
  version: string,
): Promise<UnderstandingVersionView> {
  const snapshot = await readBaseline(access.options);
  const state = await access.verifiedState();
  const current = accepted(snapshot, state).get(domain);
  const raw = state.revisions.find(
    (r) =>
      r.status === "accepted" &&
      r.domain === domain &&
      r.version === version &&
      r.baseline_version === snapshot.version &&
      r.input_hash === snapshot.input.input_hash,
  );
  const baseline = snapshot.accepted.get(domain);
  if (!raw && baseline?.version !== version) fail("REPORT_VERSION_NOT_FOUND");
  const blocked = blockedVersions(state).has(version);
  const overallRevision =
    domain === "overall"
      ? state.revisions.find((r) => r.version === current?.version && r.status === "accepted")
      : undefined;
  const overallPending =
    domain === "overall" &&
    ([...accepted(snapshot, state).entries()].some(
      ([d, r]) => d !== "overall" && blockedVersions(state).has(r.version),
    ) ||
      (overallRevision
        ? overallRevision.dependency_digest !==
          digest(dependencyMap(snapshot, validFeedbackState(state), accepted(snapshot, state)))
        : relevantFeedback(snapshot, validFeedbackState(state)).length > 0));
  const meta = {
    domain,
    version,
    previous_version: raw ? String(raw.previous_version) : null,
    origin: raw?.source_recovery
      ? ("source_recovery" as const)
      : raw
        ? ("feedback" as const)
        : ("baseline" as const),
    feedback_types: raw
      ? [
          ...new Set(
            state.entries
              .filter((e) => (raw.feedback_ids as string[]).includes(e.receipt.id))
              .map((e) => e.receipt.input.type),
          ),
        ]
      : [],
    status: blocked
      ? ("blocked" as const)
      : current?.version !== version
        ? ("superseded" as const)
        : affected(validFeedbackState(state), snapshot, domain) || overallPending
          ? ("needs_review" as const)
          : ("accepted" as const),
  };
  await snapshot.input.fresh();
  await access.readFrontier(state);
  return {
    ...meta,
    report: blocked
      ? null
      : raw
        ? UnderstandingReport.parse(raw.candidate)
        : required(baseline).report,
  };
}

export async function validateCoreTarget(
  access: RepositoryAccess,
  raw: CoreReportTarget,
): Promise<CoreReportTarget> {
  const snapshot = await readBaseline(access.options);
  const state = await access.verifiedState();
  const report = accepted(snapshot, state).get(raw.domain);
  if (blockedVersions(state).has(report?.version ?? "")) fail("REPORT_SOURCE_BLOCKED");
  // A pending note hides the overall from ordinary display, but does not change
  // its identity. Validate against the current authoritative accepted version.
  const selected = { version: report?.version ?? "", report: report?.report ?? null };
  const result = validateReportTarget(
    {
      baseline_version: snapshot.version,
      input_hash: snapshot.input.input_hash,
      overall: selected,
      topics: raw.domain === "overall" ? [] : [{ domain: raw.domain, ...selected }],
    },
    raw,
  );
  await snapshot.input.fresh();
  await access.readFrontier(state);
  return result;
}

export async function evidences(
  access: RepositoryAccess,
  domain: string,
  version: string,
  requestedIds: string[],
): Promise<UnderstandingExactEvidence[]> {
  if (
    !requestedIds.length ||
    requestedIds.length > 24 ||
    new Set(requestedIds).size !== requestedIds.length ||
    requestedIds.some((id) => !id || id.length > 200)
  )
    fail("EVIDENCE_QUERY_INVALID");
  const snapshot = await readBaseline(access.options);
  const s = await access.verifiedState();
  const current = accepted(snapshot, s).get(domain);
  // Historical accepted topic revisions remain scoped and qualification-checked.
  let r = snapshot.accepted.get(domain);
  if (current?.version === version) r = current;
  else if (r?.version !== version) {
    const raw = s.revisions.find(
      (v) =>
        v.status === "accepted" &&
        v.domain === domain &&
        v.version === version &&
        v.baseline_version === snapshot.version &&
        v.input_hash === snapshot.input.input_hash,
    );
    r = raw
      ? {
          version,
          report: UnderstandingReport.parse(raw.candidate),
          selection: raw.selection as Selection,
        }
      : undefined;
  }
  if (!r || r.version !== version) fail("REPORT_VERSION_NOT_FOUND");
  if (blockedVersions(s).has(version)) fail("REPORT_SOURCE_BLOCKED");
  const ids = reportObjects(r.report).flatMap((o) => [
    ...o.evidence_ids,
    ...("counterevidence_ids" in o ? o.counterevidence_ids : []),
    ...("context_ids" in o ? o.context_ids : []),
  ]);
  const selected = requestedIds.map((id) => {
    if (!ids.includes(id)) fail("EVIDENCE_OUTSIDE_REPORT");
    const e = r.selection.evidence.find((e) => e.id === id);
    if (!e) fail("EVIDENCE_OUTSIDE_REPORT");
    return e;
  });
  await snapshot.input.fresh();
  await access.readFrontier(s);
  return selected.map((e) => ({
    id: e.id,
    quote: e.quote,
    qualifier: e.qualifier?.text ?? null,
    author: e.content_author,
    about: e.about,
    stance: e.stance,
    report_time: e.time,
    scope: e.scope,
    source_id: e.source_id,
    source_ids: e.root_ids,
    session_id: e.session_id,
    message_id: e.message_id,
    start: e.start,
    end: e.end,
    offset_unit: "utf16" as const,
  }));
}

/** Historical @1 verification only; new calls always use conservative feedback candidates. */
function legacySelection(original: Selection, feedback: UnderstandingFeedbackReceipt[]): Selection {
  const evidence = [...original.evidence];
  for (const f of feedback) {
    if (f.input.type === "helpful") continue;
    const personal = ["supplement", "time_update"].includes(f.input.type);
    evidence.push({
      id: f.source_id,
      canonical_id: f.source_id,
      root_ids: [f.source_id],
      source_id: f.source_id,
      quote: f.input.note,
      start: 0,
      end: f.input.note.length,
      content_author: "subject",
      about: "self",
      kind: personal ? "self_report" : "unknown",
      stance: "reported",
      use: personal ? "personal_expression" : "context",
      scope: `用户对目标报告的${f.input.type}`,
      session_id: f.id,
      message_id: f.id,
      project: "u3-feedback",
      time: f.saved_at,
      group_id: f.id,
      facet: "state",
      original_facet: "state",
      proposition_type: "state",
      proposition: f.input.note,
      purpose: personal ? "personal_expression" : "context_only",
      provenance: "subject",
      qualifier: null,
    } as Fact);
  }
  if (evidence.length > 32 || Buffer.byteLength(JSON.stringify(evidence)) > 48000)
    fail("FEEDBACK_INPUT_BOUND_EXCEEDED");
  return {
    ...original,
    evidence,
    selected_original_atoms: evidence.length,
    bytes: Buffer.byteLength(JSON.stringify(evidence)),
    canonical_count: new Set(evidence.map((e) => e.canonical_id)).size,
  };
}

export function revisionSelection(
  original: Selection,
  feedback: UnderstandingFeedbackReceipt[],
  qualified?: Fact[],
): Selection {
  const evidence = new Map(original.evidence.map((e) => [e.id, e]));
  for (const f of feedback) {
    if (f.input.type === "helpful") continue;
    const facts = qualified?.filter((e) => e.source_id === f.source_id);
    for (const e of facts?.length ? facts : [feedbackFact(f)]) evidence.set(e.id, e);
  }
  return boundedSelection(original, [...evidence.values()]);
}

export function capabilities(
  access: RepositoryAccess,
  snapshot: BaselineSnapshot,
  s: FeedbackState,
  reports: ReturnType<typeof accepted>,
  pending: boolean,
): UnderstandingAppView["capabilities"] {
  const enabled = Boolean(access.options.gateway && (access.options.feedbackMaxCalls ?? 0) > 0);
  const remaining = Math.max(0, (access.options.feedbackMaxCalls ?? 0) - s.calls_reserved);
  let block = [...reports.entries()].some(
    ([d, r]) => d !== "overall" && blockedVersions(s).has(r.version),
  )
    ? "TOPICS_NOT_CURRENT"
    : overallBlock(snapshot, s, reports);
  if (!block) {
    try {
      overallSelection(snapshot, s, reports);
    } catch (e) {
      block = (e as Error).message;
    }
  }
  const last = [...s.revisions]
    .reverse()
    .find((r) => r.domain === "overall" && r.baseline_version === snapshot.version);
  const deps = digest(dependencyMap(snapshot, s, reports));
  const ready = reports.has("overall") && !pending;
  const request =
    !block && !ready
      ? {
          baseline_version: snapshot.version,
          input_hash: snapshot.input.input_hash,
          prior_overall_version: required(reports.get("overall")).version,
          dependency_digest: deps,
        }
      : null;
  let overallRequired = 2;
  const recoveringOverall = blockedVersions(s).has(reports.get("overall")?.version ?? "");
  const overallNotes = recoveringOverall
    ? relevantFeedback(snapshot, s).filter((f) => f.input.domain === "overall")
    : pendingNotes(snapshot, s, "overall", reports.get("overall")?.version ?? "");
  try {
    if (
      overallNotes.length &&
      !qualificationPlan(s, overallNotes, undefined, recoveringOverall).checkpoint
    )
      overallRequired = 4;
  } catch (e) {
    block ??= (e as Error).message;
  }
  const providerBlock = !enabled
    ? "FEEDBACK_PROCESSING_DISABLED"
    : remaining < overallRequired
      ? "FEEDBACK_BUDGET_EXHAUSTED"
      : null;
  const actionFor = (status: unknown) =>
    status === "failed" || status === "processing"
      ? ("recover" as const)
      : status === "rejected"
        ? ("revise_reason" as const)
        : ("process" as const);
  return {
    provider_enabled: enabled,
    remaining_calls: remaining,
    native_core: "unavailable",
    feedback_actions: s.entries.map(({ receipt: f }) => {
      const notes = pendingNotes(snapshot, s, f.input.domain, f.input.report_version);
      let required = 2;
      let qualificationBlock: string | null = null;
      if (notes.length) {
        try {
          required += qualificationPlan(s, notes).checkpoint ? 0 : 2;
        } catch (e) {
          qualificationBlock = (e as Error).message;
        }
      }
      const stale =
        f.input.baseline_version !== snapshot.version ||
        f.input.input_hash !== snapshot.input.input_hash ||
        reports.get(f.input.domain)?.version !== f.input.report_version;
      const job = [...s.revisions]
        .reverse()
        .find(
          (r) =>
            r.domain === f.input.domain &&
            r.baseline_version === snapshot.version &&
            r.status === "processing",
        );
      const reason =
        f.input.type === "helpful" || f.status === "accepted"
          ? "FEEDBACK_NOT_PENDING"
          : stale
            ? "STALE_REPORT_VERSION"
            : jobRunning(job)
              ? "FEEDBACK_PROCESSING_BUSY"
              : f.input.domain === "overall" && block
                ? block
                : (qualificationBlock ??
                  (!enabled
                    ? "FEEDBACK_PROCESSING_DISABLED"
                    : remaining < required
                      ? "FEEDBACK_BUDGET_EXHAUSTED"
                      : null));
      return {
        id: f.id,
        action: reason ? null : actionFor(f.status),
        blocked_reason: reason,
        required_calls: required,
      };
    }),
    overall: {
      status: block
        ? "blocked"
        : ready
          ? "ready"
          : last?.status === "processing"
            ? "running"
            : last?.status === "rejected"
              ? "rejected"
              : last?.status === "failed"
                ? "failed"
                : "pending",
      blocked_reason: block ?? (jobRunning(last) ? "FEEDBACK_PROCESSING_BUSY" : providerBlock),
      request,
      action: request && !providerBlock && !jobRunning(last) ? actionFor(last?.status) : null,
      required_calls: ready ? 0 : overallRequired,
    },
  };
}
