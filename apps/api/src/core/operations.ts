import { type Db, coreSchema } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-service.js";

const LEASE_MS = 2 * 60 * 1000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestHash(value: unknown) {
  return sha256Hex(canonicalJson(value));
}

export type OperationStart =
  | { kind: "execute"; operationId: string }
  | { kind: "replay"; status: number; body: Record<string, unknown> }
  | { kind: "processing"; operationId: string };

export async function beginCoreOperation(
  db: Db,
  ctx: PersonalContext,
  args: {
    idempotencyKey: string;
    operationType: string;
    request: Record<string, unknown>;
    explorationId?: string;
    basisVersion?: number;
  },
): Promise<OperationStart> {
  const hash = await requestHash(args.request);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);

  const [existing] = await db
    .select()
    .from(coreSchema.coreOperations)
    .where(
      and(
        eq(coreSchema.coreOperations.tenantId, ctx.tenantId),
        eq(coreSchema.coreOperations.idempotencyKey, args.idempotencyKey),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.requestHash !== hash || existing.operationType !== args.operationType) {
      throw new CoreError("IDEMPOTENCY_KEY_REUSED", 409, "同一个 Idempotency-Key 不能用于不同请求");
    }

    if (existing.status === "completed" && existing.responseBody && existing.responseStatus) {
      return {
        kind: "replay",
        status: existing.responseStatus,
        body: existing.responseBody,
      };
    }

    if (
      existing.status === "processing" &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return { kind: "processing", operationId: existing.id };
    }

    await db
      .update(coreSchema.coreOperations)
      .set({
        status: "processing",
        basisVersion: args.basisVersion,
        explorationId: args.explorationId,
        leaseExpiresAt,
        responseStatus: null,
        responseBody: null,
        completedAt: null,
      })
      .where(eq(coreSchema.coreOperations.id, existing.id));
    return { kind: "execute", operationId: existing.id };
  }

  try {
    const [created] = await db
      .insert(coreSchema.coreOperations)
      .values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        explorationId: args.explorationId,
        idempotencyKey: args.idempotencyKey,
        operationType: args.operationType,
        requestHash: hash,
        basisVersion: args.basisVersion,
        leaseExpiresAt,
      })
      .returning({ id: coreSchema.coreOperations.id });
    if (!created) throw new Error("core_operation_create_failed");
    return { kind: "execute", operationId: created.id };
  } catch (error) {
    // A concurrent insert may win the unique key race. Re-read once; unrelated
    // database failures must surface instead of recursing forever.
    const [concurrent] = await db
      .select({ id: coreSchema.coreOperations.id })
      .from(coreSchema.coreOperations)
      .where(
        and(
          eq(coreSchema.coreOperations.tenantId, ctx.tenantId),
          eq(coreSchema.coreOperations.idempotencyKey, args.idempotencyKey),
        ),
      )
      .limit(1);
    if (!concurrent) throw error;
    return beginCoreOperation(db, ctx, args);
  }
}

export async function completeCoreOperation(
  db: Pick<Db, "update">,
  operationId: string,
  responseStatus: number,
  responseBody: Record<string, unknown>,
) {
  await db
    .update(coreSchema.coreOperations)
    .set({
      status: "completed",
      responseStatus,
      responseBody,
      leaseExpiresAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(coreSchema.coreOperations.id, operationId),
        eq(coreSchema.coreOperations.status, "processing"),
      ),
    );
}

export async function markCoreOperationFailed(
  db: Db,
  operationId: string,
  status: "failed" | "stale" = "failed",
) {
  await db
    .update(coreSchema.coreOperations)
    .set({
      status,
      leaseExpiresAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(coreSchema.coreOperations.id, operationId),
        eq(coreSchema.coreOperations.status, "processing"),
      ),
    );
}

export async function getCoreOperation(db: Db, ctx: PersonalContext, operationId: string) {
  const [row] = await db
    .select()
    .from(coreSchema.coreOperations)
    .where(
      and(
        eq(coreSchema.coreOperations.id, operationId),
        eq(coreSchema.coreOperations.tenantId, ctx.tenantId),
        eq(coreSchema.coreOperations.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Locks the operation row at the start of a commit. Source deletion updates
 * operation rows before claim revisions, so commits that later lock revisions
 * must take this lock first to keep a single lock order.
 */
export async function lockCoreOperation(db: Pick<Db, "select">, operationId: string) {
  await db
    .select({ id: coreSchema.coreOperations.id })
    .from(coreSchema.coreOperations)
    .where(eq(coreSchema.coreOperations.id, operationId))
    .for("update");
}
