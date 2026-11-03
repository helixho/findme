import { createDb, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimTaskById, completeTask, failTask } from "../src/tasks/claim.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);

beforeEach(async () => {
  await db.delete(schema.asyncTasks);
});
afterAll(async () => {
  await sql.end();
});

describe("claimTaskById(Queue 租约)", () => {
  it("领取 pending 任务并设置租约", async () => {
    const [row] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "light_extract", payload: {} })
      .returning();
    const t = await claimTaskById(db, row.id, { workerId: "w1", leaseSeconds: 60 });
    expect(t?.status).toBe("running");
    expect(t?.lockedBy).toBe("w1");
  });
  it("回收租约过期的 running 任务", async () => {
    const [row] = await db
      .insert(schema.asyncTasks)
      .values({
        taskType: "light_extract",
        payload: {},
        status: "running",
        lockedBy: "dead",
        leaseExpiresAt: new Date(Date.now() - 1000),
      })
      .returning();
    const t = await claimTaskById(db, row.id, { workerId: "w2", leaseSeconds: 60 });
    expect(t?.lockedBy).toBe("w2"); // 被回收
  });
  it("completeTask 置 completed 并释放租约(B4)", async () => {
    const [row] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "x", payload: {} })
      .returning();
    await claimTaskById(db, row.id, { workerId: "w1", leaseSeconds: 60 });
    await completeTask(db, row.id);
    const [after] = await db
      .select()
      .from(schema.asyncTasks)
      .where(eq(schema.asyncTasks.id, row.id));
    expect(after.status).toBe("completed");
    expect(after.lockedBy).toBeNull();
  });
  it("failTask 未达上限退回 pending 并退避(B4)", async () => {
    const [row] = await db
      .insert(schema.asyncTasks)
      .values({ taskType: "x", payload: {}, maxRetries: 3 })
      .returning();
    await claimTaskById(db, row.id, { workerId: "w1", leaseSeconds: 60 });
    await failTask(db, row.id, "boom");
    const [after] = await db
      .select()
      .from(schema.asyncTasks)
      .where(eq(schema.asyncTasks.id, row.id));
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
  });
});
