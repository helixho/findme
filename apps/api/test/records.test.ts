import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ accessToken: "t", db });
// 注入 fake gateway 测对话(不真调 LLM):chat 回显最后一条用户消息
const chatGateway = {
  extract: async () => ({}) as never,
  chat: async (input: { messages: { role: string; content: string }[] }) => ({
    text: `接住:${input.messages.at(-1)?.content ?? ""}`,
    meta: { model: "fake", latencyMs: 0, status: "ok" },
  }),
};
const appLlm = createApp({ accessToken: "t", db, gateway: chatGateway });
const headers = { "content-type": "application/json" }; // 本地阶段无需 token

beforeEach(async () => {
  await db.delete(schema.asyncTasks);
  await db.delete(schema.safetyEvents);
  await db.delete(schema.lightExtracts); // FK 依赖 raw_records,先删
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("POST /api/records(M-A3 速记)", () => {
  it("创建速记落 raw_records + 入队 light_extract", async () => {
    const res = await app.request("/api/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "今天试用找我", user_tags: ["测试"] }),
    });
    expect(res.status).toBe(201);
    const { record, crisis } = await res.json();
    expect(record.sourceType).toBe("quick_note");
    expect(record.content.text).toBe("今天试用找我");
    expect(record.userContext.tags).toEqual(["测试"]);
    expect(crisis).toBeNull();
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.taskType).toBe("light_extract");
  });

  it("空内容被 zod 拒绝返回 400", async () => {
    const res = await app.request("/api/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("命中危机:非阻断——记录照常入库 + 返回资源 + 写 safety_events(M-S1)", async () => {
    const res = await app.request("/api/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "我不想活了" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record.id).toBeTruthy(); // 记录照常保存,不拦截
    expect(body.crisis.resources.length).toBeGreaterThan(0);
    const events = await db.select().from(schema.safetyEvents);
    expect(events.length).toBe(1);
    expect(events[0]?.triggerMeta).toMatchObject({ record_id: body.record.id });
  });
});

describe("GET /api/records", () => {
  it("返回最近记录(倒序)", async () => {
    await app.request("/api/records", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "第一条" }),
    });
    const res = await app.request("/api/records");
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items.length).toBe(1);
    expect(items[0].content.text).toBe("第一条");
  });

  it("隐藏记录:置 visibility=hidden,GET 不再返回(append-only 不硬删)", async () => {
    const created = await (
      await app.request("/api/records", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "想隐藏的一条" }),
      })
    ).json();
    const res = await app.request(`/api/records/${created.record.id}/hide`, { method: "POST" });
    expect(res.status).toBe(200);
    const { items } = await (await app.request("/api/records")).json();
    expect(items.find((r: { id: string }) => r.id === created.record.id)).toBeUndefined();
    // 行仍在库,只是 visibility=hidden
    const [row] = await db.select().from(schema.rawRecords);
    expect(row?.visibility).toBe("hidden");
  });

  it("隐藏不存在的记录 → 404", async () => {
    const res = await app.request("/api/records/00000000-0000-0000-0000-000000000000/hide", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/records/import(M-A3 文本导入)", () => {
  it("长文切分为多条 uploaded_text 记录 + 逐条入队 extract", async () => {
    const text = ["第一段。".repeat(120), "第二段。".repeat(120), "第三段。".repeat(120)].join(
      "\n\n",
    );
    const res = await app.request("/api/records/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(201);
    const { created } = await res.json();
    expect(created).toBeGreaterThanOrEqual(2);
    const recs = await db.select().from(schema.rawRecords);
    expect(recs.every((r) => r.sourceType === "uploaded_text")).toBe(true);
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks.length).toBe(created);
  });
  it("空文本被拒 400", async () => {
    const res = await app.request("/api/records/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/records/dialogue(M-A1 对话)", () => {
  it("有角色 + gateway:写 dialogue 记录 + 入队 extract + 返回 LLM 回应", async () => {
    const res = await appLlm.request("/api/records/dialogue", {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "晨", message: "今天有点累", history: [] }),
    });
    expect(res.status).toBe(201);
    const { record, reply } = await res.json();
    expect(record.sourceType).toBe("dialogue");
    expect(record.content.text).toBe("今天有点累");
    expect(record.content.role).toBe("晨");
    expect(reply).toContain("今天有点累"); // fake gateway 回显
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks.length).toBe(1); // 用户的话入队抽取
  });

  it("角色「空白」:纯记录、不产生回应(reply=null),仍入队抽取", async () => {
    const res = await appLlm.request("/api/records/dialogue", {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "空白", message: "只想自己写写" }),
    });
    expect(res.status).toBe(201);
    const { record, reply } = await res.json();
    expect(record.sourceType).toBe("dialogue");
    expect(reply).toBeNull();
    expect((await db.select().from(schema.asyncTasks)).length).toBe(1);
  });

  it("无 gateway:降级不阻断——记录照写,reply=null", async () => {
    const res = await app.request("/api/records/dialogue", {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "夜", message: "睡前说一句" }),
    });
    expect(res.status).toBe(201);
    const { record, reply } = await res.json();
    expect(record.sourceType).toBe("dialogue");
    expect(reply).toBeNull();
  });

  it("对话命中危机:非阻断 + 资源 + safety_events(M-S1)", async () => {
    const res = await appLlm.request("/api/records/dialogue", {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "夜", message: "我不想活了" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record.id).toBeTruthy();
    expect(body.crisis.resources.length).toBeGreaterThan(0);
    expect((await db.select().from(schema.safetyEvents)).length).toBe(1);
  });
});

describe("POST /api/records/by-ids(证据溯源)", () => {
  it("按 id 返回记录摘要(日期/来源/preview),保持入参顺序,含隐藏标记", async () => {
    const [a] = await db
      .insert(schema.rawRecords)
      .values({ sourceType: "quick_note", content: { text: "第一条:关于独立审查的想法" } })
      .returning();
    const [b] = await db
      .insert(schema.rawRecords)
      .values({
        sourceType: "uploaded_text",
        content: { text: "x".repeat(120) },
        visibility: "hidden",
      })
      .returning();
    if (!a || !b) throw new Error("seed 失败");
    // 入参顺序 [b, a] → 返回顺序应一致
    const res = await app.request("/api/records/by-ids", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [b.id, a.id] }),
    });
    expect(res.status).toBe(200);
    const { records } = await res.json();
    expect(records.map((r: { id: string }) => r.id)).toEqual([b.id, a.id]); // 保序
    expect(records[0].sourceType).toBe("uploaded_text");
    expect(records[0].hidden).toBe(true); // 隐藏记录仍可溯,带标记
    expect(records[0].preview.endsWith("…")).toBe(true); // 超 80 字截断
    expect(records[1].hidden).toBe(false);
    expect(records[1].preview).toBe("第一条:关于独立审查的想法");
  });

  it("空 ids → 空数组;不存在的 id 被跳过", async () => {
    const empty = await app.request("/api/records/by-ids", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [] }),
    });
    expect((await empty.json()).records).toEqual([]);
    const ghost = await app.request("/api/records/by-ids", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: ["00000000-0000-0000-0000-000000000000"] }),
    });
    expect((await ghost.json()).records).toEqual([]);
  });
});
