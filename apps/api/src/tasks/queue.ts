import type { Db } from "@findme/db";
import { claimTaskById, completeTask, failTask, readTaskState, renewTaskLease } from "./claim.js";
import { type ProcessDeps, processTask } from "./process.js";

export type QueueTaskMessage = { task_id: string };

export type QueueMessageLike = {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type TaskConsumeResult = "completed" | "failed" | "retrying" | "busy" | "noop" | "invalid";

const LEASE_SECONDS = 900;
const RETRY_DELAY_SECONDS = 30;

function retryDelaySeconds(nextRunAt: Date | null | undefined) {
  if (!nextRunAt) return RETRY_DELAY_SECONDS;
  return Math.min(300, Math.max(1, Math.ceil((nextRunAt.getTime() - Date.now()) / 1000)));
}

export function parseTaskMessage(body: unknown): QueueTaskMessage | null {
  if (!body || typeof body !== "object") return null;
  const taskId = (body as { task_id?: unknown }).task_id;
  return typeof taskId === "string" && taskId.length > 0 && taskId.length <= 100
    ? { task_id: taskId }
    : null;
}

// One message is claimed by task id, processed, then explicitly acked. A
// duplicate that meets a live lease is retried; completed/failed/missing work
// is acknowledged as a no-op.
export async function consumeTaskMessage(args: {
  db: Db;
  message: QueueMessageLike;
  deps: ProcessDeps;
  workerId: string;
}): Promise<TaskConsumeResult> {
  const parsed = parseTaskMessage(args.message.body);
  if (!parsed) {
    args.message.ack();
    return "invalid";
  }

  let task = null;
  try {
    task = await claimTaskById(args.db, parsed.task_id, {
      workerId: args.workerId,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch {
    args.message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    return "retrying";
  }

  if (!task) {
    try {
      const state = await readTaskState(args.db, parsed.task_id);
      const leaseExpiresAt = state?.leaseExpiresAt;
      if (state?.status === "running" && leaseExpiresAt && leaseExpiresAt > new Date()) {
        args.message.retry({ delaySeconds: retryDelaySeconds(leaseExpiresAt) });
        return "busy";
      }
      if (state?.status === "pending") {
        args.message.retry({ delaySeconds: retryDelaySeconds(state.nextRunAt) });
        return "retrying";
      }
      args.message.ack();
      return "noop";
    } catch {
      args.message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      return "retrying";
    }
  }

  const leaseRenewal = setInterval(
    () => {
      void renewTaskLease(args.db, task.id, args.workerId, LEASE_SECONDS).catch(() => undefined);
    },
    (LEASE_SECONDS * 1000) / 3,
  );

  try {
    await processTask(args.db, task, args.deps);
    const completed = await completeTask(args.db, task.id, args.workerId);
    if (!completed) {
      const state = await readTaskState(args.db, task.id).catch(() => null);
      if (state?.status === "completed" || state?.status === "failed") {
        args.message.ack();
        return "noop";
      }
      args.message.retry({ delaySeconds: retryDelaySeconds(state?.nextRunAt) });
      return "retrying";
    }
    args.message.ack();
    return "completed";
  } catch {
    const failure = await failTask(args.db, task.id, "queue_task_failed", args.workerId).catch(
      () => null,
    );

    if (!failure || failure.status === "pending") {
      args.message.retry({
        delaySeconds: failure
          ? Math.min(300, RETRY_DELAY_SECONDS * failure.retryCount)
          : RETRY_DELAY_SECONDS,
      });
      return "retrying";
    }

    args.message.ack();
    return "failed";
  } finally {
    clearInterval(leaseRenewal);
  }
}
