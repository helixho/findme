import { type Db, coreSchema as c } from "@findme/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";

const Input = z.object({
  conversationId: z.string().uuid(),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(30).default(10),
});

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
        .orderBy(asc(c.explorationTurns.createdAt), asc(c.explorationTurns.id));
      const usable = (row: (typeof rows)[number]) =>
        row.source !== null &&
        row.source.tenantId === ctx.tenantId &&
        row.source.subjectId === ctx.subjectId &&
        row.source.usageStatus === "active" &&
        row.assessment !== null &&
        ["eligible", "context_only"].includes(row.assessment.eligibility);
      const stale = rows.some((row) => row.turn.sourceItemId !== null && !usable(row));
      const selected = rows.slice(input.cursor, input.cursor + input.limit);
      return {
        conversation_id: conversation.id,
        version: conversation.version,
        next_cursor:
          input.cursor + selected.length < rows.length ? input.cursor + selected.length : null,
        assistant_context_withheld: stale,
        turns: selected.map((row) => {
          const available = row.turn.role === "assistant" ? !stale : usable(row);
          return {
            id: row.turn.id,
            source_id: row.turn.sourceItemId,
            role: row.turn.role,
            kind: row.turn.turnKind,
            question_id: row.turn.questionId,
            recorded_at: row.turn.createdAt.toISOString(),
            status: available ? "available" : "unavailable",
            // Do not silently truncate long answers; paging limits message count.
            content: available ? row.turn.content : null,
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
