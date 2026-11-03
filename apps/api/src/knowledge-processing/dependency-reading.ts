import { coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import type { KnowledgeDb } from "./repository.js";

export async function readCurrentDependencies(
  db: KnowledgeDb,
  ctx: PersonalContext,
  sourceIds: string[],
  spanIds: string[],
  revisionIds: string[],
) {
  const [sourceRows, spanRows, revisionRows, evidenceRows, replacements] = await Promise.all([
    sourceIds.length
      ? db
          .select({
            id: coreSchema.sourceItems.id,
            usageStatus: coreSchema.sourceItems.usageStatus,
            eligibility: coreSchema.sourceAssessments.eligibility,
          })
          .from(coreSchema.sourceItems)
          .leftJoin(
            coreSchema.sourceAssessments,
            and(
              eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
              eq(coreSchema.sourceAssessments.isCurrent, true),
            ),
          )
          .where(
            and(
              eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
              eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
              inArray(coreSchema.sourceItems.id, sourceIds),
            ),
          )
      : Promise.resolve([]),
    spanIds.length
      ? db
          .select({
            id: coreSchema.evidenceSpans.id,
            sourceId: coreSchema.evidenceSpans.sourceItemId,
            authorKind: coreSchema.evidenceSpans.authorKind,
            aboutSubject: coreSchema.evidenceSpans.aboutSubject,
          })
          .from(coreSchema.evidenceSpans)
          .innerJoin(
            coreSchema.sourceItems,
            eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
          )
          .where(
            and(
              eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
              eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
              inArray(coreSchema.evidenceSpans.id, spanIds),
            ),
          )
      : Promise.resolve([]),
    revisionIds.length
      ? db
          .select({
            id: coreSchema.claimRevisions.id,
            claimId: coreSchema.claims.id,
            status: coreSchema.claimRevisions.status,
            evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
          })
          .from(coreSchema.claimRevisions)
          .innerJoin(coreSchema.claims, eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id))
          .where(
            and(
              eq(coreSchema.claims.tenantId, ctx.tenantId),
              eq(coreSchema.claims.subjectId, ctx.subjectId),
              inArray(coreSchema.claimRevisions.id, revisionIds),
            ),
          )
      : Promise.resolve([]),
    revisionIds.length && spanIds.length
      ? db
          .select({
            claimRevisionId: coreSchema.claimEvidence.claimRevisionId,
            spanId: coreSchema.claimEvidence.evidenceSpanId,
            relation: coreSchema.claimEvidence.relation,
          })
          .from(coreSchema.claimEvidence)
          .where(
            and(
              inArray(coreSchema.claimEvidence.claimRevisionId, revisionIds),
              inArray(coreSchema.claimEvidence.evidenceSpanId, spanIds),
            ),
          )
      : Promise.resolve([]),
    sourceIds.length
      ? db
          .select({
            sourceId: coreSchema.sourceLinks.sourceItemId,
            targetId: coreSchema.sourceLinks.targetSourceItemId,
          })
          .from(coreSchema.sourceLinks)
          .where(
            and(
              inArray(coreSchema.sourceLinks.targetSourceItemId, sourceIds),
              inArray(coreSchema.sourceLinks.relation, ["corrects", "updates"]),
            ),
          )
      : Promise.resolve([]),
  ]);
  return { sourceRows, spanRows, revisionRows, evidenceRows, replacements };
}

export async function readFeedbackDependencies(
  db: KnowledgeDb,
  ctx: PersonalContext,
  revisionIds: string[],
  sourceIds: string[],
  spanIds: string[],
  depRevisionIds: string[],
) {
  const rows = revisionIds.length
    ? await db
        .select({
          id: coreSchema.claimRevisions.id,
          claimId: coreSchema.claims.id,
          status: coreSchema.claimRevisions.status,
          evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
        })
        .from(coreSchema.claimRevisions)
        .innerJoin(coreSchema.claims, eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id))
        .where(
          and(
            eq(coreSchema.claims.tenantId, ctx.tenantId),
            eq(coreSchema.claims.subjectId, ctx.subjectId),
            inArray(coreSchema.claimRevisions.id, revisionIds),
          ),
        )
    : [];
  const oldById = new Map(rows.map((row) => [row.id, row]));
  const [sourceRows, spanRows, evidenceRows, replacementRows] =
    sourceIds.length || spanIds.length
      ? await Promise.all([
          sourceIds.length
            ? db
                .select({
                  id: coreSchema.sourceItems.id,
                  usageStatus: coreSchema.sourceItems.usageStatus,
                  eligibility: coreSchema.sourceAssessments.eligibility,
                })
                .from(coreSchema.sourceItems)
                .leftJoin(
                  coreSchema.sourceAssessments,
                  and(
                    eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
                    eq(coreSchema.sourceAssessments.isCurrent, true),
                  ),
                )
                .where(
                  and(
                    eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
                    eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
                    inArray(coreSchema.sourceItems.id, sourceIds),
                  ),
                )
            : Promise.resolve([]),
          spanIds.length
            ? db
                .select({
                  id: coreSchema.evidenceSpans.id,
                  sourceId: coreSchema.evidenceSpans.sourceItemId,
                  authorKind: coreSchema.evidenceSpans.authorKind,
                  aboutSubject: coreSchema.evidenceSpans.aboutSubject,
                })
                .from(coreSchema.evidenceSpans)
                .innerJoin(
                  coreSchema.sourceItems,
                  eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
                )
                .where(
                  and(
                    eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
                    eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
                    inArray(coreSchema.evidenceSpans.id, spanIds),
                  ),
                )
            : Promise.resolve([]),
          spanIds.length && depRevisionIds.length
            ? db
                .select({
                  claimRevisionId: coreSchema.claimEvidence.claimRevisionId,
                  spanId: coreSchema.claimEvidence.evidenceSpanId,
                })
                .from(coreSchema.claimEvidence)
                .where(
                  and(
                    inArray(coreSchema.claimEvidence.claimRevisionId, depRevisionIds),
                    inArray(coreSchema.claimEvidence.evidenceSpanId, spanIds),
                  ),
                )
            : Promise.resolve([]),
          sourceIds.length
            ? db
                .select({ targetId: coreSchema.sourceLinks.targetSourceItemId })
                .from(coreSchema.sourceLinks)
                .where(
                  and(
                    inArray(coreSchema.sourceLinks.targetSourceItemId, sourceIds),
                    inArray(coreSchema.sourceLinks.relation, ["corrects", "updates"]),
                  ),
                )
            : Promise.resolve([]),
        ])
      : [[], [], [], []];
  return { oldById, sourceRows, spanRows, evidenceRows, replacementRows };
}
