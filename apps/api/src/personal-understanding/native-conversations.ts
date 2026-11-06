import { type Db, coreSchema as c } from "@findme/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { lockPiProfileState, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import { orderConversationReplies } from "../core/conversation-context.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { capturePiDependencies } from "./pi-archive.js";
import { capturePiReplyLineage } from "./pi-lineage.js";

const Input = z.object({
  conversationId: z.string().uuid(),
  beforeSourceId: z.string().uuid().optional(),
  focusSourceId: z.string().uuid().optional(),
  asOf: z.string().datetime({ offset: true }).optional(),
  includeAnalysis: z.boolean().default(false),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(30).default(10),
});

import {
  deriveChoiceBindings,
  questionBackground,
  questionBackgroundSpans,
} from "./choice-context.js";
export { questionBackground, questionBackgroundSpans } from "./choice-context.js";

/** Native App history complements imported conversations; it is not a new memory store. */
export class NativeConversationReader {
  constructor(private readonly db: Db) {}

  async read(ctx: PersonalContext, raw: z.input<typeof Input>) {
    const input = Input.parse(raw);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await lockPiProfileState(tx, ctx);
      const [conversation] = await tx
        .select({ id: c.explorations.id, version: c.explorations.version })
        .from(c.explorations)
        .where(
          and(
            eq(c.explorations.id, input.conversationId),
            eq(c.explorations.tenantId, ctx.tenantId),
            eq(c.explorations.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!conversation) throw new Error("CONVERSATION_NOT_AVAILABLE");
      // Check the whole thread before paging: an excluded early input must not
      // reappear indirectly through a later assistant reply on a different page.
      const rawMetadata = await tx
        .select({
          sourceId: c.explorationTurns.sourceItemId,
          sourceMeta: c.sourceItems.sourceMeta,
          turnId: c.explorationTurns.id,
          turnKind: c.explorationTurns.turnKind,
          role: c.explorationTurns.role,
          ownerTenant: c.sourceItems.tenantId,
          ownerSubject: c.sourceItems.subjectId,
          usage: c.sourceItems.usageStatus,
          eligibility: c.sourceAssessments.eligibility,
          withinTime: input.asOf
            ? sql<boolean>`${and(
                lte(c.explorationTurns.createdAt, new Date(input.asOf)),
                or(
                  isNull(c.explorationTurns.sourceItemId),
                  lte(c.sourceItems.capturedAt, new Date(input.asOf)),
                ),
              )}`
            : sql<boolean>`true`,
        })
        .from(c.explorationTurns)
        .leftJoin(c.sourceItems, eq(c.explorationTurns.sourceItemId, c.sourceItems.id))
        .leftJoin(
          c.sourceAssessments,
          and(
            eq(c.sourceAssessments.sourceItemId, c.sourceItems.id),
            eq(c.sourceAssessments.isCurrent, true),
          ),
        )
        .where(eq(c.explorationTurns.explorationId, conversation.id))
        .orderBy(asc(c.explorationTurns.createdAt), asc(c.explorationTurns.id));
      const orderedMetadata = orderConversationReplies(
        rawMetadata.map((row) => ({ ...row, id: row.turnId })),
        rawMetadata.flatMap((row) => {
          const reply = row.sourceMeta?.reply as { turn_id?: unknown } | undefined;
          return row.role === "user" && typeof reply?.turn_id === "string"
            ? [{ inputTurnId: row.turnId, replyTurnId: reply.turn_id }]
            : [];
        }),
      );
      const cutoff = input.beforeSourceId
        ? orderedMetadata.findIndex((row) => row.sourceId === input.beforeSourceId)
        : -1;
      // Keep unavailable/time-filtered rows in the adjacency sequence. Removing
      // them before binding could attach B to an earlier, unrelated question.
      const chronological = cutoff >= 0 ? orderedMetadata.slice(0, cutoff) : orderedMetadata;
      const metadata = chronological.filter((row) => row.withinTime);
      const focused = input.focusSourceId
        ? metadata.findIndex((row) => row.sourceId === input.focusSourceId && row.role === "user")
        : -1;
      const cursor = input.focusSourceId ? (focused < 0 ? metadata.length : focused) : input.cursor;
      const allowed = (row: (typeof metadata)[number]) =>
        row.sourceId !== null &&
        row.ownerTenant === ctx.tenantId &&
        row.ownerSubject === ctx.subjectId &&
        row.usage === "active" &&
        row.eligibility !== null &&
        ["eligible", "context_only"].includes(row.eligibility);
      const stale = metadata.some((row) => row.sourceId !== null && !allowed(row));
      // Assistant text may depend on earlier inputs outside this page. Preserve
      // lineage conservatively while fetching only page-sized turn bodies.
      const sourceIds = metadata.filter(allowed).map((row) => row.sourceId as string);
      const ownDependencies = sourceIds.length
        ? await capturePiDependencies(tx, ctx, sourceIds)
        : [];
      const lineage = await capturePiReplyLineage(
        tx,
        ctx,
        metadata
          .filter((row) => ["pi_reply", "reply"].includes(row.turnKind))
          .map((row) => row.turnId),
        metadata.filter((row) => row.turnKind === "reply").map((row) => row.turnId),
      );
      const dependencies = [
        ...new Map(
          [...ownDependencies, ...lineage.dependencies].map((d) => [d.sourceId, d]),
        ).values(),
      ];
      const assistantAllowed = (turn: { id: string; turnKind: string }) =>
        turn.turnKind === "pi_reply"
          ? !lineage.unavailableTurnIds.includes(turn.id)
          : !stale && !lineage.unavailableTurnIds.includes(turn.id);
      const page = metadata.slice(cursor, cursor + input.limit + 1);
      const fetchedRows = page.length
        ? await tx
            .select({
              turn: c.explorationTurns,
              source: c.sourceItems,
              assessment: c.sourceAssessments,
            })
            .from(c.explorationTurns)
            .leftJoin(c.sourceItems, eq(c.explorationTurns.sourceItemId, c.sourceItems.id))
            .leftJoin(
              c.sourceAssessments,
              and(
                eq(c.sourceAssessments.sourceItemId, c.sourceItems.id),
                eq(c.sourceAssessments.isCurrent, true),
              ),
            )
            .where(
              and(
                eq(c.explorationTurns.explorationId, conversation.id),
                inArray(
                  c.explorationTurns.id,
                  page.map((row) => row.turnId),
                ),
              ),
            )
        : [];
      const rows = page.flatMap((item) => fetchedRows.filter((row) => row.turn.id === item.turnId));
      const usable = (row: (typeof rows)[number]) =>
        row.source !== null &&
        row.source.tenantId === ctx.tenantId &&
        row.source.subjectId === ctx.subjectId &&
        row.source.usageStatus === "active" &&
        row.assessment !== null &&
        ["eligible", "context_only"].includes(row.assessment.eligibility);
      const selected = rows.slice(0, input.limit);
      const predecessorByAnswer = new Map(
        selected
          .filter((row) => row.turn.role === "user")
          .flatMap((row) => {
            const position = chronological.findIndex((item) => item.turnId === row.turn.id);
            const previous = chronological[position - 1];
            return previous?.role === "assistant" &&
              previous.withinTime &&
              assistantAllowed(previous)
              ? [[row.turn.id, previous] as const]
              : [];
          }),
      );
      const questionIds = [...new Set([...predecessorByAnswer.values()].map((row) => row.turnId))];
      const questions = questionIds.length
        ? await tx
            .select()
            .from(c.explorationTurns)
            .where(
              and(
                eq(c.explorationTurns.explorationId, conversation.id),
                inArray(c.explorationTurns.id, questionIds),
              ),
            )
        : [];
      const bindings = new Map(
        selected
          .filter((row) => row.turn.role === "user" && usable(row))
          .flatMap((row) => {
            const previous = predecessorByAnswer.get(row.turn.id);
            const question = questions.find((turn) => turn.id === previous?.turnId);
            if (!question) return [];
            return deriveChoiceBindings([
              {
                id: question.id,
                role: "assistant",
                content: question.content,
                sourceItemId: question.sourceItemId,
              },
              {
                id: row.turn.id,
                role: "user",
                content: row.source?.content ?? "",
                sourceItemId: row.turn.sourceItemId,
              },
            ]).map((binding) => [binding.answer_turn_id, binding] as const);
          }),
      );
      const firstPredecessor = selected[0]
        ? predecessorByAnswer.get(selected[0].turn.id)
        : undefined;
      const previous = questions.find((turn) => turn.id === firstPredecessor?.turnId);
      const precedingQuestion =
        !input.includeAnalysis && cursor > 0 && previous
          ? questionBackground(previous.content) || null
          : null;

      return {
        conversation_id: conversation.id,
        content_as_of: input.asOf ?? null,
        qualification_checked_at: "current",
        preceding_question_background: precedingQuestion,
        history_instruction:
          "旧问题和选项仅用于理解已发生的回答，不是本轮待办；未答不等于必须追问。",
        dependencies,
        revision_dependencies: lineage.revisionDependencies,
        version: conversation.version,
        next_cursor: rows.length > input.limit ? cursor + selected.length : null,
        assistant_context_withheld:
          (stale &&
            metadata.some((row) => row.role === "assistant" && row.turnKind !== "pi_reply")) ||
          lineage.unavailableTurnIds.length > 0,
        turns: selected.map((row) => {
          const available =
            row.turn.role === "assistant" ? assistantAllowed(row.turn) : usable(row);
          return {
            id: row.turn.id,
            source_id: row.turn.sourceItemId,
            role: row.turn.role,
            kind: row.turn.turnKind,
            choice_binding:
              available && row.turn.role === "user" ? (bindings.get(row.turn.id) ?? null) : null,
            question_id: row.turn.questionId,
            background_spans:
              available && row.turn.role === "assistant" && !input.includeAnalysis
                ? questionBackgroundSpans(row.turn.content)
                : [],
            context_use:
              row.turn.role === "assistant" && !input.includeAnalysis
                ? "past_question_background_not_current_task"
                : "source_material",
            recorded_at: row.turn.createdAt.toISOString(),
            status: available ? "available" : "unavailable",
            // Do not silently truncate long answers; paging limits message count.
            content: available
              ? row.turn.role === "assistant"
                ? input.includeAnalysis
                  ? row.turn.content
                  : questionBackground(row.turn.content) || null
                : (row.source?.content ?? null)
              : null,
            author: available ? (row.source?.authorKind ?? "assistant") : null,
            assessment:
              available && row.assessment
                ? {
                    version: row.assessment.version,
                    attribution: row.assessment.attributionStatus,
                    eligibility: row.assessment.eligibility,
                  }
                : null,
            qualification:
              row.turn.role === "assistant"
                ? "assistant_context_not_evidence"
                : "source_expression",
          };
        }),
      };
    });
  }

  async choiceBinding(
    ctx: PersonalContext,
    input: { conversationId: string; sourceId: string; asOf?: string; beforeSourceId?: string },
  ) {
    const result = await this.read(ctx, {
      conversationId: input.conversationId,
      focusSourceId: input.sourceId,
      asOf: input.asOf,
      beforeSourceId: input.beforeSourceId,
      limit: 1,
    });
    return {
      binding:
        result.turns.find((turn) => turn.source_id === input.sourceId)?.choice_binding ?? null,
      dependencies: result.dependencies,
      revision_dependencies: result.revision_dependencies,
    };
  }
}
