import { type Db, schema } from "@findme/db";
import { and, asc, eq, lte } from "drizzle-orm";
import type { TaskEnqueuer } from "./enqueue.js";

const DISPATCH_RETRY_MS = 60_000;

// Repair pending tasks whose initial Queue send failed. Queue delivery is
// still idempotent: the consumer claims by task id before doing any work.
export async function dispatchDueTasks(db: Db, enqueue: TaskEnqueuer, limit = 20): Promise<number> {
  const tasks = await db
    .select({ id: schema.asyncTasks.id })
    .from(schema.asyncTasks)
    .where(
      and(eq(schema.asyncTasks.status, "pending"), lte(schema.asyncTasks.nextRunAt, new Date())),
    )
    .orderBy(asc(schema.asyncTasks.nextRunAt))
    .limit(limit);

  let dispatched = 0;
  for (const task of tasks) {
    try {
      await enqueue(task.id);
      dispatched++;
    } catch {
      await db
        .update(schema.asyncTasks)
        .set({
          nextRunAt: new Date(Date.now() + DISPATCH_RETRY_MS),
          errorMessage: "queue_dispatch_failed",
        })
        .where(eq(schema.asyncTasks.id, task.id));
    }
  }
  return dispatched;
}
