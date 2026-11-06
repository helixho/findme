import { CorrectionType } from "@findme/core";
import { type Db, coreSchema as c } from "@findme/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "./exploration-types.js";

/** Existing correction types and imported disputes; agreement is never extra support. */
export const REASSESSMENT_FEEDBACK_TYPES = new Set<string>([
  ...CorrectionType.options,
  "disagreement",
  "correction",
]);

export async function currentRevisionFeedback(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  revisionIds: readonly string[],
  lock = false,
) {
  if (!revisionIds.length) return [];
  const query = db
    .select({
      id: c.feedbackEvents.id,
      type: c.feedbackEvents.feedbackType,
      createdAt: c.feedbackEvents.createdAt,
      revisionId: c.feedbackEvents.targetId,
      source: c.sourceItems,
      assessment: c.sourceAssessments,
    })
    .from(c.feedbackEvents)
    .innerJoin(c.sourceItems, eq(c.sourceItems.id, c.feedbackEvents.sourceItemId))
    .innerJoin(
      c.sourceAssessments,
      and(
        eq(c.sourceAssessments.sourceItemId, c.sourceItems.id),
        eq(c.sourceAssessments.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(c.feedbackEvents.tenantId, ctx.tenantId),
        eq(c.feedbackEvents.subjectId, ctx.subjectId),
        eq(c.feedbackEvents.targetType, "claim_revision"),
        inArray(c.feedbackEvents.targetId, [...revisionIds]),
        eq(c.sourceItems.tenantId, ctx.tenantId),
        eq(c.sourceItems.subjectId, ctx.subjectId),
        eq(c.sourceItems.usageStatus, "active"),
        eq(c.sourceItems.authorKind, "subject"),
        eq(c.sourceAssessments.attributionStatus, "confirmed_subject"),
        inArray(c.sourceAssessments.eligibility, ["eligible", "context_only"]),
      ),
    )
    .orderBy(desc(c.feedbackEvents.createdAt), c.feedbackEvents.id);
  return lock ? query.for("share") : query;
}

/** A pending objection affects use, not the stored truth/status of the original revision. */
export async function pendingFeedbackRevisionIds(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  revisionIds: readonly string[],
) {
  if (!revisionIds.length) return new Set<string>();
  const current = await db
    .select({ id: c.claimRevisions.id })
    .from(c.claimRevisions)
    .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
    .where(
      and(
        inArray(c.claimRevisions.id, [...revisionIds]),
        eq(c.claimRevisions.status, "current"),
        eq(c.claims.tenantId, ctx.tenantId),
        eq(c.claims.subjectId, ctx.subjectId),
      ),
    );
  const feedback = await currentRevisionFeedback(
    db,
    ctx,
    current.map((row) => row.id),
  );
  return new Set(
    feedback
      .filter((item) => REASSESSMENT_FEEDBACK_TYPES.has(item.type))
      .map((item) => item.revisionId),
  );
}
