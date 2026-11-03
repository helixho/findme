import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import { CoreError } from "./errors.js";
import { modelClaimKey } from "./exploration-context.js";
import type { EvidenceRow, PersonalContext } from "./exploration-types.js";

export async function loadExploration(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  explorationId: string,
) {
  const [row] = await db
    .select()
    .from(coreSchema.explorations)
    .where(
      and(
        eq(coreSchema.explorations.id, explorationId),
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("EXPLORATION_NOT_FOUND", 404, "探索不存在");
  return row;
}

export async function loadCurrentClaimRows(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  explorationId: string,
) {
  const rows = await db
    .select({
      claimId: coreSchema.claims.id,
      claimKey: coreSchema.claims.claimKey,
      claimKind: coreSchema.claims.claimKind,
      revisionId: coreSchema.claimRevisions.id,
      version: coreSchema.claimRevisions.version,
      mode: coreSchema.claimRevisions.mode,
      text: coreSchema.claimRevisions.text,
      scope: coreSchema.claimRevisions.scope,
      status: coreSchema.claimRevisions.status,
      evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
      confidenceLevel: coreSchema.claimRevisions.confidenceLevel,
      confidenceBasis: coreSchema.claimRevisions.confidenceBasis,
      invalidationReason: coreSchema.claimRevisions.invalidationReason,
      createdAt: coreSchema.claimRevisions.createdAt,
    })
    .from(coreSchema.claims)
    .innerJoin(
      coreSchema.claimRevisions,
      eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id),
    )
    .where(
      and(
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        eq(coreSchema.claimRevisions.status, "current"),
      ),
    )
    .orderBy(desc(coreSchema.claimRevisions.createdAt));

  return rows
    .filter((row) => row.claimKey.startsWith(`${explorationId}/`))
    .map((row) => ({
      ...row,
      key: modelClaimKey(explorationId, row.claimKey),
    }));
}

export async function hasWithdrawnClaim(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  explorationId: string,
) {
  const rows = await db
    .select({
      claimKey: coreSchema.claims.claimKey,
    })
    .from(coreSchema.claims)
    .innerJoin(
      coreSchema.claimRevisions,
      eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id),
    )
    .where(
      and(
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        eq(coreSchema.claimRevisions.status, "withdrawn"),
      ),
    );
  return rows.some((row) => row.claimKey.startsWith(`${explorationId}/`));
}

export async function loadOpenGaps(db: Pick<Db, "select">, explorationId: string) {
  return db
    .select()
    .from(coreSchema.knowledgeGaps)
    .where(
      and(
        eq(coreSchema.knowledgeGaps.explorationId, explorationId),
        eq(coreSchema.knowledgeGaps.status, "open"),
      ),
    )
    .orderBy(coreSchema.knowledgeGaps.createdAt);
}

export async function loadOpenQuestion(db: Pick<Db, "select">, explorationId: string) {
  const [question] = await db
    .select()
    .from(coreSchema.explorationQuestions)
    .where(
      and(
        eq(coreSchema.explorationQuestions.explorationId, explorationId),
        eq(coreSchema.explorationQuestions.status, "open"),
      ),
    )
    .limit(1);
  return question ?? null;
}

export async function loadExplorationSteps(db: Pick<Db, "select">, explorationId: string) {
  return db
    .select()
    .from(coreSchema.explorationSteps)
    .where(eq(coreSchema.explorationSteps.explorationId, explorationId))
    .orderBy(coreSchema.explorationSteps.sequence);
}

export async function buildEvidenceSet(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  experienceId: string,
): Promise<EvidenceRow[]> {
  const links = await db
    .select({
      spanId: coreSchema.evidenceSpans.id,
      sourceItemId: coreSchema.sourceItems.id,
      quote: coreSchema.evidenceSpans.quote,
      authorKind: coreSchema.evidenceSpans.authorKind,
      tenantId: coreSchema.sourceItems.tenantId,
    })
    .from(coreSchema.experienceEvidence)
    .innerJoin(
      coreSchema.evidenceSpans,
      eq(coreSchema.experienceEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
    )
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
    )
    .where(eq(coreSchema.experienceEvidence.experienceId, experienceId))
    .orderBy(coreSchema.evidenceSpans.createdAt);

  const eligible: EvidenceRow[] = [];
  for (const row of links) {
    if (row.tenantId !== ctx.tenantId) continue;
    const [assessment] = await db
      .select()
      .from(coreSchema.sourceAssessments)
      .where(
        and(
          eq(coreSchema.sourceAssessments.sourceItemId, row.sourceItemId),
          eq(coreSchema.sourceAssessments.isCurrent, true),
        ),
      )
      .limit(1);
    if (!assessment || assessment.eligibility !== "eligible") continue;
    eligible.push({
      key: `E${eligible.length + 1}`,
      spanId: row.spanId,
      sourceItemId: row.sourceItemId,
      quote: row.quote,
      authorKind: row.authorKind,
      eligibility: assessment.eligibility,
      assessmentVersion: assessment.version,
      attributionStatus: assessment.attributionStatus,
      contextCompleteness: assessment.contextCompleteness,
      temporalPrecision: assessment.temporalPrecision,
      assessmentRationale: assessment.rationale,
    });
  }
  return eligible;
}

export async function buildEvidenceView(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  experienceId: string,
) {
  const links = await db
    .select({
      spanId: coreSchema.evidenceSpans.id,
      sourceItemId: coreSchema.sourceItems.id,
      quote: coreSchema.evidenceSpans.quote,
      authorKind: coreSchema.evidenceSpans.authorKind,
      tenantId: coreSchema.sourceItems.tenantId,
      createdAt: coreSchema.evidenceSpans.createdAt,
    })
    .from(coreSchema.experienceEvidence)
    .innerJoin(
      coreSchema.evidenceSpans,
      eq(coreSchema.experienceEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
    )
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
    )
    .where(eq(coreSchema.experienceEvidence.experienceId, experienceId))
    .orderBy(coreSchema.evidenceSpans.createdAt);

  const result = [];
  for (const row of links) {
    if (row.tenantId !== ctx.tenantId) continue;
    const [assessment] = await db
      .select()
      .from(coreSchema.sourceAssessments)
      .where(
        and(
          eq(coreSchema.sourceAssessments.sourceItemId, row.sourceItemId),
          eq(coreSchema.sourceAssessments.isCurrent, true),
        ),
      )
      .limit(1);
    result.push({
      key: `E${result.length + 1}`,
      span_id: row.spanId,
      source_item_id: row.sourceItemId,
      quote: row.quote,
      author_kind: row.authorKind,
      eligibility: assessment?.eligibility ?? "needs_review",
      assessment_version: assessment?.version ?? null,
      attribution_status: assessment?.attributionStatus ?? "ambiguous",
      context_completeness: assessment?.contextCompleteness ?? "unknown",
      temporal_precision: assessment?.temporalPrecision ?? "unknown",
      assessment_rationale: assessment?.rationale ?? null,
    });
  }
  return result;
}
