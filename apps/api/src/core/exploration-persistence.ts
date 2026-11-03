import type { ClaimDraft, UnderstandingDraft } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import { CoreError } from "./errors.js";
import { localClaimKey } from "./exploration-context.js";
import { loadExploration } from "./exploration-reading.js";
import type { EvidenceRow, PersonalContext } from "./exploration-types.js";

export async function bumpExplorationVersion(
  db: Pick<Db, "select" | "update">,
  ctx: PersonalContext,
  explorationId: string,
  expectedVersion: number,
) {
  const [updated] = await db
    .update(coreSchema.explorations)
    .set({
      version: expectedVersion + 1,
      lastActivityAt: new Date(),
    })
    .where(
      and(
        eq(coreSchema.explorations.id, explorationId),
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
        eq(coreSchema.explorations.status, "active"),
        eq(coreSchema.explorations.version, expectedVersion),
      ),
    )
    .returning({ version: coreSchema.explorations.version });

  if (updated) return updated.version;

  const current = await loadExploration(db, ctx, explorationId);
  throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
    current_version: current.version,
  });
}

export async function createSource(
  db: Pick<Db, "insert">,
  ctx: PersonalContext,
  args: {
    kind: string;
    content: string;
    occurredAt?: Date;
    meta?: Record<string, unknown>;
    contextCompleteness?: "sufficient" | "partial" | "thin" | "unknown";
  },
) {
  const [source] = await db
    .insert(coreSchema.sourceItems)
    .values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      sourceKind: args.kind,
      authorKind: "subject",
      content: args.content,
      occurredAt: args.occurredAt,
      sourceMeta: args.meta ?? {},
    })
    .returning();
  if (!source) throw new Error("source_create_failed");

  await db.insert(coreSchema.sourceAssessments).values({
    sourceItemId: source.id,
    version: 1,
    attributionStatus: "confirmed_subject",
    contextCompleteness: args.contextCompleteness ?? "partial",
    temporalPrecision: args.occurredAt ? "exact" : "unknown",
    eligibility: "eligible",
    rationale: "用户在 FindMe 原生探索中直接提供。",
  });

  const [span] = await db
    .insert(coreSchema.evidenceSpans)
    .values({
      sourceItemId: source.id,
      quote: args.content,
      locator: { whole_source: true },
      authorKind: "subject",
      aboutSubject: true,
    })
    .returning();
  if (!span) throw new Error("evidence_span_create_failed");
  return { source, span };
}

export async function replaceGaps(
  db: Pick<Db, "insert" | "update">,
  explorationId: string,
  draft: UnderstandingDraft,
) {
  await db
    .update(coreSchema.knowledgeGaps)
    .set({ status: "superseded", resolvedAt: new Date() })
    .where(
      and(
        eq(coreSchema.knowledgeGaps.explorationId, explorationId),
        eq(coreSchema.knowledgeGaps.status, "open"),
      ),
    );

  if (draft.gaps.length) {
    await db.insert(coreSchema.knowledgeGaps).values(
      draft.gaps.map((gap) => ({
        explorationId,
        gapKey: `${gap.key}:${crypto.randomUUID()}`,
        question: gap.question,
        whyItMatters: gap.why_it_matters,
      })),
    );
  }
}

export async function persistClaimRevision(
  db: Pick<Db, "insert" | "select" | "update">,
  ctx: PersonalContext,
  explorationId: string,
  experienceId: string,
  draft: ClaimDraft,
  rows: EvidenceRow[],
  revisionReason?: string,
) {
  const claimKey = localClaimKey(explorationId, draft.key);
  let [claim] = await db
    .select()
    .from(coreSchema.claims)
    .where(
      and(eq(coreSchema.claims.subjectId, ctx.subjectId), eq(coreSchema.claims.claimKey, claimKey)),
    )
    .limit(1);

  if (!claim) {
    [claim] = await db
      .insert(coreSchema.claims)
      .values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        claimKey,
        claimKind: draft.kind,
      })
      .returning();
  }
  if (!claim) throw new Error("claim_create_failed");

  const [current] = await db
    .select()
    .from(coreSchema.claimRevisions)
    .where(
      and(
        eq(coreSchema.claimRevisions.claimId, claim.id),
        eq(coreSchema.claimRevisions.status, "current"),
      ),
    )
    .orderBy(desc(coreSchema.claimRevisions.version))
    .limit(1);

  const nextVersion = (current?.version ?? 0) + 1;
  if (current) {
    await db
      .update(coreSchema.claimRevisions)
      .set({ status: "superseded" })
      .where(eq(coreSchema.claimRevisions.id, current.id));
  }
  const [revision] = await db
    .insert(coreSchema.claimRevisions)
    .values({
      claimId: claim.id,
      version: nextVersion,
      mode: draft.mode,
      text: draft.text,
      scope: draft.scope,
      status: "current",
      confidenceLevel: draft.confidence_level,
      confidenceBasis: draft.confidence_basis,
      revisionReason,
      supersedesRevisionId: current?.id,
    })
    .returning();
  if (!revision) throw new Error("claim_revision_create_failed");

  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const use of draft.evidence) {
    const row = byKey.get(use.evidence_key);
    if (!row) throw new Error(`evidence_missing:${use.evidence_key}`);
    await db.insert(coreSchema.claimEvidence).values({
      claimRevisionId: revision.id,
      evidenceSpanId: row.spanId,
      relation: use.relation,
      directness: use.directness,
      contribution: use.contribution,
      independenceGroup: row.independenceGroup ?? `experience:${experienceId}`,
      scopeMatch: use.scope_match,
      rationale: use.rationale,
    });
  }
  return { claim, revision };
}

export async function withdrawClaim(
  db: Pick<Db, "insert" | "select" | "update">,
  claimId: string,
  reason: string,
) {
  const [current] = await db
    .select()
    .from(coreSchema.claimRevisions)
    .where(
      and(
        eq(coreSchema.claimRevisions.claimId, claimId),
        eq(coreSchema.claimRevisions.status, "current"),
      ),
    )
    .orderBy(desc(coreSchema.claimRevisions.version))
    .limit(1);
  if (!current) return null;

  await db
    .update(coreSchema.claimRevisions)
    .set({ status: "superseded" })
    .where(eq(coreSchema.claimRevisions.id, current.id));

  const [withdrawn] = await db
    .insert(coreSchema.claimRevisions)
    .values({
      claimId,
      version: current.version + 1,
      mode: current.mode,
      text: current.text,
      scope: current.scope,
      status: "withdrawn",
      confidenceLevel: "low",
      confidenceBasis: "用户纠正后不再作为当前认识使用。",
      revisionReason: reason,
      supersedesRevisionId: current.id,
    })
    .returning();
  return withdrawn ?? null;
}
