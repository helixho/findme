import { CoreReportTarget } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { lockPiProfileState, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import {
  orderStoredConversationTurns,
  qualifyConversationSources,
} from "./conversation-context.js";
import { loadPendingInputs } from "./conversation.js";
import { PURPOSEFUL_EXPLORATION_POLICY } from "./epistemic-policy.js";
import { CoreError } from "./errors.js";
import { deriveExplorationPhase, hasPriorProcessing } from "./exploration-context.js";
import {
  buildEvidenceView,
  hasWithdrawnClaim,
  loadCurrentClaimRows,
  loadExploration,
  loadExplorationSteps,
  loadOpenGaps,
  loadOpenQuestion,
} from "./exploration-reading.js";
import type { PersonalContext } from "./exploration-types.js";
import { pendingFeedbackRevisionIds } from "./pending-feedback.js";

export async function getCurrentUnderstanding(db: Db, ctx: PersonalContext) {
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

  const pendingFeedback = await pendingFeedbackRevisionIds(
    db,
    ctx,
    rows.map((row) => row.revisionId),
  );
  const mapClaim = (row: (typeof rows)[number]) => ({
    claim_id: row.claimId,
    claim_revision_id: row.revisionId,
    key: row.claimKey,
    kind: row.claimKind,
    version: row.version,
    mode: row.mode,
    text: row.text,
    scope: row.scope,
    evidence_status: row.evidenceStatus,
    pending_feedback: pendingFeedback.has(row.revisionId),
    confidence_level: row.confidenceLevel,
    confidence_basis: row.confidenceBasis,
    invalidation_reason: row.invalidationReason,
    updated_at: row.createdAt,
  });

  const claims = rows
    .filter((row) => row.evidenceStatus === "valid" && !pendingFeedback.has(row.revisionId))
    .map(mapClaim);
  const needsReview = rows
    .filter((row) => row.evidenceStatus !== "valid" || pendingFeedback.has(row.revisionId))
    .map(mapClaim);
  const state = claims.length > 0 ? "current" : needsReview.length > 0 ? "needs_review" : "empty";

  return {
    state,
    claims,
    needs_review: needsReview,
  };
}

export async function getExplorationView(db: Db, ctx: PersonalContext, explorationId: string) {
  const exploration = await loadExploration(db, ctx, explorationId);
  const [experience] = await db
    .select()
    .from(coreSchema.experiences)
    .where(
      and(
        eq(coreSchema.experiences.id, exploration.experienceId),
        eq(coreSchema.experiences.tenantId, ctx.tenantId),
        eq(coreSchema.experiences.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!experience) throw new Error("experience_not_found");

  const [questions, turns, claims, gaps, evidence, openQuestion, hasWithdrawn, steps, pending] =
    await Promise.all([
      db
        .select()
        .from(coreSchema.explorationQuestions)
        .where(eq(coreSchema.explorationQuestions.explorationId, exploration.id))
        .orderBy(coreSchema.explorationQuestions.sequence),
      db
        .select()
        .from(coreSchema.explorationTurns)
        .where(eq(coreSchema.explorationTurns.explorationId, exploration.id))
        .orderBy(coreSchema.explorationTurns.createdAt, coreSchema.explorationTurns.id),
      loadCurrentClaimRows(db, ctx, exploration.id),
      loadOpenGaps(db, exploration.id),
      buildEvidenceView(db, ctx, exploration.experienceId),
      loadOpenQuestion(db, exploration.id),
      hasWithdrawnClaim(db, ctx, exploration.id),
      loadExplorationSteps(db, exploration.id),
      loadPendingInputs(db, ctx, exploration.id),
    ]);

  const validClaims = claims.filter(
    (claim) => claim.evidenceStatus === "valid" && !claim.pendingFeedback,
  );
  const needsReview = claims.filter(
    (claim) => claim.evidenceStatus !== "valid" || claim.pendingFeedback,
  );
  const phase = deriveExplorationPhase({
    status: exploration.status,
    openQuestion,
    claims,
    gaps,
    hasWithdrawn,
    priorProcessed: hasPriorProcessing(steps.at(-1), exploration.version),
  });
  const latestStep = steps.at(-1) ?? null;
  const outcome =
    validClaims.length > 0
      ? "provisional"
      : needsReview.length > 0
        ? null
        : gaps.length > 0
          ? "insufficient"
          : hasWithdrawn
            ? "withdrawn"
            : null;

  const mapClaim = (claim: (typeof claims)[number]) => ({
    claim_id: claim.claimId,
    claim_revision_id: claim.revisionId,
    key: claim.key,
    kind: claim.claimKind,
    version: claim.version,
    mode: claim.mode,
    text: claim.text,
    scope: claim.scope,
    evidence_status: claim.evidenceStatus,
    pending_feedback: claim.pendingFeedback,
    confidence_level: claim.confidenceLevel,
    confidence_basis: claim.confidenceBasis,
    invalidation_reason: claim.invalidationReason,
    updated_at: claim.createdAt,
  });

  return {
    id: exploration.id,
    report_target: exploration.ext?.report_target
      ? CoreReportTarget.parse(exploration.ext.report_target)
      : null,
    version: exploration.version,
    status: exploration.status,
    phase,
    parked: exploration.ext?.parked === true,
    pending,
    started_at: exploration.startedAt,
    last_activity_at: exploration.lastActivityAt,
    completed_at: exploration.completedAt,
    experience: {
      id: experience.id,
      summary: experience.summary,
      occurred_at: experience.occurredAt,
      context: experience.context,
    },
    open_question: openQuestion
      ? {
          id: openQuestion.id,
          sequence: openQuestion.sequence,
          question: openQuestion.question,
          intent: openQuestion.intent,
          quick_options: openQuestion.quickOptions ?? [],
        }
      : null,
    latest_step: latestStep
      ? {
          sequence: latestStep.sequence,
          current_reading: latestStep.currentReading,
          key_uncertainty: latestStep.keyUncertainty,
          decision: latestStep.decision,
          intent: latestStep.intent,
          stop_reason: latestStep.stopReason,
          decision_meta: latestStep.modelMeta ?? {},
        }
      : null,
    question_budget: {
      asked: questions.length,
      default_budget: PURPOSEFUL_EXPLORATION_POLICY.defaultQuestionBudget,
      hard_cap: PURPOSEFUL_EXPLORATION_POLICY.hardQuestionCap,
      policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
    },
    questions: questions.map((question) => ({
      id: question.id,
      sequence: question.sequence,
      status: question.status,
      question: question.question,
      intent: question.intent,
      quick_options: question.quickOptions ?? [],
      answered_at: question.answeredAt,
    })),
    turns: await orderStoredConversationTurns(db, ctx, turns),
    understanding: {
      outcome,
      claims: validClaims.map(mapClaim),
      gaps,
      needs_review: needsReview.map(mapClaim),
    },
    evidence,
  };
}

export async function listExplorations(
  db: Db,
  ctx: PersonalContext,
  args: { status?: "active" | "completed" | "abandoned"; limit?: number; offset?: number } = {},
) {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
  const offset = Math.max(0, args.offset ?? 0);
  const rows = await db
    .select({
      id: coreSchema.explorations.id,
      ext: coreSchema.explorations.ext,
      status: coreSchema.explorations.status,
      version: coreSchema.explorations.version,
      startedAt: coreSchema.explorations.startedAt,
      lastActivityAt: coreSchema.explorations.lastActivityAt,
      completedAt: coreSchema.explorations.completedAt,
      experienceId: coreSchema.experiences.id,
      summary: coreSchema.experiences.summary,
    })
    .from(coreSchema.explorations)
    .innerJoin(
      coreSchema.experiences,
      eq(coreSchema.explorations.experienceId, coreSchema.experiences.id),
    )
    .where(
      and(
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
        args.status ? eq(coreSchema.explorations.status, args.status) : undefined,
      ),
    )
    .orderBy(desc(coreSchema.explorations.lastActivityAt))
    .limit(limit)
    .offset(offset);

  const items = [];
  for (const row of rows) {
    const [openQuestion, claims, gaps, hasWithdrawn, steps] = await Promise.all([
      loadOpenQuestion(db, row.id),
      loadCurrentClaimRows(db, ctx, row.id),
      loadOpenGaps(db, row.id),
      hasWithdrawnClaim(db, ctx, row.id),
      loadExplorationSteps(db, row.id),
    ]);
    items.push({
      id: row.id,
      status: row.status,
      version: row.version,
      phase: deriveExplorationPhase({
        status: row.status,
        openQuestion,
        claims,
        gaps,
        hasWithdrawn,
        priorProcessed: hasPriorProcessing(steps.at(-1), row.version),
      }),
      started_at: row.startedAt,
      last_activity_at: row.lastActivityAt,
      completed_at: row.completedAt,
      experience_id: row.experienceId,
      summary: row.summary,
      parked: (row.ext as { parked?: unknown } | null)?.parked === true,
      key_uncertainty: steps.at(-1)?.keyUncertainty ?? null,
      open_question: openQuestion
        ? {
            id: openQuestion.id,
            sequence: openQuestion.sequence,
            question: openQuestion.question,
            intent: openQuestion.intent,
            quick_options: openQuestion.quickOptions ?? [],
          }
        : null,
    });
  }
  return { items };
}

/** The dependency set is a reading range, never statement-by-statement support. */
export async function getReplyMaterials(
  db: Db,
  ctx: PersonalContext,
  explorationId: string,
  replyTurnId: string,
  input: { cursor?: number; limit?: number; sourceId?: string; start?: number } = {},
) {
  const query = z
    .object({
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(8),
      sourceId: z.string().uuid().optional(),
      start: z.number().int().nonnegative().default(0),
    })
    .parse(input);
  return withProfileTransaction(db, ctx, async (tx) => {
    // Match source lifecycle's lock order so eligibility and returned text cannot
    // straddle an exclusion; this transaction contains no network/model call.
    await lockPiProfileState(tx, ctx);
    await loadExploration(tx as unknown as Db, ctx, explorationId);
    const [turn] = await tx
      .select({ id: coreSchema.explorationTurns.id })
      .from(coreSchema.explorationTurns)
      .where(
        and(
          eq(coreSchema.explorationTurns.id, replyTurnId),
          eq(coreSchema.explorationTurns.explorationId, explorationId),
          eq(coreSchema.explorationTurns.role, "assistant"),
          eq(coreSchema.explorationTurns.turnKind, "pi_reply"),
          sql`length(${coreSchema.explorationTurns.content}) > 0`,
        ),
      )
      .limit(1);
    if (!turn) throw new CoreError("NOT_FOUND", 404, "这条回应的参考材料暂不可用");
    const owners = await tx
      .select({ meta: coreSchema.sourceItems.sourceMeta })
      .from(coreSchema.sourceItems)
      .where(
        and(
          eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
          eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
          sql`${coreSchema.sourceItems.sourceMeta}->>'exploration_id'=${explorationId}`,
          sql`${coreSchema.sourceItems.sourceMeta}->'reply'->>'turn_id'=${replyTurnId}`,
        ),
      )
      .limit(2);
    const parsed = z
      .object({ engine: z.literal("pi"), source_ids: z.array(z.string().uuid()) })
      .safeParse(owners.length === 1 ? owners[0]?.meta?.reply : null);
    if (!parsed.success) throw new CoreError("NOT_FOUND", 404, "这条回应的参考材料暂不可用");
    const sourceIds = [...new Set(parsed.data.source_ids)];
    if (query.sourceId && !sourceIds.includes(query.sourceId))
      throw new CoreError("NOT_FOUND", 404, "这条回应没有对应材料");
    const pageIds = query.sourceId
      ? [query.sourceId]
      : sourceIds.slice(query.cursor, query.cursor + query.limit);
    const qualified = await qualifyConversationSources(tx as unknown as Db, ctx, pageIds, true);
    const sources = pageIds.length
      ? await tx
          .select({
            id: coreSchema.sourceItems.id,
            content: coreSchema.sourceItems.content,
            authorKind: coreSchema.sourceItems.authorKind,
            sourceKind: coreSchema.sourceItems.sourceKind,
            capturedAt: coreSchema.sourceItems.capturedAt,
            occurredAt: coreSchema.sourceItems.occurredAt,
          })
          .from(coreSchema.sourceItems)
          .where(
            and(
              eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
              eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
              inArray(coreSchema.sourceItems.id, pageIds),
            ),
          )
      : [];
    const items = pageIds.flatMap((id) => {
      const source = sources.find((source) => source.id === id);
      if (!source || !qualified.get(id)?.readable) return [];
      let start = Math.min(query.sourceId ? query.start : 0, source.content.length);
      if (
        start > 0 &&
        /[\uDC00-\uDFFF]/.test(source.content[start] ?? "") &&
        /[\uD800-\uDBFF]/.test(source.content[start - 1] ?? "")
      )
        start++;
      let end = Math.min(start + 2000, source.content.length);
      if (
        end < source.content.length &&
        /[\uD800-\uDBFF]/.test(source.content[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(source.content[end] ?? "")
      )
        end--;
      return [
        {
          source_id: source.id,
          author_kind: source.authorKind,
          source_kind: source.sourceKind,
          recorded_at: source.capturedAt,
          occurred_at: source.occurredAt,
          text: source.content.slice(start, end),
          start,
          end,
          next_text_offset: end < source.content.length ? end : null,
        },
      ];
    });
    return {
      reply_turn_id: replyTurnId,
      qualification: "reference_range_not_statement_support" as const,
      total_sources: sourceIds.length,
      unavailable_in_page: pageIds.length - items.length,
      items,
      next_cursor:
        !query.sourceId && query.cursor + query.limit < sourceIds.length
          ? query.cursor + query.limit
          : null,
    };
  });
}
