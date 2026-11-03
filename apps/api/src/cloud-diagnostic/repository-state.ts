import { diagnosticSchema as tables } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ProfileTransaction } from "./scope.js";
const runs = tables.diagnosticRuns;
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("DIAGNOSTIC_WRITE_FAILED");
  return value;
}
export function key(value: string) {
  if (!value.trim() || value.length > 200)
    throw new CoreError("IDEMPOTENCY_KEY_REQUIRED", 400, "需要有效的 Idempotency-Key");
  return value;
}
export function sameRequest(expected: string, actual: string) {
  if (expected !== actual)
    throw new CoreError("IDEMPOTENCY_KEY_REUSED", 409, "幂等键已用于不同请求");
}
export async function runFor(tx: ProfileTransaction, ctx: PersonalContext, id: string) {
  const [row] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.tenantId, ctx.tenantId), eq(runs.subjectId, ctx.subjectId)))
    .limit(1)
    .for("update");
  if (!row) throw new CoreError("DIAGNOSTIC_NOT_FOUND", 404, "诊断不存在");
  return row;
}
export function currentVersion(run: typeof runs.$inferSelect, expected: number) {
  if (run.version !== expected || run.status === "archived")
    throw new CoreError("STALE_VERSION", 409, "诊断版本已经变化", { current_version: run.version });
}
export async function publicationLock(tx: ProfileTransaction, ctx: PersonalContext) {
  // Acquire before source/job/run locks. Topic corrections and all publications
  // share one order, so an overall cannot publish across a correction or deadlock
  // a topic publication while propagating its invalidation.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${JSON.stringify([ctx.tenantId, ctx.subjectId, "diagnostic-publication"])}, 0))`);
}
