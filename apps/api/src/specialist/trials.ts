import { type Db, coreSchema, specialistSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { digest } from "../shared/primitives.js";
import type { DecisionInput, ReviewInput } from "./contracts.js";
import { executionLabels, outcomeLabels } from "./policy.js";
import { ownedProposal, ownedTrial } from "./repository.js";
import { recordReviewSource } from "./review-source.js";
import { result } from "./types.js";
export async function transitionTrial(
  db: Db,
  ctx: PersonalContext,
  id: string,
  body: DecisionInput,
  action: "pause" | "resume",
) {
  const trial = await ownedTrial(db, ctx, id);
  if (!trial) return result({ error: "trial_not_found" }, 404);
  if (trial.version !== body.expected_version)
    return result({ error: "version_conflict", current_version: trial.version }, 409);
  if (action === "pause" && trial.status !== "active")
    return result({ error: "trial_not_active", status: trial.status }, 409);
  if (action === "resume" && trial.status !== "paused")
    return result({ error: "trial_not_paused", status: trial.status }, 409);
  const [updated] = await db
    .update(specialistSchema.specialistTrials)
    .set({ status: action === "pause" ? "paused" : "active", version: trial.version + 1 })
    .where(
      and(
        eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistTrials.id, trial.id),
        eq(specialistSchema.specialistTrials.version, body.expected_version),
      ),
    )
    .returning();
  return updated ? result({ trial: updated }) : result({ error: "version_conflict" }, 409);
}

export async function reviewTrial(db: Db, ctx: PersonalContext, id: string, body: ReviewInput) {
  const trial = await ownedTrial(db, ctx, id);
  if (!trial) return result({ error: "trial_not_found" }, 404);
  const selfReportText = [
    "本人行动尝试回顾",
    `执行情况：${executionLabels[body.execution]}。`,
    `实际作用：${outcomeLabels[body.outcome]}。`,
    ...(body.burden ? [`本人报告的负担：${body.burden}。`] : []),
    ...(body.observation ? [`本人记录的观察：${body.observation}`] : []),
    `后续选择：${body.continue_trial ? "继续尝试" : "结束本次尝试"}。`,
  ].join("\n");
  // The wording lives only in the review source; history keeps its hash for replay checks.
  const selfReportHash = digest(selfReportText);
  // A lost HTTP response must not append another personal source or feedback event.
  const lastReview = trial.reviewHistory.at(-1);
  if (
    trial.version === body.expected_version + 1 &&
    lastReview &&
    lastReview.prior_trial_version === body.expected_version &&
    lastReview.execution === body.execution &&
    lastReview.outcome === body.outcome &&
    lastReview.self_report_hash === selfReportHash &&
    lastReview.continue_trial === body.continue_trial &&
    lastReview.related_claim_revision_id === (body.related_claim_revision_id ?? null)
  ) {
    const [source] = await db
      .select()
      .from(coreSchema.sourceItems)
      .where(
        and(
          eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
          eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
          eq(coreSchema.sourceItems.id, String(lastReview.source_id)),
        ),
      )
      .limit(1);
    return result({ trial, source, replayed: true, topic_linkage: "pending_user_selection" });
  }
  if (trial.version !== body.expected_version)
    return result({ error: "version_conflict", current_version: trial.version }, 409);
  if (trial.status === "completed") return result({ error: "trial_completed" }, 409);
  const [relatedClaim] = body.related_claim_revision_id
    ? await db
        .select({ id: coreSchema.claimRevisions.id })
        .from(coreSchema.claimRevisions)
        .innerJoin(coreSchema.claims, eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id))
        .where(
          and(
            eq(coreSchema.claims.tenantId, ctx.tenantId),
            eq(coreSchema.claims.subjectId, ctx.subjectId),
            eq(coreSchema.claimRevisions.id, body.related_claim_revision_id),
            eq(coreSchema.claimRevisions.status, "current"),
          ),
        )
        .limit(1)
    : [];
  if (body.related_claim_revision_id && !relatedClaim)
    return result({ error: "related_claim_not_found" }, 404);
  const now = new Date();
  const reviewVersion = trial.version + 1;
  const saved = await db.transaction(async (tx) => {
    const [lockedTrial] = await tx
      .select()
      .from(specialistSchema.specialistTrials)
      .where(
        and(
          eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
          eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
          eq(specialistSchema.specialistTrials.id, trial.id),
        ),
      )
      .limit(1)
      .for("update");
    if (!lockedTrial || lockedTrial.version !== body.expected_version) return null;
    if (lockedTrial.status === "completed") throw new Error("ACTION_TRIAL_ALREADY_COMPLETED");
    const source = await recordReviewSource(
      tx as unknown as Db,
      ctx,
      lockedTrial,
      body,
      selfReportText,
      now,
      relatedClaim?.id ?? null,
    );
    if (relatedClaim) {
      await tx.insert(coreSchema.feedbackEvents).values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        targetType: "claim_revision",
        targetId: relatedClaim.id,
        feedbackType: "action_trial_outcome",
        note: `本人将行动回顾与这条认识关联；执行：${executionLabels[body.execution]}，作用：${outcomeLabels[body.outcome]}。`,
        sourceItemId: source.id,
      });
      if (body.execution === "completed" || body.execution === "partly_executed") {
        await tx
          .update(coreSchema.claimRevisions)
          .set({
            evidenceStatus: "stale",
            invalidatedAt: now,
            invalidationReason: "action_trial_outcome_needs_review",
          })
          .where(
            and(
              eq(coreSchema.claimRevisions.id, relatedClaim.id),
              eq(coreSchema.claimRevisions.status, "current"),
              eq(coreSchema.claimRevisions.evidenceStatus, "valid"),
            ),
          );
      }
    }
    const review = {
      prior_trial_version: lockedTrial.version,
      execution: body.execution,
      outcome: body.outcome,
      self_report_hash: selfReportHash,
      continue_trial: body.continue_trial,
      reviewed_at: now.toISOString(),
      source_id: source.id,
      source_assessment_version: 1,
      related_claim_revision_id: relatedClaim?.id ?? null,
      topic_linkage: "pending_user_selection",
    };
    const [updated] = await tx
      .update(specialistSchema.specialistTrials)
      .set({
        status: body.continue_trial ? "active" : "completed",
        version: reviewVersion,
        latestExecution: body.execution,
        latestOutcome: body.outcome,
        continueTrial: body.continue_trial ? "yes" : "no",
        reviewedAt: now,
        reviewHistory: [...trial.reviewHistory, review],
      })
      .where(
        and(
          eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
          eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
          eq(specialistSchema.specialistTrials.id, trial.id),
          eq(specialistSchema.specialistTrials.version, body.expected_version),
        ),
      )
      .returning();
    if (!updated) throw new Error("ACTION_TRIAL_REVIEW_VERSION_CONFLICT");
    return { trial: updated, source };
  });
  return saved
    ? result({ ...saved, topic_linkage: "pending_user_selection" })
    : result({ error: "version_conflict" }, 409);
}

export async function getTrial(db: Db, ctx: PersonalContext, id: string) {
  const trial = await ownedTrial(db, ctx, id);
  if (!trial) return result({ error: "trial_not_found" }, 404);
  const proposal = await ownedProposal(db, ctx, trial.proposalId);
  const reviewSourceIds = trial.reviewHistory
    .map((review) => review.source_id)
    .filter((sourceId): sourceId is string => typeof sourceId === "string");
  const reviewSources = reviewSourceIds.length
    ? await db
        .select()
        .from(coreSchema.sourceItems)
        .where(
          and(
            eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
            eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
            inArray(coreSchema.sourceItems.id, reviewSourceIds),
          ),
        )
    : [];
  return result({
    trial,
    proposal,
    review_sources: reviewSources,
    topic_linkage: "pending_user_selection",
  });
}
