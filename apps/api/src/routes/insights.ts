import { type Db, schema } from "@findme/db";
import { AckInsight, AskInsight, SaveInsight } from "@findme/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { DEEPDIVE_TYPE } from "../llm/deepdive.js";
import { resolveEvidence } from "../llm/evidence.js";
import type { createGateway } from "../llm/gateway.js";
import { generateInsight } from "../llm/insight.js";
import { SNAPSHOT_TYPE, buildCorpus } from "../llm/profile.js";
import { type TaskEnqueuer, createTask } from "../tasks/enqueue.js";

// 只用 extract;结构化类型便于测试注入 fake
type LlmGateway = Pick<ReturnType<typeof createGateway>, "extract">;
const InsightFeedbackBody = z.object({
  rating: z.enum(["accurate", "partial", "inaccurate"]),
  reason: z.string().max(1000).optional(),
  dimension: z.string().max(80).optional(),
});

export function insightsRoutes(db: Db, gateway: LlmGateway | undefined, enqueue?: TaskEnqueuer) {
  const r = new Hono();

  // ── 画像快照(洞察=单次快照;回顾=快照间变化)────────────────────────────
  // 入队异步生成:有 pending/running 同类任务→不重复;语料未变→不重跑(除非 force,人工纠错用)。
  r.post("/snapshot", async (c) => {
    const force = c.req.query("force") === "1";
    const { recordCount } = await buildCorpus(db);
    if (recordCount === 0) return c.json({ status: "no_corpus" }, 400);

    const pending = await db
      .select({ id: schema.asyncTasks.id })
      .from(schema.asyncTasks)
      .where(
        and(
          eq(schema.asyncTasks.taskType, SNAPSHOT_TYPE),
          inArray(schema.asyncTasks.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (pending.length > 0) return c.json({ status: "already_pending" });

    if (!force) {
      const [latest] = await db
        .select()
        .from(schema.insights)
        .where(eq(schema.insights.insightType, SNAPSHOT_TYPE))
        .orderBy(desc(schema.insights.generatedAt))
        .limit(1);
      const lastCount = (latest?.generationMeta as { recordCount?: number } | null)?.recordCount;
      if (latest && lastCount === recordCount) return c.json({ status: "up_to_date" });
    }

    await createTask(db, { taskType: SNAPSHOT_TYPE, payload: {} }, enqueue);
    return c.json({ status: "queued" }, 202);
  });

  // 最新快照 + 上一次(供"我的变化"对比)+ 是否在生成中
  r.get("/profile", async (c) => {
    const snaps = await db
      .select()
      .from(schema.insights)
      .where(eq(schema.insights.insightType, SNAPSHOT_TYPE))
      .orderBy(desc(schema.insights.generatedAt))
      .limit(2);
    const pending = await db
      .select({ id: schema.asyncTasks.id })
      .from(schema.asyncTasks)
      .where(
        and(
          eq(schema.asyncTasks.taskType, SNAPSHOT_TYPE),
          inArray(schema.asyncTasks.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    return c.json({
      latest: snaps[0] ?? null,
      previous: snaps[1] ?? null,
      queued: pending.length > 0,
    });
  });

  // ── 深析(Dr. Sharp 式锋利镜,异步;探索期不设 up_to_date 拦截,点了就给)──
  r.post("/deepdive", async (c) => {
    const { recordCount } = await buildCorpus(db);
    if (recordCount === 0) return c.json({ status: "no_corpus" }, 400);
    const pending = await db
      .select({ id: schema.asyncTasks.id })
      .from(schema.asyncTasks)
      .where(
        and(
          eq(schema.asyncTasks.taskType, DEEPDIVE_TYPE),
          inArray(schema.asyncTasks.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (pending.length > 0) return c.json({ status: "already_pending" });
    await createTask(db, { taskType: DEEPDIVE_TYPE, payload: {} }, enqueue);
    return c.json({ status: "queued" }, 202);
  });

  r.get("/deepdive", async (c) => {
    const [latest] = await db
      .select()
      .from(schema.insights)
      .where(eq(schema.insights.insightType, DEEPDIVE_TYPE))
      .orderBy(desc(schema.insights.generatedAt))
      .limit(1);
    const pending = await db
      .select({ id: schema.asyncTasks.id })
      .from(schema.asyncTasks)
      .where(
        and(
          eq(schema.asyncTasks.taskType, DEEPDIVE_TYPE),
          inArray(schema.asyncTasks.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    return c.json({ latest: latest ?? null, queued: pending.length > 0 });
  });

  // ── 提问驱动(临时补充,同步小调用;三视角=Trident)──────────────────────
  r.post("/ask", zValidator("json", AskInsight), async (c) => {
    if (!gateway) return c.json({ error: "LLM 未配置" }, 503);
    const { question } = c.req.valid("json");
    const { text, recordCount, index } = await buildCorpus(db);
    if (recordCount === 0) return c.json({ insight: null, recordCount: 0 });
    const lens = `用户的问题:「${question}」。请只就这个问题,基于语料给出克制、非诊断的回答;inferences 按三个视角各给 1-2 条,并以前缀标明——「框架:」(把发现放进更大的图景)、「批判:」(这个发现可能哪里站不住)、「行动:」(由此可做的一件具体小事)`;
    const t0 = Date.now();
    const cand = await generateInsight(gateway, lens, text);
    const evidenceRecordIds = resolveEvidence(cand.evidence_ordinals, index);
    await db.insert(schema.llmCallLogs).values({
      agentKey: "ask_agent",
      modelUsed: "via-gateway",
      taskType: "ask",
      latencyMs: Date.now() - t0,
      status: "ok",
    });
    return c.json(
      {
        insight: {
          dimension: "ask",
          label: "问 findme",
          insight_type: "ask",
          ...cand,
          evidence_record_ids: evidenceRecordIds,
        },
        recordCount,
      },
      200,
    );
  });

  // ── 固化的 Insight(用户认下的;不含画像快照)──────────────────────────
  r.get("/", async (c) => {
    const items = await db
      .select()
      .from(schema.insights)
      .where(
        and(
          eq(schema.insights.visibility, "active"),
          notInArray(schema.insights.insightType, [SNAPSHOT_TYPE, DEEPDIVE_TYPE]),
        ),
      )
      .orderBy(desc(schema.insights.generatedAt))
      .limit(100);
    return c.json({ items });
  });

  // 候选(快照里的某维度 / 问答结果)"标记为重要"→ 固化。
  // 逐条证据强约束:绑定该洞察生成时解析出的 record_id;无可溯证据 → 拒绝固化。
  r.post("/", zValidator("json", SaveInsight), async (c) => {
    const b = c.req.valid("json");
    const evidenceRecordIds = [...new Set(b.evidence_record_ids)];
    if (evidenceRecordIds.length === 0) {
      return c.json({ error: "无可溯证据,拒绝固化" }, 400);
    }
    const [ins] = await db
      .insert(schema.insights)
      .values({
        insightType: b.insight_type,
        content: b.title,
        evidenceRefs: { l1_record_ids: evidenceRecordIds },
        generationMeta: {
          dimension: b.dimension,
          label: b.label,
          summary: b.summary,
          facts: b.facts,
          inferences: b.inferences,
          evidence: b.evidence,
          evidence_record_ids: evidenceRecordIds,
          confidence: b.confidence,
        },
        acknowledgmentHistory: [{ action: "saved", at: new Date().toISOString() }],
      })
      .returning();
    if (!ins) throw new Error("保存洞察失败");
    return c.json({ insight: ins }, 201);
  });

  // 确认/否认/补充。deny → 隐藏(不再出现)。
  r.post("/:id/ack", zValidator("json", AckInsight), async (c) => {
    const id = c.req.param("id");
    const { action, note } = c.req.valid("json");
    const entry = { action, ...(note ? { note } : {}), at: new Date().toISOString() };
    await db
      .update(schema.insights)
      .set({
        acknowledgmentHistory: sql`${schema.insights.acknowledgmentHistory} || ${JSON.stringify([entry])}::jsonb`,
        ...(action === "deny" ? { visibility: "hidden" } : {}),
      })
      .where(eq(schema.insights.id, id));
    return c.json({ ok: true });
  });

  r.post("/:id/feedback", zValidator("json", InsightFeedbackBody), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const [insight] = await db
      .select({ id: schema.insights.id })
      .from(schema.insights)
      .where(eq(schema.insights.id, id))
      .limit(1);
    if (!insight) return c.json({ error: "insight_not_found" }, 404);
    const [feedback] = await db
      .insert(schema.insightFeedback)
      .values({
        insightId: id,
        dimension: body.dimension,
        rating: body.rating,
        reason: body.reason,
      })
      .returning();
    return c.json({ feedback }, 201);
  });

  return r;
}
