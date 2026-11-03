import { type Db, specialistSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { readPersonalSources } from "../core/personal-source.js";

type SessionRow = typeof specialistSchema.specialistSessions.$inferSelect;
/** Free-text session context, stored only as the session's personal source. */
export const contextFields = [
  ["goal", "目标"],
  ["setting", "情境"],
  ["difficulty", "困难"],
  ["environment", "环境"],
  ["existingSupports", "已有支持"],
  ["burden", "负担"],
] as const;
export type SessionContext = Record<(typeof contextFields)[number][0], string | null>;
export type Session = SessionRow & SessionContext;
const emptyContext = Object.fromEntries(
  contextFields.map(([key]) => [key, null]),
) as SessionContext;

export async function withContext(
  db: Db,
  ctx: PersonalContext,
  rows: SessionRow[],
): Promise<Session[]> {
  const sources = await readPersonalSources(
    db,
    ctx,
    rows.flatMap((row) => (row.contextSourceId ? [row.contextSourceId] : [])),
  );
  return rows.map((row) => {
    const fields = row.contextSourceId
      ? (sources.get(row.contextSourceId)?.sourceMeta?.fields as Partial<SessionContext>)
      : undefined;
    return { ...row, ...emptyContext, ...fields };
  });
}

export async function ownedSession(
  db: Db,
  ctx: PersonalContext,
  id: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(specialistSchema.specialistSessions)
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistSessions.id, id),
      ),
    )
    .limit(1);
  return row ? ((await withContext(db, ctx, [row]))[0] ?? null) : null;
}
export async function ownedProposal(db: Db, ctx: PersonalContext, id: string) {
  const [row] = await db
    .select()
    .from(specialistSchema.specialistProposals)
    .where(
      and(
        eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistProposals.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function ownedTrial(db: Db, ctx: PersonalContext, id: string) {
  const [row] = await db
    .select()
    .from(specialistSchema.specialistTrials)
    .where(
      and(
        eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistTrials.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Child reads share the same tenant/Profile boundary as their parent. */
export async function sessionChildren(db: Db, ctx: PersonalContext, sessionId: string) {
  const proposals = await db
    .select()
    .from(specialistSchema.specialistProposals)
    .where(
      and(
        eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistProposals.sessionId, sessionId),
      ),
    )
    .orderBy(desc(specialistSchema.specialistProposals.createdAt));
  const trials = await db
    .select()
    .from(specialistSchema.specialistTrials)
    .where(
      and(
        eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistTrials.sessionId, sessionId),
      ),
    )
    .orderBy(desc(specialistSchema.specialistTrials.acceptedAt));

  return { proposals, trials };
}
