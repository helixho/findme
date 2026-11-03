import type { Db } from "@findme/db";
import { sql } from "drizzle-orm";
import { accountRuntimeRoleQuery } from "./cloud-diagnostic/runtime-role.js";

type HealthStatus = "ok" | "degraded";

// Queue-backed production does not need a permanent worker heartbeat. Health
// reflects the database and the task backlog/error state instead.
export async function readHealth(db: Db) {
  const checks: {
    db: HealthStatus;
    queue: HealthStatus;
  } = { db: "ok", queue: "ok" };
  const detail: Record<string, unknown> = {};

  try {
    await db.execute(sql`select 1`);
  } catch {
    checks.db = "degraded";
    detail.db = "database_unavailable";
  }

  try {
    const [queue] = await db.execute<{
      pending: string;
      running: string;
      failed: string;
      due_pending: string;
      stale_running: string;
    }>(sql`
      select
        count(*) filter (where status = 'pending')::text as pending,
        count(*) filter (where status = 'running')::text as running,
        count(*) filter (
          where status = 'failed' and created_at >= now() - interval '24 hours'
        )::text as failed,
        count(*) filter (where status = 'pending' and next_run_at <= now())::text as due_pending,
        count(*) filter (
          where status = 'running'
            and lease_expires_at is not null
            and lease_expires_at < now()
        )::text as stale_running
      from async_tasks
    `);
    const staleRunning = Number(queue?.stale_running ?? 0);
    const failed = Number(queue?.failed ?? 0);
    const duePending = Number(queue?.due_pending ?? 0);
    detail.queue = {
      pending: Number(queue?.pending ?? 0),
      running: Number(queue?.running ?? 0),
      failed,
      duePending,
      staleRunning,
    };
    if (staleRunning > 0 || failed > 0 || duePending > 0) checks.queue = "degraded";
  } catch {
    checks.queue = "degraded";
    detail.queue = "task_state_unavailable";
  }

  const status: HealthStatus = Object.values(checks).every((x) => x === "ok") ? "ok" : "degraded";
  return { status, checks, detail };
}

/** Account runtimes have no permission to enumerate the legacy global task queue. */
export async function readAccountHealth(db: Db) {
  const checks: { db: HealthStatus; runtime_role: HealthStatus } = { db: "ok", runtime_role: "ok" };
  try {
    const [role] = await db.execute(accountRuntimeRoleQuery);
    if (role?.allowed !== true) checks.runtime_role = "degraded";
  } catch {
    checks.db = "degraded";
    checks.runtime_role = "degraded";
  }
  return {
    status: Object.values(checks).every((x) => x === "ok") ? "ok" : "degraded",
    checks,
    detail: { queue: "account_scoped_not_enumerated" },
  };
}
