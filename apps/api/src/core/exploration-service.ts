import {
  CompleteExplorationInput,
  type CoreReportTarget,
  RespondToExplorationInput,
  StartExplorationInput,
} from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "./errors.js";
import { jsonObject } from "./exploration-context.js";
import { bumpExplorationVersion, createSource } from "./exploration-persistence.js";
import { loadExploration } from "./exploration-reading.js";
import type { PersonalContext } from "./exploration-types.js";
import type { CoreGateway } from "./llm.js";
import { completeCoreOperation } from "./operations.js";
export type { PersonalContext } from "./exploration-types.js";
export { correctUnderstanding, amendExplorationSource } from "./exploration-revision.js";
export {
  getCurrentUnderstanding,
  getExplorationView,
  listExplorations,
} from "./exploration-views.js";
export { continueExploration } from "./exploration-planning.js";

export async function startExploration(
  db: Db,
  _gateway: CoreGateway | undefined,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
  validatedReportTarget?: CoreReportTarget,
) {
  // save_ms measures request parsing plus the domain transaction through response assembly;
  // it excludes the HTTP round trip and any caller-side rendering/acknowledgement time.
  const saveStartedAt = Date.now();
  const parsed = StartExplorationInput.parse(input);
  if (parsed.report_target && !validatedReportTarget)
    throw new CoreError("REPORT_BRIDGE_UNAVAILABLE", 403, "报告目标必须由服务端校验");
  const occurredAt = parsed.occurred_at ? new Date(parsed.occurred_at) : undefined;

  // User facts are committed before any model work. A planner failure must never
  // make the user wonder whether the event itself was saved.
  return db.transaction(async (tx) => {
    const { source, span } = await createSource(tx, ctx, {
      kind: "native_event",
      content: parsed.event,
      occurredAt,
      meta: parsed.occurred_label ? { occurred_label: parsed.occurred_label } : {},
      contextCompleteness: "partial",
    });

    const [experience] = await tx
      .insert(coreSchema.experiences)
      .values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        summary: parsed.event,
        occurredAt,
      })
      .returning();
    if (!experience) throw new Error("experience_create_failed");

    await tx.insert(coreSchema.experienceEvidence).values({
      experienceId: experience.id,
      evidenceSpanId: span.id,
      relation: "describes",
    });
    const [exploration] = await tx
      .insert(coreSchema.explorations)
      .values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        experienceId: experience.id,
        ...(validatedReportTarget ? { ext: { report_target: validatedReportTarget } } : {}),
      })
      .returning();
    if (!exploration) throw new Error("exploration_create_failed");

    await tx.insert(coreSchema.explorationTurns).values({
      explorationId: exploration.id,
      sourceItemId: source.id,
      role: "user",
      turnKind: "event",
      content: parsed.event,
    });
    // Daily use answers the request first; exploration follows only as needed.
    if (parsed.reply_first)
      await tx
        .update(coreSchema.sourceItems)
        .set({
          sourceMeta: {
            ...(source.sourceMeta ?? {}),
            exploration_id: exploration.id,
            reply_status: "pending",
          },
        })
        .where(eq(coreSchema.sourceItems.id, source.id));

    const response = jsonObject({
      exploration: {
        id: exploration.id,
        status: exploration.status,
        version: exploration.version,
        started_at: exploration.startedAt,
        last_activity_at: exploration.lastActivityAt,
      },
      experience: { id: experience.id, summary: experience.summary },
      event_source_id: source.id,
      phase: "ready_to_plan",
      ...(validatedReportTarget ? { report_target: validatedReportTarget } : {}),
      saved: true,
      timing: { save_ms: Date.now() - saveStartedAt },
    });
    if (operationId) await completeCoreOperation(tx, operationId, 201, response);
    return response;
  });
}

export async function respondToExploration(
  db: Db,
  _gateway: CoreGateway | undefined,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  // Keep the fast-write timing boundary explicit: this is persistence work, not model latency.
  const saveStartedAt = Date.now();
  const parsed = RespondToExplorationInput.parse(input);
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  }

  const [question] = await db
    .select()
    .from(coreSchema.explorationQuestions)
    .where(
      and(
        eq(coreSchema.explorationQuestions.id, parsed.question_id),
        eq(coreSchema.explorationQuestions.explorationId, exploration.id),
        eq(coreSchema.explorationQuestions.status, "open"),
      ),
    )
    .limit(1);
  if (!question) {
    throw new CoreError("QUESTION_NOT_OPEN", 409, "这个问题已经回答或不再有效");
  }

  const answerContent = [
    parsed.selected_options.length > 0 ? `选择：${parsed.selected_options.join("；")}` : "",
    parsed.answer.trim(),
  ]
    .filter(Boolean)
    .join("。");

  // Respond is now a fast write path: user input is committed without waiting
  // for model synthesis. Planning happens in the separate continue mutation.
  return db.transaction(async (tx) => {
    const nextVersion = await bumpExplorationVersion(
      tx,
      ctx,
      exploration.id,
      parsed.expected_version,
    );

    const [answeredQuestion] = await tx
      .update(coreSchema.explorationQuestions)
      .set({ status: "answered", answeredAt: new Date() })
      .where(
        and(
          eq(coreSchema.explorationQuestions.id, question.id),
          eq(coreSchema.explorationQuestions.explorationId, exploration.id),
          eq(coreSchema.explorationQuestions.status, "open"),
        ),
      )
      .returning({ id: coreSchema.explorationQuestions.id });
    if (!answeredQuestion) {
      throw new CoreError("QUESTION_NOT_OPEN", 409, "这个问题已经回答或不再有效");
    }

    const { source, span } = await createSource(tx, ctx, {
      kind: "guided_response",
      content: answerContent,
      meta: {
        exploration_id: exploration.id,
        question_id: question.id,
        selected_options: parsed.selected_options,
        free_text: parsed.answer.trim(),
      },
      contextCompleteness: "partial",
    });

    await tx.insert(coreSchema.experienceEvidence).values({
      experienceId: exploration.experienceId,
      evidenceSpanId: span.id,
      relation: "describes",
    });
    const [turn] = await tx
      .insert(coreSchema.explorationTurns)
      .values({
        explorationId: exploration.id,
        questionId: question.id,
        sourceItemId: source.id,
        role: "user",
        turnKind: "answer",
        content: answerContent,
      })
      .returning({ id: coreSchema.explorationTurns.id });
    if (!turn) throw new Error("exploration_turn_create_failed");

    const response = jsonObject({
      exploration_id: exploration.id,
      experience_id: exploration.experienceId,
      version: nextVersion,
      phase: "ready_to_plan",
      saved: true,
      source_id: source.id,
      input_turn_id: turn.id,
      timing: { save_ms: Date.now() - saveStartedAt },
    });
    if (operationId) await completeCoreOperation(tx, operationId, 201, response);
    return response;
  });
}

export async function completeExploration(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = CompleteExplorationInput.parse(input);
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  }

  return db.transaction(async (tx) => {
    const nextVersion = await bumpExplorationVersion(
      tx,
      ctx,
      exploration.id,
      parsed.expected_version,
    );
    const completedAt = new Date();
    await tx
      .update(coreSchema.explorations)
      .set({
        status: "completed",
        completedAt,
        lastActivityAt: completedAt,
      })
      .where(eq(coreSchema.explorations.id, exploration.id));
    await tx
      .update(coreSchema.explorationQuestions)
      .set({ status: "skipped" })
      .where(
        and(
          eq(coreSchema.explorationQuestions.explorationId, exploration.id),
          eq(coreSchema.explorationQuestions.status, "open"),
        ),
      );

    const response = jsonObject({
      exploration_id: exploration.id,
      version: nextVersion,
      status: "completed",
      phase: "completed",
      completed_at: completedAt,
    });
    if (operationId) await completeCoreOperation(tx, operationId, 200, response);
    return response;
  });
}
