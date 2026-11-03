import type { KnowledgeProcessingRecord } from "@findme/core";
import { KnowledgeTopicProcessInput, buildKnowledgeTopicResult } from "@findme/core";
import { sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { currentView } from "./current-view.js";
import {
  blockingDetails,
  feedbackApplies,
  openProfileFeedback,
  relevantProfileFeedback,
  resolvePendingFeedback,
} from "./profile-feedback.js";
import { union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";
import { append, latest, lockProfileKnowledge } from "./repository.js";
import { canonicalKnowledgeValue } from "./snapshot.js";
import { readTopicBasis } from "./topic-evidence.js";
import { fingerprintTopicBasis } from "./topic-fingerprint.js";

export async function processKnowledgeTopic(
  db: KnowledgeDb,
  ctx: PersonalContext,
  rawInput: KnowledgeTopicProcessInput,
): Promise<KnowledgeProcessingRecord> {
  const input = KnowledgeTopicProcessInput.parse(rawInput);
  await lockProfileKnowledge(db, ctx);
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      ctx.tenantId,
      ctx.subjectId,
      input.topic_key,
    ])}, 0))`,
  );
  const rawPrevious = await latest(db, ctx, input.topic_key);
  const previous = rawPrevious ? await currentView(db, ctx, rawPrevious) : undefined;
  const expectedVersion = input.expected_version ?? 0;
  if ((previous?.version ?? 0) !== expectedVersion) {
    throw new CoreError("STALE_VERSION", 409, "专题版本已变化", {
      current_version: previous?.version ?? 0,
    });
  }

  const { sourceRows, spanRows, evidence, coverage } = await readTopicBasis(db, ctx, input);
  const result = buildKnowledgeTopicResult({
    topicKey: input.topic_key,
    title: input.title,
    question: input.question,
    evidence,
  });
  for (const source of sourceRows) {
    if (
      source.sourceKind === "action_trial_review" &&
      source.assessmentEligibility !== "eligible" &&
      !evidence.some((item) => item.sourceId === source.id)
    ) {
      result.gaps.push("有新的行动回顾来源待形成认识/复核；当前没有从该回顾推断个人特征。");
    }
  }
  const { sourceIds, spanIds, claimRevisionIds, fingerprint } = await fingerprintTopicBasis(input, {
    sourceRows,
    spanRows,
    evidence,
  });
  const feedbackState = await resolvePendingFeedback(db, ctx, previous?.feedback ?? [], evidence);
  const crossTopicFeedback = relevantProfileFeedback(
    await openProfileFeedback(db, ctx),
    evidence.map((item) => ({
      claim_id: item.claimId,
      claim_revision_id: item.claimRevisionId,
      source_id: item.sourceId,
      span_id: item.spanId,
    })),
    input.topic_key,
  );
  const pendingReview = feedbackState.unresolved.length > 0 || crossTopicFeedback.length > 0;
  if (pendingReview) {
    result.status = "needs_review";
    result.summary = "当前依据仍关联未解决的本人纠正；专题继续待复核。";
    const blockedRevisions = new Set(
      evidence
        .filter((item) =>
          crossTopicFeedback.some(({ item: feedback }) =>
            feedbackApplies(feedback, {
              claim_id: item.claimId,
              claim_revision_id: item.claimRevisionId,
              source_id: item.sourceId,
              span_id: item.spanId,
            }),
          ),
        )
        .map((item) => item.claimRevisionId),
    );
    result.findings = feedbackState.unresolved.length
      ? []
      : result.findings.filter((finding) => !blockedRevisions.has(finding.claim_revision_id));
    result.gaps.push(
      ...feedbackState.unresolved.map((item) => `待处理 ${item.kind} 反馈：${item.note}`),
      ...(crossTopicFeedback.length ? ["共用来源或认识仍有未解决的本人纠正。"] : []),
    );
  }
  const createdAt = new Date().toISOString();
  const next: KnowledgeProcessingRecord = {
    topic_key: input.topic_key,
    version: (previous?.version ?? 0) + 1,
    record_type: "topic_result",
    source_ids: sourceIds,
    span_ids: spanIds,
    claim_revision_ids: claimRevisionIds,
    basis_fingerprint: fingerprint,
    coverage,
    result,
    feedback: feedbackState.feedback,
    pending_review: pendingReview,
    blocking_feedback: blockingDetails(crossTopicFeedback),
    invalidated_dependencies: pendingReview
      ? {
          claim_ids: union(feedbackState.unresolved.flatMap((item) => item.claim_ids)),
          claim_revision_ids: union(
            feedbackState.unresolved.flatMap((item) => item.claim_revision_ids),
          ),
          source_ids: union(feedbackState.unresolved.flatMap((item) => item.source_ids)),
          span_ids: union(feedbackState.unresolved.flatMap((item) => item.span_ids)),
          evidence: feedbackState.unresolved.flatMap((item) => item.evidence_dependencies),
        }
      : { claim_ids: [], claim_revision_ids: [], source_ids: [], span_ids: [], evidence: [] },
    affected_topics: [],
    affected_overviews: [],
    historical_result: previous?.historical_result ?? previous?.result ?? null,
    created_at: createdAt,
  };
  if (previous && rawPrevious?.record_type === "topic_result") {
    const comparable = ({
      version: _version,
      created_at: _createdAt,
      historical_result: _history,
      ...value
    }: KnowledgeProcessingRecord) => value;
    if (
      canonicalKnowledgeValue(comparable(rawPrevious)) === canonicalKnowledgeValue(comparable(next))
    ) {
      return previous;
    }
  }
  return append(db, ctx, next);
}
