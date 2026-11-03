import type { UnderstandingFeedbackReceipt } from "@findme/core";
import { reportObjects } from "../domain/understanding/policy.js";
import type { Fact, Selection } from "../domain/understanding/types.js";
import { digest, fail } from "../shared/primitives.js";
import { blockedVersions } from "./lifecycle.js";
import type { AcceptedReport, BaselineSnapshot } from "./read.js";
import type { FeedbackState } from "./state.js";

export function relevantFeedback(snapshot: BaselineSnapshot, state: FeedbackState) {
  return state.entries
    .map((e) => e.receipt)
    .filter(
      (f) =>
        f.input.baseline_version === snapshot.version &&
        f.input.input_hash === snapshot.input.input_hash &&
        f.input.type !== "helpful",
    );
}
export function dependencyMap(
  snapshot: BaselineSnapshot,
  state: FeedbackState,
  reports: Map<string, AcceptedReport>,
) {
  return {
    topics: snapshot.baseline.topics
      .map((t) => ({
        domain: t.domain,
        version: reports.get(t.domain)?.version ?? t.version,
        status: reports.has(t.domain) ? "accepted" : t.status,
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
    feedback: relevantFeedback(snapshot, state)
      .map((f) => ({
        id: f.id,
        revision: f.revision,
        input: digest(f.input),
        topic_result: f.input.domain === "overall" ? null : f.result_version,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function overallBlock(
  snapshot: BaselineSnapshot,
  state: FeedbackState,
  reports: Map<string, AcceptedReport>,
) {
  if (!snapshot.accepted.has("overall")) return "U2_OVERALL_ABSENT";
  if (
    snapshot.baseline.topics.some(
      (t) => !reports.has(t.domain) && !["no_evidence", "context_required"].includes(t.status),
    )
  )
    return "TOPICS_NOT_CURRENT";
  const feedback = relevantFeedback(snapshot, state);
  if (feedback.some((f) => f.input.domain !== "overall" && f.status !== "accepted"))
    return "TOPIC_FEEDBACK_UNRESOLVED";
  const lifecycleChange =
    state.lifecycle.length > 0 &&
    (blockedVersions(state).has(reports.get("overall")?.version ?? "") ||
      state.revisions.some(
        (r) =>
          r.status === "accepted" &&
          r.source_recovery &&
          r.domain !== "overall" &&
          reports.get(String(r.domain))?.version === r.version,
      ));
  if (
    !lifecycleChange &&
    !feedback.some((f) => f.input.domain === "overall" || f.status === "accepted")
  )
    return "NEW_FEEDBACK_REQUIRED";
  return null;
}
/** Notes are original reported candidates/review context, never automatic subject facts. */
export function feedbackFact(f: UnderstandingFeedbackReceipt): Fact {
  return {
    id: f.source_id,
    canonical_id: f.source_id,
    root_ids: [f.source_id],
    source_id: f.source_id,
    quote: f.input.note,
    start: 0,
    end: f.input.note.length,
    content_author: "unknown",
    about: "unknown",
    kind: "unknown",
    stance: "reported",
    use: "context",
    scope: `用户对目标报告的${f.input.type}`,
    session_id: f.core_source?.exploration_id ?? f.id,
    message_id: f.core_source?.source_id ?? f.id,
    project: "u3-feedback",
    // Report time is when the original statement was captured, not its event or transfer date.
    time: f.core_source ? f.core_source.disclosed_at : f.saved_at,
    group_id: f.core_source?.exploration_id ?? f.id,
    facet: "state",
    original_facet: "state",
    proposition_type: "state",
    proposition: f.input.note,
    purpose: "context_only",
    provenance: "subject",
    qualifier: null,
  } as Fact;
}
export function boundedSelection(
  original: Selection,
  evidence: Fact[],
  code = "FEEDBACK_INPUT_BOUND_EXCEEDED",
): Selection {
  const sorted = [...evidence].sort((a, b) => a.id.localeCompare(b.id));
  const bytes = Buffer.byteLength(JSON.stringify(sorted));
  if (sorted.length > 32 || bytes > 48000) fail(code);
  return {
    ...original,
    evidence: sorted,
    selected_original_atoms: sorted.length,
    bytes,
    canonical_count: new Set(sorted.map((e) => e.canonical_id)).size,
  };
}
export function overallSelection(
  snapshot: BaselineSnapshot,
  state: FeedbackState,
  reports: Map<string, AcceptedReport>,
  qualified?: Fact[],
) {
  const union = new Map<string, Fact>();
  for (const t of snapshot.baseline.topics) {
    const r = reports.get(t.domain);
    if (!r) continue;
    const refs = new Set(
      reportObjects(r.report).flatMap((o) => [
        ...o.evidence_ids,
        ...("counterevidence_ids" in o ? o.counterevidence_ids : []),
        ...("context_ids" in o ? o.context_ids : []),
      ]),
    );
    for (const id of refs) {
      const e = r.selection.evidence.find((e) => e.id === id);
      if (!e) fail("OVERALL_ORIGINAL_UNAVAILABLE");
      if (union.has(id) && digest(union.get(id)) !== digest(e)) fail("OVERALL_ORIGINAL_CONFLICT");
      union.set(id, e);
    }
  }
  for (const f of relevantFeedback(snapshot, state)) {
    const facts = qualified?.filter((e) => e.source_id === f.source_id);
    for (const e of facts?.length ? facts : [feedbackFact(f)]) union.set(e.id, e);
  }
  return boundedSelection(
    {
      ...snapshot.baseline.overall_selection,
      domain: "overall",
      omitted: [],
      scope: "当前已审核专题引用的原文、反例、背景与本基线新增回应的完整并集",
    },
    [...union.values()],
    "OVERALL_ORIGINAL_BOUND_EXCEEDED",
  );
}
