import { createHash } from "node:crypto";
import { type Db, coreSchema as c } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-types.js";

export type ConversationTurn = {
  role: string;
  turnKind: string;
  content: string;
  sourceItemId: string | null;
};
export type ConversationSourceSnapshot = { sourceId: string; fingerprint: string };

/** Reading context is broader than publishing evidence: context_only remains readable. */
export async function qualifyConversationSources(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  sourceIds: readonly string[],
  lock = false,
) {
  const ids = [...new Set(sourceIds)].sort();
  if (!ids.length)
    return new Map<string, { content: string; readable: boolean; fingerprint: string }>();
  const query = db
    .select()
    .from(c.sourceItems)
    .where(
      and(
        inArray(c.sourceItems.id, ids),
        eq(c.sourceItems.tenantId, ctx.tenantId),
        eq(c.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .orderBy(c.sourceItems.id);
  const sources = await (lock ? query.for("share") : query);
  const assessmentQuery = db
    .select()
    .from(c.sourceAssessments)
    .where(
      and(inArray(c.sourceAssessments.sourceItemId, ids), eq(c.sourceAssessments.isCurrent, true)),
    )
    .orderBy(c.sourceAssessments.sourceItemId);
  const assessments = await (lock ? assessmentQuery.for("share") : assessmentQuery);
  return new Map(
    sources.map((source) => {
      const assessment = assessments.find((a) => a.sourceItemId === source.id);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            id: source.id,
            content: source.content,
            author: source.authorKind,
            usage: source.usageStatus,
            occurred: source.occurredAt,
            assessment: assessment
              ? {
                  version: assessment.version,
                  attribution: assessment.attributionStatus,
                  eligibility: assessment.eligibility,
                  completeness: assessment.contextCompleteness,
                  temporal: assessment.temporalPrecision,
                }
              : null,
          }),
        )
        .digest("hex");
      return [
        source.id,
        {
          content: source.content,
          fingerprint,
          readable:
            source.usageStatus === "active" &&
            !!assessment &&
            ["eligible", "context_only"].includes(assessment.eligibility),
        },
      ] as const;
    }),
  );
}

/** No historical side channel: summary and lookup query are derived from the same qualified turns. */
export async function readConversationContext<T extends ConversationTurn>(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  turns: T[],
) {
  const ids = turns.flatMap((t) => (t.sourceItemId ? [t.sourceItemId] : []));
  const states = await qualifyConversationSources(db, ctx, ids);
  const hasUnavailable = turns.some(
    (t) => t.role !== "assistant" && (!t.sourceItemId || !states.get(t.sourceItemId)?.readable),
  );
  const qualified = turns.flatMap((t) => {
    if (t.role === "assistant") return hasUnavailable ? [] : [t];
    const state = t.sourceItemId ? states.get(t.sourceItemId) : undefined;
    return state?.readable ? [{ ...t, content: state.content }] : [];
  });
  return {
    turns: qualified,
    hasUnavailable,
    matter: qualified.find((t) => t.turnKind === "event")?.content ?? "",
    recentUser: qualified
      .filter((t) => t.role === "user")
      .slice(-6)
      .map((t) => t.content)
      .join("\n"),
    // Include missing states too: appearance/disappearance during generation is a change.
    sources: [...new Set(ids)].sort().map((sourceId) => ({
      sourceId,
      fingerprint: states.get(sourceId)?.fingerprint ?? "missing",
    })),
  };
}

export async function assertConversationSourcesCurrent(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  before: readonly ConversationSourceSnapshot[],
) {
  const states = await qualifyConversationSources(
    db,
    ctx,
    before.map((s) => s.sourceId),
    true,
  );
  if (before.some((s) => (states.get(s.sourceId)?.fingerprint ?? "missing") !== s.fingerprint))
    throw new CoreError("STALE_EXPLORATION_CONTEXT", 409, "对话材料已变化，请重新处理");
}
