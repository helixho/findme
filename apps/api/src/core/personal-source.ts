import { type Db, coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "./exploration-service.js";

/**
 * The single place where text the person provides is stored. Features keep only the source id
 * and read the text back from here; no feature keeps its own copy of personal input.
 */
export async function recordPersonalSource(
  db: Db,
  ctx: PersonalContext,
  input: {
    id?: string;
    kind: string;
    content: string;
    externalRef: string;
    meta: Record<string, unknown>;
    /** When the described event happened; unknown unless the input states it. Capture time is created_at. */
    occurredAt?: Date;
    rationale: string;
    complete?: boolean;
    /** The source this one replaces; the replaced source stops being used. */
    replaces?: string | null;
  },
) {
  const [source] = await db
    .insert(coreSchema.sourceItems)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      sourceKind: input.kind,
      authorKind: "subject",
      content: input.content,
      occurredAt: input.occurredAt ?? null,
      externalRef: input.externalRef,
      sourceMeta: input.meta,
    })
    .returning();
  if (!source) throw new Error("PERSONAL_SOURCE_CREATE_FAILED");
  await db.insert(coreSchema.sourceAssessments).values({
    sourceItemId: source.id,
    version: 1,
    attributionStatus: "confirmed_subject",
    contextCompleteness: input.complete === false ? "partial" : "sufficient",
    temporalPrecision: input.occurredAt ? "exact" : "unknown",
    eligibility: "needs_review",
    rationale: input.rationale,
  });
  await db.insert(coreSchema.evidenceSpans).values({
    sourceItemId: source.id,
    quote: input.content,
    locator: { kind: input.kind, verbatim: true },
    authorKind: "subject",
    aboutSubject: true,
  });
  if (input.replaces) {
    await db.insert(coreSchema.sourceLinks).values({
      sourceItemId: source.id,
      targetSourceItemId: input.replaces,
      relation: "corrects",
    });
    await setPersonalSourceStatus(db, ctx, [input.replaces], "superseded");
  }
  return source;
}

export async function setPersonalSourceStatus(
  db: Db,
  ctx: PersonalContext,
  ids: string[],
  status: "active" | "excluded" | "superseded",
) {
  if (!ids.length) return;
  await db
    .update(coreSchema.sourceItems)
    .set({ usageStatus: status })
    .where(
      and(
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        inArray(coreSchema.sourceItems.id, ids),
      ),
    );
}

/** Reads personal sources back by id, scoped to the Profile. */
export async function readPersonalSources(db: Db, ctx: PersonalContext, ids: string[]) {
  if (!ids.length) return new Map<string, typeof coreSchema.sourceItems.$inferSelect>();
  const rows = await db
    .select()
    .from(coreSchema.sourceItems)
    .where(
      and(
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        inArray(coreSchema.sourceItems.id, ids),
      ),
    );
  return new Map(rows.map((row) => [row.id, row]));
}
