import { createDb, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { dispatchDueTasks } from "../src/tasks/dispatch.js";
import { type QueueMessageLike, consumeTaskMessage } from "../src/tasks/queue.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);

function fakeMessage(body: unknown) {
  const state = { acked: 0, retries: 0, lastDelay: 0 };
  const message: QueueMessageLike = {
    body,
    ack: () => {
      state.acked++;
    },
    retry: (options) => {
      state.retries++;
      state.lastDelay = options?.delaySeconds ?? 0;
    },
  };
  return { message, state };
}

const deps = {
  modelName: "fake-model",
  lightExtract: async () => ({
    topics: ["工作"],
    emotion_hints: [],
    mentioned_objects: [],
    user_tags: [],
    evidence_snippets: ["一段测试文本"],
    confidence: 0.8,
  }),
};

beforeEach(async () => {
  await db.delete(schema.insightFeedback);
  await db.delete(schema.insights);
  await db.delete(schema.llmCallLogs);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
  await db.delete(schema.asyncTasks);
});
afterAll(async () => {
  await sql.end();
});

describe("Cloudflare Queue task consumer", () => {
  it("API 写任务后只把 task_id 投递到 Queue", async () => {
    const queued: string[] = [];
    const app = createApp({
      db,
      auth: { mode: "none" },
      enqueueTask: async (taskId) => {
        queued.push(taskId);
      },
    });

    const response = await app.request("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Queue smoke" }),
    });
    const [task] = await db.select().from(schema.asyncTasks);

    expect(response.status).toBe(201);
    expect(task?.taskType).toBe("light_extract");
    expect(queued).toEqual([task?.id]);
  });

  it("Queue 投递连续失败会有限重试并标记任务失败", async () => {
    let attempts = 0;
    const app = createApp({
      db,
      auth: { mode: "none" },
      enqueueTask: async () => {
        attempts++;
        throw new Error("synthetic queue failure");
      },
    });

    const response = await app.request("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Queue failure smoke" }),
    });
    const [task] = await db.select().from(schema.asyncTasks);

    expect(response.status).toBe(500);
    expect(attempts).toBe(3);
    expect(task?.status).toBe("pending");
    expect(task?.errorMessage).toBe("queue_enqueue_failed");
  });

  it("定时修复会重新投递到期的 pending 任务", async () => {
    const [due] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", nextRunAt: new Date(Date.now() - 1000) })
      .returning();
    await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", nextRunAt: new Date(Date.now() + 120_000) });
    const dispatched: string[] = [];

    const count = await dispatchDueTasks(db, async (taskId) => {
      dispatched.push(taskId);
    });

    expect(count).toBe(1);
    expect(dispatched).toEqual([due.id]);
  });

  it("按 task_id 处理并完成任务", async () => {
    const [record] = await db
      .insert(schema.rawRecords)
      .values({ sourceType: "quick_note", content: { text: "一段测试文本" } })
      .returning();
    const [task] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", payload: { record_id: record.id } })
      .returning();
    const { message, state } = fakeMessage({ task_id: task.id });

    const result = await consumeTaskMessage({ db, message, deps, workerId: "queue-test" });
    const [after] = await db
      .select()
      .from(schema.asyncTasks)
      .where(eq(schema.asyncTasks.id, task.id));

    expect(result).toBe("completed");
    expect(after.status).toBe("completed");
    expect(await db.select().from(schema.lightExtracts)).toHaveLength(1);
    expect(state).toMatchObject({ acked: 1, retries: 0 });
  });

  it("已完成任务的重复投递是 no-op", async () => {
    const [task] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", status: "completed" })
      .returning();
    const { message, state } = fakeMessage({ task_id: task.id });
    let calls = 0;

    const result = await consumeTaskMessage({
      db,
      message,
      deps: {
        ...deps,
        lightExtract: async () => {
          calls++;
          return deps.lightExtract();
        },
      },
      workerId: "queue-test",
    });

    expect(result).toBe("noop");
    expect(calls).toBe(0);
    expect(state).toMatchObject({ acked: 1, retries: 0 });
  });

  it("数据库尚未到 next_run_at 时不会提前 ack", async () => {
    const [task] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", nextRunAt: new Date(Date.now() + 120_000) })
      .returning();
    const { message, state } = fakeMessage({ task_id: task.id });

    const result = await consumeTaskMessage({ db, message, deps, workerId: "queue-test" });

    expect(result).toBe("retrying");
    expect(state.acked).toBe(0);
    expect(state.retries).toBe(1);
    expect(state.lastDelay).toBeGreaterThan(1);
  });

  it("临时失败更新 DB 并请求 Queue 重试", async () => {
    const [record] = await db
      .insert(schema.rawRecords)
      .values({ sourceType: "quick_note", content: { text: "一段测试文本" } })
      .returning();
    const [task] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", payload: { record_id: record.id } })
      .returning();
    const { message, state } = fakeMessage({ task_id: task.id });

    const result = await consumeTaskMessage({
      db,
      message,
      deps: {
        ...deps,
        lightExtract: async () => {
          throw new Error("synthetic failure");
        },
      },
      workerId: "queue-test",
    });
    const [after] = await db
      .select()
      .from(schema.asyncTasks)
      .where(eq(schema.asyncTasks.id, task.id));

    expect(result).toBe("retrying");
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(state.acked).toBe(0);
    expect(state.retries).toBe(1);
    expect(state.lastDelay).toBeGreaterThan(0);
  });

  it("已有任务结果时重复消费不再生成画像", async () => {
    const [task] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "profile_snapshot", payload: {} })
      .returning();
    await db.insert(schema.insights).values({
      insightType: "profile_snapshot",
      content: "已有结果",
      evidenceRefs: { l1_record_ids: [] },
      generationMeta: { async_task_id: task.id },
    });
    const { message, state } = fakeMessage({ task_id: task.id });

    const result = await consumeTaskMessage({
      db,
      message,
      deps: {
        ...deps,
        profileSnapshot: async () => {
          throw new Error("should not run");
        },
      },
      workerId: "queue-test",
    });
    const [after] = await db
      .select()
      .from(schema.asyncTasks)
      .where(eq(schema.asyncTasks.id, task.id));

    expect(result).toBe("completed");
    expect(after.status).toBe("completed");
    expect(state).toMatchObject({ acked: 1, retries: 0 });
  });
});
