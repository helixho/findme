import { type Db, coreSchema as c } from "@findme/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { capturePiDependencies } from "./pi-archive.js";
import { capturePiReplyLineage } from "./pi-lineage.js";

const Input = z.object({
  conversationId: z.string().uuid(),
  includeAnalysis: z.boolean().default(false),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(30).default(10),
});

/** Exact question/option spans preserve short answers without importing old interpretations. */
export function questionBackgroundSpans(text: string) {
  const matches = [
    ...text.matchAll(/[^。！？\n]*[?？]/g),
    ...text.matchAll(/^\s*[A-HＡ-Ｈ][.、．:：)]\s*[^\n]*/gm),
  ];
  return matches
    .map((match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0],
    }))
    .sort((a, b) => a.start - b.start)
    .filter(
      (span, i, all) => all.findIndex((s) => s.start === span.start && s.end === span.end) === i,
    );
}
export function questionBackground(text: string) {
  return questionBackgroundSpans(text)
    .map((span) => span.text)
    .join("\n");
}

/** Native App history complements imported conversations; it is not a new memory store. */
export class NativeConversationReader {
  constructor(private readonly db: Db) {}

  async read(ctx: PersonalContext, raw: z.input<typeof Input>) {
    const input = Input.parse(raw);
    return withProfileTransaction(this.db, ctx, async (tx) => {
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
      const metadata = await tx
        .select({
          sourceId: c.explorationTurns.sourceItemId,
          turnId: c.explorationTurns.id,
          turnKind: c.explorationTurns.turnKind,
          role: c.explorationTurns.role,
          ownerTenant: c.sourceItems.tenantId,
          ownerSubject: c.sourceItems.subjectId,
          usage: c.sourceItems.usageStatus,
          eligibility: c.sourceAssessments.eligibility,
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
        .where(eq(c.explorationTurns.explorationId, conversation.id));
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
        metadata.filter((row) => row.turnKind === "pi_reply").map((row) => row.turnId),
      );
      const dependencies = [
        ...new Map(
          [...ownDependencies, ...lineage.dependencies].map((d) => [d.sourceId, d]),
        ).values(),
      ];
      const assistantAllowed = (turn: { id: string; turnKind: string }) =>
        turn.turnKind === "pi_reply" ? !lineage.unavailableTurnIds.includes(turn.id) : !stale;
      const rows = await tx
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
        .where(eq(c.explorationTurns.explorationId, conversation.id))
        .orderBy(asc(c.explorationTurns.createdAt), asc(c.explorationTurns.id))
        .limit(input.limit + 1)
        .offset(input.cursor);
      const usable = (row: (typeof rows)[number]) =>
        row.source !== null &&
        row.source.tenantId === ctx.tenantId &&
        row.source.subjectId === ctx.subjectId &&
        row.source.usageStatus === "active" &&
        row.assessment !== null &&
        ["eligible", "context_only"].includes(row.assessment.eligibility);
      const selected = rows.slice(0, input.limit);
      let precedingQuestion: string | null = null;
      if (!input.includeAnalysis && input.cursor > 0 && selected[0]?.turn.role === "user") {
        const [previous] = await tx
          .select({ turn: c.explorationTurns })
          .from(c.explorationTurns)
          .where(eq(c.explorationTurns.explorationId, conversation.id))
          .orderBy(asc(c.explorationTurns.createdAt), asc(c.explorationTurns.id))
          .limit(1)
          .offset(input.cursor - 1);
        if (previous?.turn.role === "assistant" && assistantAllowed(previous.turn))
          precedingQuestion = questionBackground(previous.turn.content) || null;
      }

      return {
        conversation_id: conversation.id,
        preceding_question_background: precedingQuestion,
        history_instruction:
          "旧问题和选项仅用于理解已发生的回答，不是本轮待办；未答不等于必须追问。",
        dependencies,
        version: conversation.version,
        next_cursor: rows.length > input.limit ? input.cursor + selected.length : null,
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
}
