import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { processTask } from "../src/tasks/process.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);

// fake 抽取:不真调 LLM,返回固定结构,保证测试离线、确定
const fakeDeps = {
  modelName: "fake-model",
  lightExtract: async () => ({
    topics: ["工作"],
    emotion_hints: ["平静"],
    mentioned_objects: ["会议"],
    user_tags: [],
    evidence_snippets: ["先问了一句为什么"],
    confidence: 0.8,
  }),
};

async function seedRecord(): Promise<string> {
  const [rec] = await db
    .insert(schema.rawRecords)
    .values({ sourceType: "quick_note", content: { text: "会议上先问了为什么" } })
    .returning();
  if (!rec) throw new Error("seed 失败");
  return rec.id;
}

beforeEach(async () => {
  await db.delete(schema.llmCallLogs);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("processTask(M-O1 light_extract)", () => {
  it("抽取落 light_extracts + 写 llm_call_logs 审计", async () => {
    const recordId = await seedRecord();
    await processTask(
      db,
      { id: "t1", taskType: "light_extract", payload: { record_id: recordId } },
      fakeDeps,
    );

    const [ext] = await db.select().from(schema.lightExtracts);
    expect(ext?.sourceRecordId).toBe(recordId);
    expect(ext?.topics).toEqual(["工作"]);
    expect(ext?.confidence).toBeCloseTo(0.8);
    expect(ext?.extractionVersion).toBe("extract_agent@v1");

    const [log] = await db.select().from(schema.llmCallLogs);
    expect(log?.agentKey).toBe("extract_agent");
    expect(log?.status).toBe("ok");
    expect(log?.modelUsed).toBe("fake-model");
  });

  it("抽取失败:写 error 审计并抛出(交 worker 退避)", async () => {
    const recordId = await seedRecord();
    const failing = {
      modelName: "fake-model",
      lightExtract: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      processTask(
        db,
        { id: "t2", taskType: "light_extract", payload: { record_id: recordId } },
        failing,
      ),
    ).rejects.toThrow("boom");
    const [log] = await db.select().from(schema.llmCallLogs);
    expect(log?.status).toBe("error");
    expect(await db.select().from(schema.lightExtracts)).toHaveLength(0);
  });

  it("未知任务类型:不处理、不报错", async () => {
    await processTask(db, { id: "t3", taskType: "unknown_x", payload: {} }, fakeDeps);
    expect(await db.select().from(schema.lightExtracts)).toHaveLength(0);
  });

  it("缺 record_id:抛出", async () => {
    await expect(
      processTask(db, { id: "t4", taskType: "light_extract", payload: {} }, fakeDeps),
    ).rejects.toThrow("record_id");
  });
});
