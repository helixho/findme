import { createDb, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildCorpus, generateProfileSnapshot } from "../src/llm/profile.js";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);

// fake gateway:不真调 LLM
const fakeCandidate = {
  title: "倾向先理解再回应",
  summary: "在几次互动里先听后说",
  facts: ["没有立刻反驳"],
  inferences: ["可能更在意怎么回应"],
  evidence: ["先听他说完"],
  evidence_ordinals: [1], // 引用语料第 1 行(seed 后唯一一条)
  confidence: 0.7,
  sufficient: true,
};
const gateway = {
  extract: async () => fakeCandidate,
  chat: async () => ({ text: "", meta: { model: "fake", latencyMs: 0, status: "ok" } }),
};
const app = createApp({ accessToken: "t", db, gateway });
const headers = { "content-type": "application/json" };

async function seed(): Promise<string> {
  const [rec] = await db
    .insert(schema.rawRecords)
    .values({ sourceType: "quick_note", content: { text: "会议上先问了为什么" } })
    .returning();
  if (!rec) throw new Error("seed 失败");
  await db.insert(schema.lightExtracts).values({
    sourceRecordId: rec.id,
    topics: ["工作"],
    emotionHints: [],
    mentionedObjects: ["会议"],
    userTags: [],
    evidenceSnippets: ["先问了为什么"],
    confidence: 0.8,
    extractionVersion: "extract_agent@v1",
  });
  return rec.id;
}

beforeEach(async () => {
  await db.delete(schema.asyncTasks);
  await db.delete(schema.insightFeedback);
  await db.delete(schema.insights);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("画像快照(洞察=快照,回顾=快照间变化)", () => {
  it("POST /snapshot:入队异步任务(202 queued)", async () => {
    await seed();
    const res = await app.request("/api/insights/snapshot", { method: "POST" });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("queued");
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks[0]?.taskType).toBe("profile_snapshot");
  });

  it("已有 pending 任务→不重复入队(防连点)", async () => {
    await seed();
    await app.request("/api/insights/snapshot", { method: "POST" });
    const res2 = await app.request("/api/insights/snapshot", { method: "POST" });
    expect((await res2.json()).status).toBe("already_pending");
    expect((await db.select().from(schema.asyncTasks)).length).toBe(1);
  });

  it("语料未变→up_to_date 不重跑;force=1 可强制(人工纠错)", async () => {
    await seed();
    await generateProfileSnapshot(db, gateway); // 先有一份快照(recordCount=1)
    const res = await app.request("/api/insights/snapshot", { method: "POST" });
    expect((await res.json()).status).toBe("up_to_date");
    const res2 = await app.request("/api/insights/snapshot?force=1", { method: "POST" });
    expect((await res2.json()).status).toBe("queued");
  });

  it("无语料→400 no_corpus", async () => {
    const res = await app.request("/api/insights/snapshot", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("generateProfileSnapshot:9 维持久化为 insights 行;GET /profile 读到", async () => {
    await seed();
    await generateProfileSnapshot(db, gateway);
    const res = await app.request("/api/insights/profile");
    const { latest, previous, queued } = await res.json();
    expect(queued).toBe(false);
    expect(previous).toBeNull();
    expect(latest.insightType).toBe("profile_snapshot");
    const meta = latest.generationMeta as { dimensions: unknown[]; recordCount: number };
    expect(meta.dimensions.length).toBe(9);
    expect(meta.recordCount).toBe(1);
    // 快照不进"认下的洞察"列表
    const list = await app.request("/api/insights");
    expect((await (await list).json()).items.length).toBe(0);
  });

  it("两次快照→GET /profile 给 latest+previous(回顾对比)", async () => {
    await seed();
    await generateProfileSnapshot(db, gateway);
    await generateProfileSnapshot(db, gateway);
    const { latest, previous } = await (await app.request("/api/insights/profile")).json();
    expect(latest).toBeTruthy();
    expect(previous).toBeTruthy();
    expect(latest.id).not.toBe(previous.id);
  });
});

const fakeDive = {
  hidden_narrative: "x",
  core_emotion: "x",
  triggers: ["x"],
  fundamental_contradiction: "想要简洁却不断加层",
  toxic_loop: "x",
  constructive_loop: "x",
  high_leverage: ["x"],
  high_cost: ["x"],
  shadow_monologue: "x",
  future_monologue: "x",
  metaphor: "给花园修篱笆的人",
  hard_truth: "x",
  challenge: "x",
  closing_question: "x?",
  evidence: ["先问了为什么"],
  evidence_ordinals: [1],
  confidence: 0.7,
};
const diveGateway = { extract: async () => fakeDive };

describe("深析(Dr. Sharp 式锋利镜)", () => {
  it("POST /deepdive 入队;连点去重", async () => {
    await seed();
    const r1 = await app.request("/api/insights/deepdive", { method: "POST" });
    expect(r1.status).toBe(202);
    const r2 = await app.request("/api/insights/deepdive", { method: "POST" });
    expect((await r2.json()).status).toBe("already_pending");
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks.filter((t) => t.taskType === "deep_dive").length).toBe(1);
  });

  it("generateDeepDive 持久化;GET /deepdive 读到;不混入认下列表", async () => {
    await seed();
    const { generateDeepDive } = await import("../src/llm/deepdive.js");
    await generateDeepDive(db, diveGateway);
    const { latest, queued } = await (await app.request("/api/insights/deepdive")).json();
    expect(queued).toBe(false);
    expect(latest.insightType).toBe("deep_dive");
    expect(latest.content).toBe("给花园修篱笆的人"); // content=隐喻
    expect(latest.generationMeta.closing_question).toBe("x?");
    expect((await (await app.request("/api/insights")).json()).items.length).toBe(0);
  });

  it("无语料→400", async () => {
    const res = await app.request("/api/insights/deepdive", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/insights/ask(临时提问)", () => {
  it("带问题→一条候选(dimension=ask)", async () => {
    await seed();
    const res = await app.request("/api/insights/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "我有哪些特点" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).insight.dimension).toBe("ask");
  });
});

const candidateBody = {
  dimension: "values",
  label: "价值与边界",
  insight_type: "value",
  title: "倾向把独立客观放在很高的位置",
  summary: "在多处强调审查独立性",
  facts: ["反复强调独立审查"],
  inferences: ["可能更信任机制而非默认流程"],
  evidence: ["review 和 verify 是否重叠"],
  confidence: 0.75,
};

describe("固化 Insight + 认/不认(逐条证据强约束)", () => {
  it("带可溯证据→固化;evidence_refs 精确等于该洞察的 record_id(非全量语料);deny→隐藏", async () => {
    const recId = await seed();
    const save = await app.request("/api/insights", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...candidateBody, evidence_record_ids: [recId] }),
    });
    expect(save.status).toBe(201);
    const { insight } = await save.json();
    // 逐条绑定:正好是该洞察的证据记录,不是盲绑当前全量语料
    expect(insight.evidenceRefs.l1_record_ids).toEqual([recId]);
    expect(insight.generationMeta.evidence_record_ids).toEqual([recId]);
    await app.request(`/api/insights/${insight.id}/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "deny" }),
    });
    expect((await (await app.request("/api/insights")).json()).items.length).toBe(0);
  });

  it("无可溯证据(evidence_record_ids 为空)→拒绝固化 400,且不入库", async () => {
    await seed(); // 即便有语料,缺逐条证据也拒
    const save = await app.request("/api/insights", {
      method: "POST",
      headers,
      body: JSON.stringify(candidateBody), // 不带 evidence_record_ids
    });
    expect(save.status).toBe(400);
    expect((await save.json()).error).toBe("无可溯证据,拒绝固化");
    expect((await db.select().from(schema.insights)).length).toBe(0);
  });

  it("洞察反馈:准确/部分准确/不准确 + 原因入库", async () => {
    const recId = await seed();
    const save = await app.request("/api/insights", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...candidateBody, evidence_record_ids: [recId] }),
    });
    const { insight } = await save.json();
    const res = await app.request(`/api/insights/${insight.id}/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rating: "partial", reason: "方向对,但程度偏重", dimension: "values" }),
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(schema.insightFeedback);
    expect(rows[0]).toMatchObject({
      insightId: insight.id,
      rating: "partial",
      reason: "方向对,但程度偏重",
      dimension: "values",
    });
  });
});

describe("buildCorpus 隐藏过滤(M-S2:隐藏不参与分析)", () => {
  it("记录置 hidden 后,其 light_extract 不再计入语料", async () => {
    const { buildCorpus } = await import("../src/llm/profile.js");
    const [rec] = await db
      .insert(schema.rawRecords)
      .values({ sourceType: "quick_note", content: { text: "待隐藏" } })
      .returning();
    if (!rec) throw new Error("插入失败");
    await db.insert(schema.lightExtracts).values({
      sourceRecordId: rec.id,
      topics: ["t"],
      evidenceSnippets: ["待隐藏"],
      confidence: 0.9,
      extractionVersion: "t",
    });
    const before = await buildCorpus(db);
    await db
      .update(schema.rawRecords)
      .set({ visibility: "hidden" })
      .where(eq(schema.rawRecords.id, rec.id));
    const after = await buildCorpus(db);
    expect(after.recordCount).toBe(before.recordCount - 1);
  });
});

describe("证据粒度(P1:逐条可溯)", () => {
  it("buildCorpus.index 给出 [n]→record_id 映射,行文本带日期与来源", async () => {
    const recId = await seed();
    const { index, text } = await buildCorpus(db);
    expect(index.length).toBe(1);
    expect(index[0]?.ord).toBe(1);
    expect(index[0]?.recordId).toBe(recId);
    expect(index[0]?.sourceType).toBe("quick_note");
    expect(index[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(text).toContain("quick_note");
  });

  it("快照逐维度解析证据;evidence_refs.l1_record_ids = 各维度并集(由真实引用派生)", async () => {
    const recId = await seed();
    await generateProfileSnapshot(db, gateway); // fakeCandidate.evidence_ordinals=[1]
    const { latest } = await (await app.request("/api/insights/profile")).json();
    expect(latest.evidenceRefs.l1_record_ids).toEqual([recId]);
    const dims = latest.generationMeta.dimensions as Array<{
      evidence_record_ids: string[];
      evidence_status: string;
    }>;
    expect(dims[0]?.evidence_record_ids).toEqual([recId]);
    expect(dims[0]?.evidence_status).toBe("ok");
  });

  it("ask 把模型序号解析为 evidence_record_ids 随候选返回", async () => {
    const recId = await seed();
    const res = await app.request("/api/insights/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "我有哪些特点" }),
    });
    const { insight } = await res.json();
    expect(insight.evidence_record_ids).toEqual([recId]);
  });

  it("断言但无可溯证据(序号空/越界)→维度标 unverified 且降级 sufficient=false", async () => {
    await seed();
    // 断言:有 inferences + sufficient=true,但 evidence_ordinals 全越界 → 解析为空
    const unverifiedGateway = {
      extract: async () => ({
        title: "x",
        summary: "x",
        facts: ["f"],
        inferences: ["i"], // 断言
        evidence: ["e"],
        evidence_ordinals: [999], // 越界 → 解析为空
        confidence: 0.6,
        sufficient: true,
      }),
      chat: async () => ({ text: "", meta: { model: "fake", latencyMs: 0, status: "ok" } }),
    };
    await generateProfileSnapshot(db, unverifiedGateway);
    const { latest } = await (await app.request("/api/insights/profile")).json();
    expect(latest.evidenceRefs.l1_record_ids).toEqual([]); // 并集为空
    const d = (latest.generationMeta.dimensions as Array<Record<string, unknown>>)[0];
    expect(d?.evidence_status).toBe("unverified");
    expect(d?.sufficient).toBe(false); // 降级,不静默当作有据
  });

  it("深析断言无可溯证据(序号越界)→标 unverified,不拒(探索期点了就给)", async () => {
    await seed();
    const { generateDeepDive } = await import("../src/llm/deepdive.js");
    await generateDeepDive(db, {
      extract: async () => ({ ...fakeDive, evidence_ordinals: [999] }),
    });
    const { latest } = await (await app.request("/api/insights/deepdive")).json();
    expect(latest.insightType).toBe("deep_dive"); // 仍入库
    expect(latest.evidenceRefs.l1_record_ids).toEqual([]);
    expect(latest.generationMeta.evidence_status).toBe("unverified");
  });

  it("序号混合(有效+越界+重复)→只保留有效且去重", async () => {
    const recId = await seed();
    const res = await app.request("/api/insights/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "x" }),
    });
    // ask 默认 gateway 返回 evidence_ordinals=[1];这里改用注入校验解析行为
    const { resolveEvidence } = await import("../src/llm/evidence.js");
    const { index } = await (await import("../src/llm/profile.js")).buildCorpus(db);
    expect(resolveEvidence([1, 1, 999, -0, 2], index)).toEqual([recId]); // 重复去重、越界(999/2)丢弃
    expect((await res.json()).insight.evidence_record_ids).toEqual([recId]);
  });

  it("一条记录多条 light_extract→证据 record_id 去重(不双计)", async () => {
    const recId = await seed();
    // 同一 record 再加一条 extract(共 2 行语料,ord 1、2,同一 recordId)
    await db.insert(schema.lightExtracts).values({
      sourceRecordId: recId,
      topics: ["再补"],
      evidenceSnippets: ["第二段"],
      confidence: 0.7,
      extractionVersion: "extract_agent@v1",
    });
    const { resolveEvidence } = await import("../src/llm/evidence.js");
    const { index, recordCount } = await (await import("../src/llm/profile.js")).buildCorpus(db);
    expect(recordCount).toBe(2); // 2 行语料
    expect(resolveEvidence([1, 2], index)).toEqual([recId]); // 但去重为 1 个 record_id
  });
});
