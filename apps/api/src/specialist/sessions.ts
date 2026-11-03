import { randomUUID } from "node:crypto";
import { type Db, specialistSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { recordPersonalSource } from "../core/personal-source.js";
import type { DecisionInput, SessionInput, SessionUpdate } from "./contracts.js";
import {
  type Session,
  type SessionContext,
  contextFields,
  ownedSession,
  sessionChildren,
  withContext,
} from "./repository.js";
import { result } from "./types.js";

/** Records the person's own wording for a session as one personal source version. */
async function recordContext(
  db: Db,
  ctx: PersonalContext,
  sessionId: string,
  version: number,
  fields: SessionContext,
  previous: string | null,
) {
  const lines = contextFields.flatMap(([key, label]) =>
    fields[key] ? [`${label}：${fields[key]}`] : [],
  );
  if (!lines.length && !previous) return null;
  const source = await recordPersonalSource(db, ctx, {
    kind: "specialist_context",
    content: lines.join("\n"),
    externalRef: `specialist-context:${sessionId}:v${version}`,
    meta: { session_id: sessionId, session_version: version, fields },
    rationale: "本人在具体困难路径中填写的目标与情境；尚未用于形成认识。",
    complete: lines.length === contextFields.length,
    replaces: previous,
  });
  return source.id;
}
const contextOf = (
  body: Partial<
    Record<
      "goal" | "setting" | "difficulty" | "environment" | "existing_supports" | "burden",
      string
    >
  >,
  base: SessionContext,
): SessionContext => ({
  goal: body.goal !== undefined ? body.goal || null : base.goal,
  setting: body.setting !== undefined ? body.setting || null : base.setting,
  difficulty: body.difficulty !== undefined ? body.difficulty || null : base.difficulty,
  environment: body.environment !== undefined ? body.environment || null : base.environment,
  existingSupports:
    body.existing_supports !== undefined ? body.existing_supports || null : base.existingSupports,
  burden: body.burden !== undefined ? body.burden || null : base.burden,
});
const noContext: SessionContext = {
  goal: null,
  setting: null,
  difficulty: null,
  environment: null,
  existingSupports: null,
  burden: null,
};
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
    (await withContext(db, ctx, sessions)).map(async (session) => {
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
  if (existing)
    return result({ session: (await withContext(db, ctx, [existing]))[0], replayed: true });
  const id = randomUUID();
  const context = contextOf(body, noContext);
  const [row] = await db
    .insert(specialistSchema.specialistSessions)
    .values({
      id,
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      pathway: body.pathway,
      voluntary: "yes",
      idempotencyKey,
      contextSourceId: await recordContext(db, ctx, id, 1, context, null),
      difficultyCategories: body.difficulty_categories,
      scopeFlags: body.scope_flags,
      environmentCategories: body.environment_categories,
      selfReportedDiagnosis:
        body.pathway === "adhd" ? (body.self_reported_diagnosis ?? null) : null,
      skippedSteps: body.skipped_steps,
    })
    .returning();
  return result({ session: row && { ...row, ...context } }, 201);
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
  const context = contextOf(body, session);
  const changes = {
    ...context,
    ...(body.difficulty_categories !== undefined
      ? { difficultyCategories: body.difficulty_categories }
      : {}),
    ...(body.scope_flags !== undefined ? { scopeFlags: body.scope_flags } : {}),
    ...(body.environment_categories !== undefined
      ? { environmentCategories: body.environment_categories }
      : {}),
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
      ([key, value]) => JSON.stringify(session[key as keyof Session]) === JSON.stringify(value),
    );
    if (session.version === body.expected_version + 1 && same)
      return result({ session, replayed: true });
    return result({ error: "version_conflict", current_version: session.version }, 409);
  }
  const contextChanged = contextFields.some(([key]) => context[key] !== session[key]);
  const { goal, setting, difficulty, environment, existingSupports, burden, ...structured } =
    changes;
  const contextSourceId = contextChanged
    ? await recordContext(
        db,
        ctx,
        session.id,
        session.version + 1,
        context,
        session.contextSourceId,
      )
    : session.contextSourceId;
  const [updated] = await db
    .update(specialistSchema.specialistSessions)
    .set({ ...structured, contextSourceId, version: session.version + 1, updatedAt: new Date() })
    .where(
      and(
        eq(specialistSchema.specialistSessions.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistSessions.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistSessions.id, session.id),
        eq(specialistSchema.specialistSessions.version, body.expected_version),
      ),
    )
    .returning();
  return updated
    ? result({ session: { ...updated, ...context } })
    : result({ error: "version_conflict" }, 409);
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
  return updated
    ? result({ session: (await withContext(db, ctx, [updated]))[0] })
    : result({ error: "version_conflict" }, 409);
}
