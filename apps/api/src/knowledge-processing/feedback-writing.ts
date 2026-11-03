import type { KnowledgeProcessingRecord } from "@findme/core";
import { KnowledgeFeedbackInput } from "@findme/core";
import { coreSchema } from "@findme/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { currentView } from "./current-view.js";
import { dependencyRows, snapshotEvidence, union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";
import { append, latest, lockProfileKnowledge } from "./repository.js";
import { listKnowledgeTopics } from "./topic-views.js";

export async function recordKnowledgeFeedback(
  db: KnowledgeDb,
  ctx: PersonalContext,
  rawInput: { expected_version: number; kind: string; note: string; claim_revision_ids: string[] },
  topicKey: string,
): Promise<KnowledgeProcessingRecord> {
  const input = KnowledgeFeedbackInput.parse(rawInput);
  await lockProfileKnowledge(db, ctx);
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      ctx.tenantId,
      ctx.subjectId,
      topicKey,
    ])}, 0))`,
  );
  const rawPrevious = await latest(db, ctx, topicKey);
  const previous = rawPrevious ? await currentView(db, ctx, rawPrevious) : undefined;
  if (!previous || previous.version !== input.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "专题版本已变化", {
      current_version: previous?.version ?? 0,
    });
  }
  const knownRevisions = new Set(previous.claim_revision_ids);
  if (input.claim_revision_ids.some((id) => !knownRevisions.has(id))) {
    throw new CoreError("FINDING_NOT_FOUND", 404, "反馈引用的认识版本不属于当前专题");
  }
  const invalidates = input.kind !== "utility_feedback";
  const targetRevisions = new Set(
    input.claim_revision_ids.length ? input.claim_revision_ids : previous.claim_revision_ids,
  );
  const previousEvidence = snapshotEvidence(previous, true);
  const targetEvidence = previousEvidence.filter((item) =>
    targetRevisions.has(item.claim_revision_id),
  );
  const targetLineageRows = targetRevisions.size
    ? await db
        .select({
          claimRevisionId: coreSchema.claimRevisions.id,
          claimId: coreSchema.claims.id,
        })
        .from(coreSchema.claimRevisions)
        .innerJoin(coreSchema.claims, eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id))
        .where(
          and(
            eq(coreSchema.claims.tenantId, ctx.tenantId),
            eq(coreSchema.claims.subjectId, ctx.subjectId),
            inArray(coreSchema.claimRevisions.id, [...targetRevisions]),
          ),
        )
    : [];
  const targetClaimIds = union(targetLineageRows.map((row) => row.claimId));
  const targetSourceIds = union(targetEvidence.map((item) => item.source_id));
  const targetSpanIds = union(targetEvidence.map((item) => item.span_id));
  const affectedTopics: string[] = [];
  const affectedOverviews: string[] = [];
  const dependentRecords: KnowledgeProcessingRecord[] = [];
  if (invalidates && targetRevisions.size) {
    for (const candidate of await listKnowledgeTopics(db, ctx)) {
      if (candidate.topic_key === topicKey) continue;
      const candidateEvidence = snapshotEvidence(candidate, true);
      const impactedEvidence = candidateEvidence.filter((item) => {
        if (input.kind === "interpretation_disagreement") {
          return (
            targetClaimIds.includes(item.claim_id) || targetRevisions.has(item.claim_revision_id)
          );
        }
        return targetSourceIds.includes(item.source_id) || targetSpanIds.includes(item.span_id);
      });
      if (!impactedEvidence.length) continue;
      const impactedClaimIds = union(impactedEvidence.map((item) => item.claim_id));
      const impactedRevisionIds = union(impactedEvidence.map((item) => item.claim_revision_id));
      const impactedSourceIds = union(impactedEvidence.map((item) => item.source_id));
      const impactedSpanIds = union(impactedEvidence.map((item) => item.span_id));
      const existingFindings = candidate.result?.findings ?? [];
      dependentRecords.push({
        ...candidate,
        version: candidate.version + 1,
        record_type: "feedback",
        result: candidate.result
          ? {
              ...candidate.result,
              status: "needs_review",
              summary: "依赖的个人认识收到纠正或变化反馈；此专题待复核。",
              findings: existingFindings.filter(
                (finding) => !impactedClaimIds.includes(finding.claim_id),
              ),
              gaps: [...candidate.result.gaps, `依赖认识收到反馈：${topicKey}。`],
            }
          : null,
        feedback: [
          ...candidate.feedback,
          {
            kind: input.kind as KnowledgeProcessingRecord["feedback"][number]["kind"],
            note: `受专题 ${topicKey} 的反馈影响：${input.note}`,
            origin_topic_key: topicKey,
            claim_ids: impactedClaimIds,
            claim_revision_ids: impactedRevisionIds,
            source_ids: impactedSourceIds,
            span_ids: impactedSpanIds,
            evidence_dependencies: dependencyRows(impactedEvidence),
            resolved_by_revision_ids: [],
            created_at: new Date().toISOString(),
          },
        ],
        pending_review: true,
        invalidated_dependencies: {
          claim_ids: union([...candidate.invalidated_dependencies.claim_ids, ...impactedClaimIds]),
          claim_revision_ids: union([
            ...candidate.invalidated_dependencies.claim_revision_ids,
            ...impactedRevisionIds,
          ]),
          source_ids: union([
            ...candidate.invalidated_dependencies.source_ids,
            ...impactedSourceIds,
          ]),
          span_ids: union([...candidate.invalidated_dependencies.span_ids, ...impactedSpanIds]),
          evidence: [
            ...candidate.invalidated_dependencies.evidence,
            ...dependencyRows(impactedEvidence),
          ],
        },
        affected_topics: [],
        affected_overviews: [],
        historical_result: candidate.historical_result ?? candidate.result,
        created_at: new Date().toISOString(),
      });
      if (candidate.topic_key === "personal_overview") affectedOverviews.push(candidate.topic_key);
      else affectedTopics.push(candidate.topic_key);
    }
  }
  const result = previous.result
    ? {
        ...previous.result,
        status: invalidates ? ("needs_review" as const) : previous.result.status,
        summary: invalidates
          ? "用户已提交纠正或变化反馈；此专题当前待复核，旧判断保留在历史版本中。"
          : previous.result.summary,
        findings: invalidates ? [] : previous.result.findings,
        gaps: invalidates
          ? [...previous.result.gaps, "已收到本人反馈，待重新核对固定范围及受影响认识。"]
          : previous.result.gaps,
      }
    : null;
  const createdAt = new Date().toISOString();
  const next: KnowledgeProcessingRecord = {
    ...previous,
    version: previous.version + 1,
    record_type: "feedback",
    result,
    feedback: [
      ...previous.feedback,
      {
        kind: input.kind as KnowledgeProcessingRecord["feedback"][number]["kind"],
        note: input.note,
        origin_topic_key: topicKey,
        claim_ids: targetClaimIds,
        claim_revision_ids: [...targetRevisions],
        source_ids: targetSourceIds,
        span_ids: targetSpanIds,
        evidence_dependencies: dependencyRows(targetEvidence),
        resolved_by_revision_ids: [],
        created_at: createdAt,
      },
    ],
    pending_review: previous.pending_review || invalidates,
    invalidated_dependencies: invalidates
      ? {
          claim_ids: union([...previous.invalidated_dependencies.claim_ids, ...targetClaimIds]),
          claim_revision_ids: union([
            ...previous.invalidated_dependencies.claim_revision_ids,
            ...targetRevisions,
          ]),
          source_ids: union([...previous.invalidated_dependencies.source_ids, ...targetSourceIds]),
          span_ids: union([...previous.invalidated_dependencies.span_ids, ...targetSpanIds]),
          evidence: [
            ...previous.invalidated_dependencies.evidence,
            ...dependencyRows(targetEvidence),
          ],
        }
      : previous.invalidated_dependencies,
    affected_topics: affectedTopics,
    affected_overviews: affectedOverviews,
    historical_result: invalidates
      ? (previous.historical_result ?? previous.result)
      : previous.historical_result,
    created_at: createdAt,
  };
  if (invalidates && !affectedOverviews.length) {
    next.result?.gaps.push("跨专题总览依赖未建或未关联到本次反馈，无法确认影响；未声称已传播。");
  }
  await append(db, ctx, next);
  for (const dependent of dependentRecords) await append(db, ctx, dependent);
  return next;
}
