import type { KnowledgeClaimEvidence, KnowledgeProcessingRecord } from "@findme/core";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { readFeedbackDependencies } from "./dependency-reading.js";
import { snapshotEvidence, union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";
import { knowledgeTable, recordFromRow } from "./repository.js";

export type OpenProfileFeedback = {
  topic_key: string;
  item: KnowledgeProcessingRecord["feedback"][number];
};

/** Only the latest snapshot of each topic may govern new publications. */
export async function openProfileFeedback(db: KnowledgeDb, ctx: PersonalContext) {
  const rows = await db
    .select({ payload: knowledgeTable.payload })
    .from(knowledgeTable)
    .where(
      and(eq(knowledgeTable.tenantId, ctx.tenantId), eq(knowledgeTable.subjectId, ctx.subjectId)),
    )
    .orderBy(desc(knowledgeTable.version));
  const seenTopics = new Set<string>();
  const open: OpenProfileFeedback[] = [];
  for (const row of rows) {
    const record = recordFromRow(row);
    if (seenTopics.has(record.topic_key)) continue;
    seenTopics.add(record.topic_key);
    for (const item of record.feedback) {
      if (item.origin_topic_key && item.origin_topic_key !== record.topic_key) continue;
      if (!item.origin_topic_key && item.note.startsWith("受专题 ")) continue;
      if (item.kind !== "utility_feedback" && !item.resolved_at) {
        open.push({ topic_key: record.topic_key, item });
      }
    }
  }
  return open;
}

export function feedbackApplies(
  item: OpenProfileFeedback["item"],
  used: { claim_id: string; claim_revision_id: string; source_id: string; span_id: string },
) {
  return item.kind === "interpretation_disagreement"
    ? item.claim_ids.includes(used.claim_id) ||
        item.claim_revision_ids.includes(used.claim_revision_id)
    : item.claim_ids.includes(used.claim_id) ||
        item.claim_revision_ids.includes(used.claim_revision_id) ||
        item.source_ids.includes(used.source_id) ||
        item.span_ids.includes(used.span_id);
}

export function relevantProfileFeedback(
  open: OpenProfileFeedback[],
  evidence: Array<{
    claim_id: string;
    claim_revision_id: string;
    source_id: string;
    span_id: string;
  }>,
  topicKey: string,
) {
  return open.filter(({ topic_key, item }) => {
    if (topic_key === topicKey) return false;
    return evidence.some((used) => feedbackApplies(item, used));
  });
}

export function blockingDetails(open: OpenProfileFeedback[]) {
  return open.map(({ topic_key, item }) => ({
    topic_key,
    kind: item.kind,
    note: "其他专题中同一依据仍有未解决的本人纠正。",
    created_at: item.created_at,
    claim_ids: item.claim_ids,
    claim_revision_ids: item.claim_revision_ids,
    source_ids: item.source_ids,
    span_ids: item.span_ids,
  }));
}

export async function resolvePendingFeedback(
  db: KnowledgeDb,
  ctx: PersonalContext,
  feedback: KnowledgeProcessingRecord["feedback"],
  currentEvidence: KnowledgeClaimEvidence[],
) {
  const open = feedback.filter((item) => item.kind !== "utility_feedback" && !item.resolved_at);
  const revisionIds = union(open.flatMap((item) => item.claim_revision_ids));
  const dependencies = open.flatMap((item) => item.evidence_dependencies);
  const sourceIds = union(dependencies.map((item) => item.source_id));
  const spanIds = union(dependencies.map((item) => item.span_id));
  const depRevisionIds = union(dependencies.map((item) => item.claim_revision_id));
  const { oldById, sourceRows, spanRows, evidenceRows, replacementRows } =
    await readFeedbackDependencies(db, ctx, revisionIds, sourceIds, spanIds, depRevisionIds);
  const sourceById = new Map(sourceRows.map((item) => [item.id, item]));
  const spanById = new Map(spanRows.map((item) => [item.id, item]));
  const linkedKeys = new Set(evidenceRows.map((item) => `${item.claimRevisionId}:${item.spanId}`));
  const replacedIds = new Set(replacementRows.map((item) => item.targetId));
  const dependenciesInvalid = new Map<string, boolean>();
  for (const dep of dependencies) {
    const source = sourceById.get(dep.source_id);
    const span = spanById.get(dep.span_id);
    const invalid =
      !source ||
      source.usageStatus !== "active" ||
      source.eligibility !== "eligible" ||
      replacedIds.has(dep.source_id) ||
      !span ||
      span.sourceId !== dep.source_id ||
      span.authorKind !== "subject" ||
      !span.aboutSubject ||
      !linkedKeys.has(`${dep.claim_revision_id}:${dep.span_id}`);
    dependenciesInvalid.set(`${dep.claim_revision_id}:${dep.source_id}:${dep.span_id}`, invalid);
  }
  const now = new Date().toISOString();
  const nextFeedback = feedback.map((item) => {
    if (item.kind === "utility_feedback" || item.resolved_at) return item;
    const targets = item.claim_revision_ids;
    if (!targets.length) return item;
    const resolvedBy: string[] = [];
    const resolved = targets.every((id) => {
      const old = oldById.get(id);
      if (!old) return true;
      const replacement = currentEvidence.find(
        (candidate) => candidate.claimId === old.claimId && candidate.claimRevisionId !== id,
      );
      if (replacement) {
        resolvedBy.push(replacement.claimRevisionId);
        return true;
      }
      if (old.status !== "current" || old.evidenceStatus !== "valid") return true;
      // Source removal can settle a fact/temporal correction only when that exact claim
      // dependency was invalidated and the current scoped input no longer republishes it.
      const revisionDependencies = item.evidence_dependencies.filter(
        (dependency) => dependency.claim_revision_id === id,
      );
      if (
        (item.kind === "fact_correction" || item.kind === "temporal_change") &&
        revisionDependencies.length > 0 &&
        revisionDependencies.every(
          (dependency) =>
            dependenciesInvalid.get(`${id}:${dependency.source_id}:${dependency.span_id}`) === true,
        ) &&
        !currentEvidence.some((candidate) => candidate.claimRevisionId === id)
      ) {
        return true;
      }
      return false;
    });
    return resolved
      ? { ...item, resolved_at: now, resolved_by_revision_ids: union(resolvedBy) }
      : item;
  });
  return {
    feedback: nextFeedback,
    unresolved: nextFeedback.filter(
      (item) => item.kind !== "utility_feedback" && !item.resolved_at,
    ),
  };
}

export async function applyProfileBlockers(
  db: KnowledgeDb,
  ctx: PersonalContext,
  view: KnowledgeProcessingRecord,
) {
  const evidence = snapshotEvidence(view);
  if (!evidence.length) return view;
  const open = relevantProfileFeedback(
    await openProfileFeedback(db, ctx),
    evidence,
    view.topic_key,
  );
  if (!open.length) return { ...view, blocking_feedback: [] };
  const blocked = new Set(
    evidence
      .filter((used) => open.some(({ item }) => feedbackApplies(item, used)))
      .map((used) => used.claim_revision_id),
  );
  return {
    ...view,
    pending_review: true,
    blocking_feedback: blockingDetails(open),
    result: view.result
      ? {
          ...view.result,
          status: "needs_review" as const,
          summary: "本专题部分依据在其他专题收到未解决的本人纠正；相关判断待复核。",
          findings: view.result.findings.filter(
            (finding) => !blocked.has(finding.claim_revision_id),
          ),
          gaps: union([...view.result.gaps, "共用来源或认识有未解决的本人纠正。"]),
        }
      : null,
  };
}
