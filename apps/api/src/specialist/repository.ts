import { type Db, specialistSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
export async function ownedSession(db: Db, ctx: PersonalContext, id: string) {
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
  return row ?? null;
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
