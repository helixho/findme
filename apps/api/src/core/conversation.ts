import { CorrectionInput } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { PURPOSEFUL_EXPLORATION_POLICY, inputFingerprint } from "./epistemic-policy.js";
import { CoreError } from "./errors.js";
import { jsonObject, modelClaimKey } from "./exploration-context.js";
import { bumpExplorationVersion, createSource, withdrawClaim } from "./exploration-persistence.js";
import { loadCurrentClaimRows, loadExploration, loadOpenQuestion } from "./exploration-reading.js";
import type { CoreStore, PersonalContext } from "./exploration-types.js";
import {
  CONVERSATION_REPLY_PROMPT_VERSION,
  ConversationReplySchema,
  type CoreGateway,
  OBSERVATION_MODEL_ROUTE,
  generateConversationReply,
} from "./llm.js";
import { completeCoreOperation, lockCoreOperation } from "./operations.js";
import {
  assertEvidenceUsable,
  loadPriorUnderstanding,
  priorContextText,
  priorSelectionMeta,
} from "./prior-understanding.js";

// Continuous use on the existing chain (AG-07a): every owner input is saved
// before any model work, an explicit "stop using" needs no model, and a
// conversation stays open after the explorer stops asking questions.

export const REPLY_VALIDATOR_VERSION = "conversation-reply-validator@v1";
const HISTORY_TURNS = 40;
const HISTORY_TURN_CHARS = 1500;

const Version = z.number().int().positive();

export const SaveCorrectionInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: Version,
  claim_revision_ids: z.array(z.string().uuid()).min(1),
  correction: CorrectionInput,
});
export const ProcessCorrectionInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: Version,
  correction_source_id: z.string().uuid(),
});
export const SaveMessageInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: Version,
  message: z.string().trim().min(1).max(5000),
});
export const ReplyInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: Version,
  message_source_id: z.string().uuid(),
});
export const ParkInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: Version,
  parked: z.boolean(),
});
export const WithdrawClaimInput = z.object({
  claim_revision_id: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
});

export const ConversationReplyDraft = ConversationReplySchema;
export type ConversationReplyDraft = z.infer<typeof ConversationReplyDraft>;

type SourceMeta = Record<string, unknown>;

/**
 * Version step for owner input on a matter that may be finished: the input
 * reopens it (status active), guarded by the expected version.
 */
async function reopenAndBump(
  tx: Db,
  ctx: PersonalContext,
  exploration: { id: string; ext: unknown },
  expectedVersion: number,
  unpark: boolean,
) {
  const ext = (exploration.ext ?? {}) as Record<string, unknown>;
  const [updated] = await tx
    .update(coreSchema.explorations)
    .set({
      version: expectedVersion + 1,
      status: "active",
      completedAt: null,
      lastActivityAt: new Date(),
      ...(unpark ? { ext: { ...ext, parked: false } } : {}),
    })
    .where(
      and(
        eq(coreSchema.explorations.id, exploration.id),
        eq(coreSchema.explorations.tenantId, ctx.tenantId),
        eq(coreSchema.explorations.subjectId, ctx.subjectId),
        eq(coreSchema.explorations.version, expectedVersion),
      ),
    )
    .returning({ version: coreSchema.explorations.version });
  if (!updated)
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: (await loadExploration(tx, ctx, exploration.id)).version,
    });
  return updated.version;
}

/** Saved correction: kept as the owner's words even when processing later fails. */
export async function saveCorrectionTx(
  tx: Db,
  ctx: PersonalContext,
  input: z.infer<typeof SaveCorrectionInput>,
  extraMeta: SourceMeta = {},
) {
  const exploration = await loadExploration(tx, ctx, input.exploration_id);
  const targets = await tx
    .select({
      id: coreSchema.claimRevisions.id,
      status: coreSchema.claimRevisions.status,
      claimKey: coreSchema.claims.claimKey,
      tenantId: coreSchema.claims.tenantId,
      subjectId: coreSchema.claims.subjectId,
    })
    .from(coreSchema.claimRevisions)
    .innerJoin(coreSchema.claims, eq(coreSchema.claims.id, coreSchema.claimRevisions.claimId))
    .where(inArray(coreSchema.claimRevisions.id, input.claim_revision_ids));
  if (
    targets.length !== input.claim_revision_ids.length ||
    targets.some(
      (row) =>
        row.status !== "current" ||
        row.tenantId !== ctx.tenantId ||
        row.subjectId !== ctx.subjectId ||
        !row.claimKey.startsWith(`${exploration.id}/`),
    )
  )
    throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");

  // A finished matter shown again can be corrected directly; the input reopens it.
  const nextVersion = await reopenAndBump(tx, ctx, exploration, input.expected_version, false);
  const { source, span } = await createSource(tx, ctx, {
    kind: "guided_response",
    content: input.correction.note,
    meta: {
      exploration_id: exploration.id,
      correction_type: input.correction.type,
      claim_revision_ids: input.claim_revision_ids,
      correction_status: "pending",
      ...extraMeta,
    },
    contextCompleteness: "partial",
  });
  await tx.insert(coreSchema.experienceEvidence).values({
    experienceId: exploration.experienceId,
    evidenceSpanId: span.id,
    relation: "describes",
  });
  await tx.insert(coreSchema.explorationTurns).values({
    explorationId: exploration.id,
    sourceItemId: source.id,
    role: "user",
    turnKind: "correction",
    content: input.correction.note,
  });
  for (const targetId of input.claim_revision_ids) {
    await tx.insert(coreSchema.feedbackEvents).values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      explorationId: exploration.id,
      targetType: "claim_revision",
      targetId,
      feedbackType: input.correction.type,
      note: input.correction.note,
      sourceItemId: source.id,
    });
  }
  return { exploration, version: nextVersion, sourceId: source.id };
}

export async function saveCorrection(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = SaveCorrectionInput.parse(input);
  return db.transaction(async (tx) => {
    const saved = await saveCorrectionTx(tx as unknown as Db, ctx, parsed);
    const response = jsonObject({
      exploration_id: saved.exploration.id,
      version: saved.version,
      correction_source_id: saved.sourceId,
      status: "pending",
      saved: true,
    });
    if (operationId) await completeCoreOperation(tx, operationId, 201, response);
    return response;
  });
}

export const ClaimCorrectionInput = z.object({
  claim_revision_id: z.string().uuid(),
  correction: CorrectionInput,
});

/**
 * Correct one judgement from any view (topic, full list) through the same
 * save-first flow as the conversation it came from, so every view reads the
 * same state afterwards.
 */
export async function saveClaimCorrection(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = ClaimCorrectionInput.parse(input);
  const [claim] = await db
    .select({ claimKey: coreSchema.claims.claimKey })
    .from(coreSchema.claimRevisions)
    .innerJoin(coreSchema.claims, eq(coreSchema.claims.id, coreSchema.claimRevisions.claimId))
    .where(
      and(
        eq(coreSchema.claimRevisions.id, parsed.claim_revision_id),
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!claim) throw new CoreError("CLAIM_NOT_FOUND", 404, "认识不存在");
  const explorationId = claim.claimKey.split("/")[0] ?? "";
  if (!/^[0-9a-f-]{36}$/.test(explorationId))
    throw new CoreError("CLAIM_NOT_FOUND", 404, "这条认识没有可以纠正的来源对话");
  const exploration = await loadExploration(db, ctx, explorationId);
  return saveCorrection(
    db,
    ctx,
    {
      exploration_id: exploration.id,
      expected_version: exploration.version,
      claim_revision_ids: [parsed.claim_revision_id],
      correction: parsed.correction,
    },
    operationId,
  );
}

/** Free follow-up in the same matter; reopens a finished conversation. */
export async function saveExplorationMessage(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = SaveMessageInput.parse(input);
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version)
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  if (await loadOpenQuestion(db, exploration.id))
    throw new CoreError("QUESTION_NOT_OPEN", 409, "当前还有一个待回答的问题");

  return db.transaction(async (tx) => {
    const version = await reopenAndBump(
      tx as unknown as Db,
      ctx,
      exploration,
      parsed.expected_version,
      true,
    );

    const { source, span } = await createSource(tx, ctx, {
      kind: "conversation_message",
      content: parsed.message,
      meta: { exploration_id: exploration.id, reply_status: "pending" },
      contextCompleteness: "partial",
    });
    await tx.insert(coreSchema.experienceEvidence).values({
      experienceId: exploration.experienceId,
      evidenceSpanId: span.id,
      relation: "describes",
    });
    await tx.insert(coreSchema.explorationTurns).values({
      explorationId: exploration.id,
      sourceItemId: source.id,
      role: "user",
      turnKind: "message",
      content: parsed.message,
    });
    const response = jsonObject({
      exploration_id: exploration.id,
      version,
      message_source_id: source.id,
      status: "pending",
      saved: true,
    });
    if (operationId) await completeCoreOperation(tx, operationId, 201, response);
    return response;
  });
}

export async function setExplorationParked(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = ParkInput.parse(input);
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  return db.transaction(async (tx) => {
    const version = await bumpExplorationVersion(tx, ctx, exploration.id, parsed.expected_version);
    await tx
      .update(coreSchema.explorations)
      .set({ ext: { ...(exploration.ext ?? {}), parked: parsed.parked } })
      .where(eq(coreSchema.explorations.id, exploration.id));
    const response = jsonObject({
      exploration_id: exploration.id,
      version,
      parked: parsed.parked,
    });
    if (operationId) await completeCoreOperation(tx, operationId, 200, response);
    return response;
  });
}

/** "Do not use this any more" is executed as asked; no model judges it first. */
export async function withdrawClaimByOwner(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = WithdrawClaimInput.parse(input);
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: coreSchema.claimRevisions.id,
        claimId: coreSchema.claimRevisions.claimId,
      })
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.id, parsed.claim_revision_id))
      .limit(1);
    const [claim] = target
      ? await tx
          .select()
          .from(coreSchema.claims)
          .where(
            and(
              eq(coreSchema.claims.id, target.claimId),
              eq(coreSchema.claims.tenantId, ctx.tenantId),
              eq(coreSchema.claims.subjectId, ctx.subjectId),
            ),
          )
          .limit(1)
      : [];
    if (!target || !claim) throw new CoreError("CLAIM_NOT_FOUND", 404, "认识不存在");

    // Same lock order as every other commit: the conversation row first, then
    // claim revisions. The version is incremented atomically so concurrent
    // saves are never overwritten; in-flight work on this conversation then
    // fails its version check instead of publishing over the withdrawal.
    const explorationId = claim.claimKey.split("/")[0] ?? "";
    const [exploration] = /^[0-9a-f-]{36}$/.test(explorationId)
      ? await tx
          .update(coreSchema.explorations)
          .set({
            version: sql`${coreSchema.explorations.version} + 1`,
            lastActivityAt: new Date(),
          })
          .where(
            and(
              eq(coreSchema.explorations.id, explorationId),
              eq(coreSchema.explorations.tenantId, ctx.tenantId),
              eq(coreSchema.explorations.subjectId, ctx.subjectId),
            ),
          )
          .returning()
      : [];

    const [locked] = await tx
      .select({ status: coreSchema.claimRevisions.status })
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.id, target.id))
      .for("update");
    if (locked?.status !== "current")
      throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");

    let sourceId: string | null = null;
    if (parsed.note) {
      const { source, span } = await createSource(tx, ctx, {
        kind: "guided_response",
        content: parsed.note,
        meta: {
          exploration_id: exploration?.id ?? null,
          stop_using_claim_revision_id: target.id,
        },
        contextCompleteness: "partial",
      });
      sourceId = source.id;
      if (exploration) {
        await tx.insert(coreSchema.experienceEvidence).values({
          experienceId: exploration.experienceId,
          evidenceSpanId: span.id,
          relation: "describes",
        });
        await tx.insert(coreSchema.explorationTurns).values({
          explorationId: exploration.id,
          sourceItemId: source.id,
          role: "user",
          turnKind: "stop_using",
          content: parsed.note,
        });
      }
    }
    const withdrawn = await withdrawClaim(tx, claim.id, "用户要求以后不再使用这条认识。");
    await tx.insert(coreSchema.feedbackEvents).values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      explorationId: exploration?.id ?? null,
      targetType: "claim_revision",
      targetId: target.id,
      feedbackType: "stop_using",
      note: parsed.note ?? "以后不要再用这条认识。",
      sourceItemId: sourceId,
    });
    const version = exploration?.version ?? null;
    const response = jsonObject({
      claim_revision_id: target.id,
      withdrawn_revision_id: withdrawn?.id ?? null,
      exploration_id: exploration?.id ?? null,
      version,
      status: "withdrawn",
    });
    if (operationId) await completeCoreOperation(tx, operationId, 200, response);
    return response;
  });
}

function historyText(
  turns: Array<{ role: string; turnKind: string; content: string }>,
  questions: Array<{ question: string; sequence: number }>,
) {
  const lines = turns.slice(-HISTORY_TURNS).map((turn) => {
    const who = turn.role === "user" ? "USER" : "FINDME";
    const text =
      turn.content.length > HISTORY_TURN_CHARS
        ? `${turn.content.slice(0, HISTORY_TURN_CHARS)}…`
        : turn.content;
    return `[${who}/${turn.turnKind}] ${text}`;
  });
  const asked = questions.map((q) => `Q${q.sequence}: ${q.question}`);
  return [
    "CONVERSATION (oldest first; earlier turns may be omitted):",
    ...lines,
    "",
    "QUESTIONS_FINDME_ASKED:",
    ...(asked.length ? asked : ["(none)"]),
  ].join("\n");
}

export async function replyToMessageWith(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = ReplyInput.parse(input);
  const basis = await store.read(async (db) => {
    const exploration = await loadExploration(db, ctx, parsed.exploration_id);
    if (exploration.version !== parsed.expected_version)
      throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
        current_version: exploration.version,
      });
    const [message] = await db
      .select()
      .from(coreSchema.sourceItems)
      .where(
        and(
          eq(coreSchema.sourceItems.id, parsed.message_source_id),
          eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
          eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        ),
      )
      .limit(1);
    const meta = (message?.sourceMeta ?? {}) as SourceMeta;
    if (!message || meta.exploration_id !== exploration.id)
      throw new CoreError("MESSAGE_NOT_FOUND", 404, "这条消息不存在");
    if (meta.reply_status !== "pending")
      throw new CoreError("MESSAGE_ALREADY_ANSWERED", 409, "这条消息已经回应过");
    const [experience] = await db
      .select()
      .from(coreSchema.experiences)
      .where(eq(coreSchema.experiences.id, exploration.experienceId))
      .limit(1);
    const [turns, questions, claims] = await Promise.all([
      db
        .select()
        .from(coreSchema.explorationTurns)
        .where(eq(coreSchema.explorationTurns.explorationId, exploration.id))
        .orderBy(coreSchema.explorationTurns.createdAt),
      db
        .select()
        .from(coreSchema.explorationQuestions)
        .where(eq(coreSchema.explorationQuestions.explorationId, exploration.id))
        .orderBy(coreSchema.explorationQuestions.sequence),
      loadCurrentClaimRows(db, ctx, exploration.id),
    ]);
    const recentUser = turns
      .filter((t) => t.role === "user")
      .slice(-6)
      .map((t) => t.content)
      .join("\n");
    const prior = await loadPriorUnderstanding(db, ctx, {
      explorationId: exploration.id,
      queryText: `${experience?.summary ?? ""}\n${recentUser}`,
    });
    return { exploration, message, meta, experience, turns, questions, claims, prior };
  });

  const { exploration, message, meta, experience, turns, questions, prior } = basis;
  const claims = basis.claims.filter((claim) => claim.evidenceStatus === "valid");
  const ownClaims = claims.map((claim) => ({
    key: claim.key,
    kind: claim.claimKind,
    mode: claim.mode,
    text: claim.text,
    scope: claim.scope,
    confidence_level: claim.confidenceLevel,
  }));
  const allowedKeys = new Set([
    ...ownClaims.map((claim) => claim.key),
    ...prior.claims.map((claim) => claim.key),
  ]);
  const input0 = [
    `MATTER: ${experience?.summary ?? ""}`,
    "",
    historyText(turns, questions),
    "",
    "THIS_CONVERSATION_CLAIMS (current understanding formed in this conversation):",
    JSON.stringify(ownClaims),
    priorContextText(prior),
    "",
    "USER_MESSAGE (respond to this):",
    message.content,
  ].join("\n");

  const model = gateway.describe(OBSERVATION_MODEL_ROUTE);
  const startedAt = Date.now();
  let draft: ConversationReplyDraft | null = null;
  let issues: string[] = [];
  let attempts = 0;
  let usedInput = input0;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    attempts = attempt + 1;
    usedInput =
      attempt === 0
        ? input0
        : `${input0}\n\nRETRY_CONSTRAINT: 上一次输出被校验拒绝：${issues.join(", ")}。used_claim_keys 只能使用输入中出现的 key。`;
    const candidate = ConversationReplyDraft.parse(
      await generateConversationReply(gateway, usedInput),
    );
    issues = candidate.used_claim_keys
      .filter((key) => !allowedKeys.has(key))
      .map((key) => `unknown_claim_key:${key}`);
    if (!candidate.reply.trim()) issues.push("empty_reply");
    if (!issues.length) draft = candidate;
  }
  if (!draft)
    throw new CoreError("REPLY_REJECTED", 422, "这次回应没有通过校验，消息已保存，可以重新处理");

  const offeredIds = [
    ...new Set([
      ...claims.map((claim) => claim.revisionId),
      ...prior.claims.map((claim) => claim.revisionId),
    ]),
  ];
  const usedRevisions = [
    ...claims
      .filter((claim) => draft.used_claim_keys.includes(claim.key))
      .map((claim) => ({
        key: claim.key,
        claim_id: claim.claimId,
        claim_revision_id: claim.revisionId,
      })),
    ...prior.claims
      .filter((claim) => draft.used_claim_keys.includes(claim.key))
      .map((claim) => ({
        key: claim.key,
        claim_id: claim.claimId,
        claim_revision_id: claim.revisionId,
      })),
  ];
  const generation = {
    policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
    prompt_version: CONVERSATION_REPLY_PROMPT_VERSION,
    validator_version: REPLY_VALIDATOR_VERSION,
    model_route: model.route,
    model_version: model.model,
    input_fingerprint: inputFingerprint([
      CONVERSATION_REPLY_PROMPT_VERSION,
      REPLY_VALIDATOR_VERSION,
      model.route,
      model.model,
      parsed.expected_version,
      usedInput,
    ]),
    attempts,
    validation_issues: issues,
    latency_ms: Date.now() - startedAt,
    used: usedRevisions,
    // Every revision the model was given, for deletion propagation.
    offered_claim_revision_ids: offeredIds,
    prior_understanding: priorSelectionMeta(prior),
  };

  return store.write((db) =>
    db.transaction(async (tx) => {
      if (operationId) await lockCoreOperation(tx, operationId);
      const version = await bumpExplorationVersion(
        tx,
        ctx,
        exploration.id,
        parsed.expected_version,
        { reopen: true },
      );
      // The message itself must still be usable (not excluded or deleted meanwhile).
      await assertEvidenceUsable(tx, ctx, [{ sourceItemId: message.id, assessmentVersion: null }]);
      // Every revision offered to the model must still be current with valid
      // evidence, and stay so until this commit: lock them (conversation row
      // first, then revisions in id order, as in all other commits). A
      // withdrawal or source invalidation elsewhere then waits or fails this.
      if (offeredIds.length) {
        const rows = await tx
          .select({
            id: coreSchema.claimRevisions.id,
            status: coreSchema.claimRevisions.status,
            evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
          })
          .from(coreSchema.claimRevisions)
          .where(inArray(coreSchema.claimRevisions.id, offeredIds))
          .orderBy(coreSchema.claimRevisions.id)
          .for("update");
        if (
          rows.length !== offeredIds.length ||
          rows.some((row) => row.status !== "current" || row.evidenceStatus !== "valid")
        )
          throw new CoreError("STALE_CLAIM_REVISION", 409, "回应期间相关认识已经变化，请重新处理");
      }
      const [turn] = await tx
        .insert(coreSchema.explorationTurns)
        .values({
          explorationId: exploration.id,
          role: "assistant",
          turnKind: "reply",
          content: draft.reply,
        })
        .returning({ id: coreSchema.explorationTurns.id });
      await tx
        .update(coreSchema.sourceItems)
        .set({
          sourceMeta: {
            ...meta,
            reply_status: "replied",
            // New facts still have to reach the understanding; cleared when a
            // later synthesis of this conversation commits.
            ...(draft.new_information ? { understanding_status: "pending" } : {}),
            reply: {
              ...generation,
              turn_id: turn?.id ?? null,
              new_information: draft.new_information,
              new_information_note: draft.new_information_note,
            },
          },
        })
        .where(eq(coreSchema.sourceItems.id, message.id));
      const response = jsonObject({
        exploration_id: exploration.id,
        version,
        message_source_id: message.id,
        reply: draft.reply,
        used: usedRevisions,
        new_information: draft.new_information,
        new_information_note: draft.new_information_note,
      });
      if (operationId) await completeCoreOperation(tx, operationId, 201, response);
      return response;
    }),
  );
}

/** Owner inputs saved but not yet processed, for the "重新处理" affordance. */
export async function loadPendingInputs(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  explorationId: string,
) {
  const rows = await db
    .select({
      id: coreSchema.sourceItems.id,
      content: coreSchema.sourceItems.content,
      meta: coreSchema.sourceItems.sourceMeta,
      createdAt: coreSchema.sourceItems.capturedAt,
    })
    .from(coreSchema.explorationTurns)
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.sourceItems.id, coreSchema.explorationTurns.sourceItemId),
    )
    .where(
      and(
        eq(coreSchema.explorationTurns.explorationId, explorationId),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        inArray(coreSchema.explorationTurns.turnKind, ["event", "correction", "message"]),
      ),
    )
    .orderBy(coreSchema.sourceItems.capturedAt);
  const corrections = [];
  const messages = [];
  const updates = [];
  for (const row of rows) {
    const meta = (row.meta ?? {}) as SourceMeta;
    if (meta.correction_status === "pending")
      corrections.push({
        source_id: row.id,
        note: row.content,
        correction_type: meta.correction_type ?? null,
        claim_revision_ids: meta.claim_revision_ids ?? [],
        saved_at: row.createdAt,
      });
    if (meta.reply_status === "pending")
      messages.push({ source_id: row.id, message: row.content, saved_at: row.createdAt });
    if (meta.understanding_status === "pending")
      updates.push({ source_id: row.id, message: row.content, saved_at: row.createdAt });
  }
  return { corrections, messages, updates };
}

/** A committed synthesis covered every saved input of this conversation. */
export async function markUnderstandingProcessed(
  tx: Pick<Db, "update">,
  ctx: PersonalContext,
  explorationId: string,
) {
  await tx
    .update(coreSchema.sourceItems)
    .set({
      sourceMeta: sql`${coreSchema.sourceItems.sourceMeta} || '{"understanding_status":"processed"}'::jsonb`,
    })
    .where(
      and(
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        sql`${coreSchema.sourceItems.sourceMeta}->>'exploration_id' = ${explorationId}`,
        sql`${coreSchema.sourceItems.sourceMeta}->>'understanding_status' = 'pending'`,
      ),
    );
}

/** Recent changes to the owner's understanding, newest first. */
export async function listUnderstandingChanges(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  limit = 20,
) {
  const rows = await db
    .select({
      revisionId: coreSchema.claimRevisions.id,
      claimId: coreSchema.claims.id,
      claimKey: coreSchema.claims.claimKey,
      version: coreSchema.claimRevisions.version,
      status: coreSchema.claimRevisions.status,
      text: coreSchema.claimRevisions.text,
      scope: coreSchema.claimRevisions.scope,
      reason: coreSchema.claimRevisions.revisionReason,
      createdAt: coreSchema.claimRevisions.createdAt,
    })
    .from(coreSchema.claimRevisions)
    .innerJoin(coreSchema.claims, eq(coreSchema.claims.id, coreSchema.claimRevisions.claimId))
    .where(
      and(
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        inArray(coreSchema.claimRevisions.status, ["current", "withdrawn"]),
      ),
    )
    .orderBy(desc(coreSchema.claimRevisions.createdAt))
    .limit(Math.max(1, Math.min(limit, 50)));
  return {
    items: rows.map((row) => ({
      claim_id: row.claimId,
      claim_revision_id: row.revisionId,
      key: modelClaimKey(row.claimKey.split("/")[0] ?? "", row.claimKey),
      change: row.status === "withdrawn" ? "withdrawn" : row.version > 1 ? "revised" : "added",
      text: row.text,
      scope: row.scope,
      reason: row.reason,
      changed_at: row.createdAt,
    })),
  };
}
