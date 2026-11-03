import { type Db, specialistSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import type { DecisionInput, SessionInput, SessionUpdate } from "./contracts.js";
import { ownedSession, sessionChildren } from "./repository.js";
import { result } from "./types.js";
export async function listSessions(db: Db, ctx: PersonalContext) {
  const sessions = await db
    .select()
    .from(specialistSchema.specialistSessions)
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
      ),
    )
    .orderBy(desc(specialistSchema.specialistSessions.updatedAt))
    .limit(50);
  const items = await Promise.all(
    sessions.map(async (session) => {
      const { proposals, trials } = await sessionChildren(db, ctx, session.id);
      return { session, proposals, trials };
    }),
  );
  return result({ items });
}

export async function createSession(
  db: Db,
  ctx: PersonalContext,
  body: SessionInput,
  idempotencyKey: string,
) {
  const [existing] = await db
    .select()
    .from(specialistSchema.specialistSessions)
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistSessions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return result({ session: existing, replayed: true });
  const [session] = await db
    .insert(specialistSchema.specialistSessions)
    .values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      pathway: body.pathway,
      voluntary: "yes",
      idempotencyKey,
      goal: body.goal || null,
      setting: body.setting || null,
      difficulty: body.difficulty || null,
      difficultyCategories: body.difficulty_categories,
      scopeFlags: body.scope_flags,
      environment: body.environment || null,
      environmentCategories: body.environment_categories,
      existingSupports: body.existing_supports || null,
      burden: body.burden || null,
      selfReportedDiagnosis:
        body.pathway === "adhd" ? (body.self_reported_diagnosis ?? null) : null,
      skippedSteps: body.skipped_steps,
    })
    .returning();
  return result({ session }, 201);
}

export async function getSession(db: Db, ctx: PersonalContext, id: string) {
  const session = await ownedSession(db, ctx, id);
  if (!session) return result({ error: "session_not_found" }, 404);
  const { proposals, trials } = await sessionChildren(db, ctx, session.id);
  return result({ session, proposals, trials });
}

export async function updateSession(db: Db, ctx: PersonalContext, id: string, body: SessionUpdate) {
  const session = await ownedSession(db, ctx, id);
  if (!session) return result({ error: "session_not_found" }, 404);
  if (session.status === "completed") return result({ error: "session_completed" }, 409);
  const changes = {
    ...(body.goal !== undefined ? { goal: body.goal || null } : {}),
    ...(body.setting !== undefined ? { setting: body.setting || null } : {}),
    ...(body.difficulty !== undefined ? { difficulty: body.difficulty || null } : {}),
    ...(body.difficulty_categories !== undefined
      ? { difficultyCategories: body.difficulty_categories }
      : {}),
    ...(body.scope_flags !== undefined ? { scopeFlags: body.scope_flags } : {}),
    ...(body.environment !== undefined ? { environment: body.environment || null } : {}),
    ...(body.environment_categories !== undefined
      ? { environmentCategories: body.environment_categories }
      : {}),
    ...(body.existing_supports !== undefined
      ? { existingSupports: body.existing_supports || null }
      : {}),
    ...(body.burden !== undefined ? { burden: body.burden || null } : {}),
    ...(body.self_reported_diagnosis !== undefined
      ? {
          selfReportedDiagnosis: session.pathway === "adhd" ? body.self_reported_diagnosis : null,
        }
      : {}),
    ...(body.skipped_steps !== undefined ? { skippedSteps: body.skipped_steps } : {}),
  };
  if (session.version !== body.expected_version) {
    // An acknowledged state also resolves a response-lost retry without an extra revision.
    const same = Object.entries(changes).every(
      ([key, value]) =>
        JSON.stringify(session[key as keyof typeof session]) === JSON.stringify(value),
    );
    if (session.version === body.expected_version + 1 && same)
      return result({ session, replayed: true });
    return result({ error: "version_conflict", current_version: session.version }, 409);
  }
  const [updated] = await db
    .update(specialistSchema.specialistSessions)
    .set({ ...changes, version: session.version + 1, updatedAt: new Date() })
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistSessions.id, session.id),
        eq(specialistSchema.specialistSessions.version, body.expected_version),
      ),
    )
    .returning();
  return updated ? result({ session: updated }) : result({ error: "version_conflict" }, 409);
}

export async function transitionSession(
  db: Db,
  ctx: PersonalContext,
  id: string,
  body: DecisionInput,
  action: "pause" | "resume",
) {
  const session = await ownedSession(db, ctx, id);
  if (!session) return result({ error: "session_not_found" }, 404);
  if (session.version !== body.expected_version)
    return result({ error: "version_conflict", current_version: session.version }, 409);
  if (action === "pause" && session.status !== "open")
    return result({ error: "session_not_open", status: session.status }, 409);
  if (action === "resume" && session.status !== "paused")
    return result({ error: "session_not_paused", status: session.status }, 409);
  const [updated] = await db
    .update(specialistSchema.specialistSessions)
    .set({
      status: action === "pause" ? "paused" : "open",
      version: session.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistSessions.id, session.id),
        eq(specialistSchema.specialistSessions.version, body.expected_version),
      ),
    )
    .returning();
  return updated ? result({ session: updated }) : result({ error: "version_conflict" }, 409);
}
