import { type Db, schema } from "@findme/db";
import { and, sql as dsql, eq } from "drizzle-orm";

// B2:raw SQL `RETURNING t.*` 给出 snake_case 列名;统一映射为 camelCase,不让 snake 泄漏到业务层
export type ClaimedTask = {
  id: string;
  taskType: string;
  status: string;
  payload: Record<string, unknown>;
  lockedBy: string | null;
  retryCount: number;
  maxRetries: number;
};
function mapTask(row: Record<string, unknown>): ClaimedTask {
  return {
    id: row.id as string,
    taskType: row.task_type as string,
    status: row.status as string,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    lockedBy: (row.locked_by as string | null) ?? null,
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
  };
}

function rowsFromExecute(rows: unknown): Record<string, unknown>[] {
  return Array.isArray(rows)
    ? (rows as Record<string, unknown>[])
    : ((rows as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function firstClaimed(rows: unknown) {
  const row = rowsFromExecute(rows)[0];
  return row ? mapTask(row) : null;
}

// Queue delivery carries the authoritative task id. Claim only that task so a
// duplicate message cannot accidentally process a different pending task.
export async function claimTaskById(
  db: Db,
  id: string,
  opts: { workerId: string; leaseSeconds: number },
) {
  const rows = await db.execute(dsql`
    WITH next AS (
      SELECT id FROM async_tasks
      WHERE id = ${id}
        AND (
          (status = 'pending' AND next_run_at <= now())
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
        )
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE async_tasks t SET
      status = 'running', locked_by = ${opts.workerId}, locked_at = now(),
      lease_expires_at = now() + (${opts.leaseSeconds}::int * interval '1 second'),
      started_at = COALESCE(t.started_at, now())
    FROM next WHERE t.id = next.id
    RETURNING t.*;
  `);
  return firstClaimed(rows);
}

export async function renewTaskLease(db: Db, id: string, workerId: string, leaseSeconds: number) {
  const rows = await db.execute(dsql`
    UPDATE async_tasks SET
      lease_expires_at = now() + (${leaseSeconds}::int * interval '1 second')
    WHERE id = ${id} AND status = 'running' AND locked_by = ${workerId}
    RETURNING id;
  `);
  return rowsFromExecute(rows).length > 0;
}

export async function readTaskState(db: Db, id: string) {
  const [row] = await db
    .select({
      status: schema.asyncTasks.status,
      leaseExpiresAt: schema.asyncTasks.leaseExpiresAt,
      nextRunAt: schema.asyncTasks.nextRunAt,
    })
    .from(schema.asyncTasks)
    .where(eq(schema.asyncTasks.id, id))
    .limit(1);
  return row ?? null;
}

// B4:闭合生命周期 —— 成功
export async function completeTask(db: Db, id: string, workerId?: string) {
  const predicates = [eq(schema.asyncTasks.id, id), eq(schema.asyncTasks.status, "running")];
  if (workerId) predicates.push(eq(schema.asyncTasks.lockedBy, workerId));
  const [completed] = await db
    .update(schema.asyncTasks)
    .set({ status: "completed", completedAt: new Date(), lockedBy: null, leaseExpiresAt: null })
    .where(and(...predicates))
    .returning({ id: schema.asyncTasks.id });
  return Boolean(completed);
}

// B4:失败 —— 退避重试;达到 max_retries 置 failed
export async function failTask(db: Db, id: string, message: string, workerId?: string) {
  const owner = workerId ? dsql` AND locked_by = ${workerId}` : dsql``;
  const rows = await db.execute(dsql`
    UPDATE async_tasks SET
      retry_count = retry_count + 1,
      status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
      next_run_at = now() + (interval '30 seconds' * (retry_count + 1)),
      locked_by = NULL, lease_expires_at = NULL, error_message = ${message}
    WHERE id = ${id} AND status = 'running'${owner}
    RETURNING status, retry_count, max_retries;
  `);
  const row = rowsFromExecute(rows)[0];
  return row
    ? {
        status: String(row.status),
        retryCount: Number(row.retry_count),
        maxRetries: Number(row.max_retries),
      }
    : null;
}
