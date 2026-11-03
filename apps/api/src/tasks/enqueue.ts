import { type Db, schema } from "@findme/db";
import { eq } from "drizzle-orm";

export type TaskEnqueuer = (taskId: string) => Promise<void>;
const QUEUE_SEND_ATTEMPTS = 3;

type NewTask = {
  taskType: string;
  payload?: Record<string, unknown>;
};

// Persist the audit row first, then hand only its id to the runtime queue.
// If queue delivery fails, leave a terminal task state so a later user action
// can enqueue a fresh task instead of being blocked by a phantom pending row.
export async function createTask(db: Db, task: NewTask, enqueue?: TaskEnqueuer): Promise<string> {
  const [created] = await db
    .insert(schema.asyncTasks)
    .values({ taskType: task.taskType, payload: task.payload ?? {} })
    .returning({ id: schema.asyncTasks.id });
  if (!created) throw new Error("创建异步任务失败");

  if (enqueue) {
    try {
      await enqueueWithRetry(enqueue, created.id);
    } catch (error) {
      await db
        .update(schema.asyncTasks)
        .set({
          status: "pending",
          nextRunAt: new Date(Date.now() + 30_000),
          errorMessage: "queue_enqueue_failed",
          lockedBy: null,
          leaseExpiresAt: null,
        })
        .where(eq(schema.asyncTasks.id, created.id));
      throw error;
    }
  }

  return created.id;
}

async function enqueueWithRetry(enqueue: TaskEnqueuer, taskId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= QUEUE_SEND_ATTEMPTS; attempt++) {
    try {
      await enqueue(taskId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < QUEUE_SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("queue_enqueue_failed");
}
