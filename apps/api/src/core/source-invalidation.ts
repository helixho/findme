import { type Db, coreSchema } from "@findme/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PersonalContext } from "./exploration-service.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Lock explorations before source/assessment rows, matching native amendment and
 * publication order. Call before changing a source, then recheck its current version.
 */
export async function lockCoreSourceExplorations(
  tx: Transaction,
  ctx: PersonalContext,
  sourceIds: string[],
) {
  if (!sourceIds.length) return;
  await tx
    .select({ id: coreSchema.explorations.id })
    .from(coreSchema.explorations)
    .where(
      and(
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
        inArray(
          coreSchema.explorations.experienceId,
          tx
            .select({ id: coreSchema.experienceEvidence.experienceId })
            .from(coreSchema.experienceEvidence)
            .innerJoin(
              coreSchema.evidenceSpans,
              eq(coreSchema.evidenceSpans.id, coreSchema.experienceEvidence.evidenceSpanId),
            )
            .innerJoin(
              coreSchema.sourceItems,
              eq(coreSchema.sourceItems.id, coreSchema.evidenceSpans.sourceItemId),
            )
            .where(
              and(
                inArray(coreSchema.sourceItems.id, sourceIds),
                eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
                eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
              ),
            ),
        ),
      ),
    )
    .orderBy(coreSchema.explorations.id)
    .for("update");
}

/** Recompute evidence validity after a saved source change. Never erase text,
 * resurrect historical revisions, inherit replacement qualifications, or call a model.
 * Both native assessment and account source lifecycle use this within their transaction.
 */
export async function invalidateCoreSourceUnderstanding(
  tx: Transaction,
  ctx: PersonalContext,
  sourceIds: string[],
  reason: string,
) {
  if (!sourceIds.length)
    return {
      affected_claim_revision_ids: [],
      stale_claims: 0,
      invalid_claims: 0,
      affected_exploration_ids: [],
    };
  const spans = await tx
    .select({ id: coreSchema.evidenceSpans.id })
    .from(coreSchema.evidenceSpans)
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.sourceItems.id, coreSchema.evidenceSpans.sourceItemId),
    )
    .where(
      and(
        inArray(coreSchema.sourceItems.id, sourceIds),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    );
  const spanIds = spans.map((row) => row.id);

  const affectedExplorationIds = new Set<string>();
  if (spanIds.length > 0) {
    const rows = await tx
      .select({
        id: coreSchema.explorations.id,
        status: coreSchema.explorations.status,
      })
      .from(coreSchema.explorations)
      .innerJoin(
        coreSchema.experienceEvidence,
        eq(coreSchema.explorations.experienceId, coreSchema.experienceEvidence.experienceId),
      )
      .where(
        and(
          inArray(coreSchema.experienceEvidence.evidenceSpanId, spanIds),
          eq(coreSchema.explorations.tenantId, ctx.tenantId),
          eq(coreSchema.explorations.subjectId, ctx.subjectId),
        ),
      )
      .orderBy(coreSchema.explorations.id);

    for (const row of rows) {
      if (affectedExplorationIds.has(row.id)) continue;
      affectedExplorationIds.add(row.id);
      if (row.status === "active") {
        await tx
          .update(coreSchema.explorations)
          .set({
            version: sql`${coreSchema.explorations.version} + 1`,
            lastActivityAt: new Date(),
          })
          .where(eq(coreSchema.explorations.id, row.id));
      }
    }
  }

  const affectedRevisionIds = new Set<string>();
  if (spanIds.length > 0) {
    const links = await tx
      .select({ claimRevisionId: coreSchema.claimEvidence.claimRevisionId })
      .from(coreSchema.claimEvidence)
      .where(inArray(coreSchema.claimEvidence.evidenceSpanId, spanIds));
    for (const link of links) affectedRevisionIds.add(link.claimRevisionId);
  }

  let staleCount = 0;
  let invalidCount = 0;
  const affectedCurrentRevisionIds: string[] = [];
  for (const revisionId of affectedRevisionIds) {
    const [revision] = await tx
      .select()
      .from(coreSchema.claimRevisions)
      .where(
        and(
          eq(coreSchema.claimRevisions.id, revisionId),
          eq(coreSchema.claimRevisions.status, "current"),
          inArray(
            coreSchema.claimRevisions.claimId,
            tx
              .select({ id: coreSchema.claims.id })
              .from(coreSchema.claims)
              .where(
                and(
                  eq(coreSchema.claims.tenantId, ctx.tenantId),
                  eq(coreSchema.claims.subjectId, ctx.subjectId),
                ),
              ),
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!revision) continue;

    const supportRows = await tx
      .select({
        relation: coreSchema.claimEvidence.relation,
        eligibility: coreSchema.sourceAssessments.eligibility,
        usageStatus: coreSchema.sourceItems.usageStatus,
      })
      .from(coreSchema.claimEvidence)
      .innerJoin(
        coreSchema.evidenceSpans,
        eq(coreSchema.claimEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
      )
      .innerJoin(
        coreSchema.sourceItems,
        eq(coreSchema.sourceItems.id, coreSchema.evidenceSpans.sourceItemId),
      )
      .innerJoin(
        coreSchema.sourceAssessments,
        and(
          eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.evidenceSpans.sourceItemId),
          eq(coreSchema.sourceAssessments.isCurrent, true),
        ),
      )
      .where(eq(coreSchema.claimEvidence.claimRevisionId, revision.id));

    const hasEligibleSupport = supportRows.some(
      (row) =>
        row.relation === "supports" &&
        row.eligibility === "eligible" &&
        row.usageStatus === "active",
    );
    const evidenceStatus = hasEligibleSupport ? "stale" : "invalid";
    await tx
      .update(coreSchema.claimRevisions)
      .set({
        evidenceStatus,
        invalidatedAt: new Date(),
        invalidationReason: reason,
      })
      .where(eq(coreSchema.claimRevisions.id, revision.id));
    affectedCurrentRevisionIds.push(revision.id);
    if (evidenceStatus === "stale") staleCount += 1;
    else invalidCount += 1;
  }

  return {
    affected_claim_revision_ids: affectedCurrentRevisionIds,
    stale_claims: staleCount,
    invalid_claims: invalidCount,
    affected_exploration_ids: [...affectedExplorationIds],
  };
}
