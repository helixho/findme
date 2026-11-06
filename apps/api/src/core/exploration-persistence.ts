import type { ClaimDraft, UnderstandingDraft } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { CoreError } from "./errors.js";
import { localClaimKey } from "./exploration-context.js";
import { loadExploration } from "./exploration-reading.js";
import type { EvidenceRow, PersonalContext } from "./exploration-types.js";

export async function bumpExplorationVersion(
  db: Pick<Db, "select" | "update">,
  ctx: PersonalContext,
  explorationId: string,
  expectedVersion: number,
  /** Continuing the owner's saved input reopens a finished conversation. */
  options: { reopen?: boolean } = {},
) {
  const [updated] = await db
    .update(coreSchema.explorations)
    .set({
      version: expectedVersion + 1,
      lastActivityAt: new Date(),
      ...(options.reopen ? { status: "active", completedAt: null } : {}),
    })
    .where(
      and(
        eq(coreSchema.explorations.id, explorationId),
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
        ...(options.reopen ? [] : [eq(coreSchema.explorations.status, "active")]),
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

/** Unknown scope never becomes a global instruction. This recognizes direct scope declarations,
 * not personality or preferences inferred from behaviour. Other clear wording remains local. */
export function explicitDefaultPreferenceScope(
  original: string,
  source: string,
  scopeQuote?: string,
) {
  if (!scopeQuote || original.trim() !== source.trim() || !original.includes(scopeQuote))
    return false;
  return (
    /^(?:以后|今后|从现在起)(?:的)?(?:所有|每次|每个)(?:对话|交流|回答|提问)[，,：:\s]*(?:请|我希望|我要求)/u.test(
      original.trim(),
    ) && /^(?:以后|今后|从现在起)(?:的)?(?:所有|每次|每个)(?:对话|交流|回答|提问)/u.test(scopeQuote)
  );
}

export function explicitTurnPreferenceScope(original: string) {
  return /^(?:(?:请|我希望|我要求)[，,：:\s]*)?(?:本轮|这一轮|本次回答|这次回答|这条回复)(?=[，,：:\s]|请|先|只|用|给|简短|详细)/u.test(
    original.trim(),
  );
}

async function interactionPreferenceDetails(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  explorationId: string,
  draft: ClaimDraft,
  rows: EvidenceRow[],
): Promise<Record<string, unknown>> {
  const preference = draft.interaction_preference;
  if (!preference) return {};
  const use = draft.evidence.find((item) => item.evidence_key === preference.evidence_key);
  const row = rows.find((item) => item.key === preference.evidence_key);
  if (
    draft.kind !== "value" ||
    draft.mode !== "self_report" ||
    !use ||
    use.relation !== "supports" ||
    use.directness !== "direct" ||
    !row ||
    row.authorKind !== "subject" ||
    row.attributionStatus !== "confirmed_subject" ||
    row.eligibility !== "eligible" ||
    row.assessmentVersion === null ||
    !row.quote.includes(preference.original_text)
  ) {
    throw new CoreError("REPLY_REJECTED", 422, "交互偏好需要本人直接表达及对应的合格原文依据");
  }
  // Recheck the actual source and assessment at publication, under the same locks as other evidence.
  const [source] = await db
    .select()
    .from(coreSchema.sourceItems)
    .where(
      and(
        eq(coreSchema.sourceItems.id, row.sourceItemId),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .for("share");
  const [assessment] = await db
    .select()
    .from(coreSchema.sourceAssessments)
    .where(
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, row.sourceItemId),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .for("share");
  if (
    !source ||
    source.usageStatus !== "active" ||
    source.authorKind !== "subject" ||
    !source.content.includes(preference.original_text) ||
    !assessment ||
    assessment.version !== row.assessmentVersion ||
    assessment.eligibility !== "eligible" ||
    assessment.attributionStatus !== "confirmed_subject"
  ) {
    throw new CoreError("SOURCE_NOT_ELIGIBLE", 409, "交互偏好的原文或归属已经变化");
  }
  const turnOnly =
    preference.scope.kind === "turn" || explicitTurnPreferenceScope(preference.original_text);
  const global =
    !turnOnly &&
    preference.scope.kind === "default" &&
    explicitDefaultPreferenceScope(
      preference.original_text,
      source.content,
      preference.scope_quote,
    );
  return {
    interaction_preference: {
      explicit: true,
      source_id: source.id,
      source_assessment_version: assessment.version,
      expressed_at: source.capturedAt.toISOString(),
      original_text: preference.original_text,
      scope: turnOnly
        ? { kind: "turn", id: source.id }
        : global
          ? { kind: "default", explicitlyLongTerm: true }
          : { kind: "conversation", id: explorationId },
      ...(global ? { scope_quote: preference.scope_quote } : {}),
      scope_resolution: turnOnly
        ? "turn"
        : global
          ? "explicit_default_request"
          : preference.scope.kind === "conversation"
            ? "conversation"
            : "unverified_scope_confined_to_conversation",
    },
  };
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
  const details = await interactionPreferenceDetails(db, ctx, explorationId, draft, rows);
  const storedPreference = details.interaction_preference as
    | { scope: { kind: string } }
    | undefined;
  const publishedScope = storedPreference
    ? storedPreference.scope.kind === "turn"
      ? "仅该条输入对应的这一轮回复"
      : storedPreference.scope.kind === "default"
        ? "本人明确指定的长期交流偏好；本次要求优先"
        : "限这段对话，具体条件以偏好原文为准"
    : draft.scope;
  const claimKey = localClaimKey(explorationId, draft.key);
  let [claim] = await db
    .select()
    .from(coreSchema.claims)
    .where(
      and(
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        eq(coreSchema.claims.claimKey, claimKey),
      ),
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

  const [latest] = await db
    .select()
    .from(coreSchema.claimRevisions)
    .where(eq(coreSchema.claimRevisions.claimId, claim.id))
    .orderBy(desc(coreSchema.claimRevisions.version))
    .limit(1);
  if (latest?.status === "withdrawn") {
    const supportedIds = draft.evidence.flatMap((use) => {
      const row = rows.find((item) => item.key === use.evidence_key);
      return use.relation === "supports" && row && row.eligibility === "eligible"
        ? [row.sourceItemId]
        : [];
    });
    const fresh = supportedIds.length
      ? await db
          .select({ id: coreSchema.sourceItems.id })
          .from(coreSchema.sourceItems)
          .where(
            and(
              inArray(coreSchema.sourceItems.id, supportedIds),
              eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
              eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
              eq(coreSchema.sourceItems.usageStatus, "active"),
              gt(coreSchema.sourceItems.capturedAt, latest.createdAt),
            ),
          )
          .limit(1)
          .for("share")
      : [];
    if (!fresh.length)
      throw new CoreError(
        "REPLY_REJECTED",
        422,
        "已停用认识需要停用之后的新支持材料，不能仅凭旧依据恢复",
      );
  }
  // Evidence locks precede claim locks. Recheck after any wait so a concurrent
  // update from another experience cannot make the next version collide.
  const expected = [
    ...new Map(
      [current, latest].filter((row) => row !== undefined).map((row) => [row.id, row]),
    ).values(),
  ];
  if (expected.length) {
    const locked = await db
      .select()
      .from(coreSchema.claimRevisions)
      .where(
        inArray(
          coreSchema.claimRevisions.id,
          expected.map((row) => row.id),
        ),
      )
      .orderBy(coreSchema.claimRevisions.id)
      .for("update");
    const [newest] = await db
      .select({ id: coreSchema.claimRevisions.id })
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.claimId, claim.id))
      .orderBy(desc(coreSchema.claimRevisions.version))
      .limit(1);
    if (
      newest?.id !== latest?.id ||
      expected.some((row) => {
        const now = locked.find((item) => item.id === row.id);
        return !now || now.version !== row.version || now.status !== row.status;
      })
    )
      throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");
  }
  const nextVersion = (latest?.version ?? 0) + 1;
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
      details,
      text: draft.text,
      scope: publishedScope,
      status: "current",
      confidenceLevel: draft.confidence_level,
      confidenceBasis: draft.confidence_basis,
      revisionReason,
      supersedesRevisionId: latest?.id,
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
