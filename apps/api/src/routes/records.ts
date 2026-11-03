import { type Db, schema } from "@findme/db";
import { CreateQuickNote, DialogueTurn, ImportText, RecordIds } from "@findme/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { generateReply } from "../llm/dialogue.js";
import type { createGateway } from "../llm/gateway.js";
import { detectCrisis } from "../safety/crisis.js";
import { type TaskEnqueuer, createTask } from "../tasks/enqueue.js";

type LlmGateway = Pick<ReturnType<typeof createGateway>, "chat">;

// 导入长文切分:按段落聚合到 ~800 字/条;超长段落硬切;总条数封顶防失控。
const CHUNK_TARGET = 800;
const CHUNK_HARD = 1500;
const MAX_CHUNKS = 300;
export function chunkText(text: string): string[] {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  for (const p of paras) {
    if (p.length > CHUNK_HARD) {
      flush();
      for (let i = 0; i < p.length; i += CHUNK_HARD) chunks.push(p.slice(i, i + CHUNK_HARD));
      continue;
    }
    if (buf.length + p.length + 2 > CHUNK_TARGET) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks.slice(0, MAX_CHUNKS);
}

// M-A3 自由采集 + 文本导入 + L1 回看。LLM 相关(对话/抽取)不在此,见 llm/ 与 worker。
export function recordsRoutes(db: Db, gateway?: LlmGateway, enqueue?: TaskEnqueuer) {
  const r = new Hono();

  async function enqueueExtract(recordId: string) {
    await createTask(
      db,
      {
        taskType: "light_extract",
        payload: { record_id: recordId },
      },
      enqueue,
    );
  }

  async function flagCrisis(text: string, recordId: string) {
    const crisis = detectCrisis(text);
    if (crisis.hit) {
      await db.insert(schema.safetyEvents).values({
        triggerType: "keyword_match",
        ruleId: crisis.ruleId,
        triggerMeta: { record_id: recordId },
        resourcesShown: crisis.resources,
      });
    }
    return crisis;
  }

  // 最近的 L1 记录(append-only;只回 active,隐藏的不出现在时间线)
  r.get("/", async (c) => {
    const items = await db
      .select()
      .from(schema.rawRecords)
      .where(eq(schema.rawRecords.visibility, "active"))
      .orderBy(desc(schema.rawRecords.createdAt))
      .limit(200);
    return c.json({ items });
  });

  // 证据溯源:按 id 批量取记录摘要(洞察展示"由哪几条记录支撑")。
  // 不按 visibility 过滤——证据是历史切片,即使记录后来被隐藏也应可溯(附 hidden 标记)。
  r.post("/by-ids", zValidator("json", RecordIds), async (c) => {
    const { ids } = c.req.valid("json");
    if (ids.length === 0) return c.json({ records: [] });
    const rows = await db
      .select({
        id: schema.rawRecords.id,
        createdAt: schema.rawRecords.createdAt,
        sourceType: schema.rawRecords.sourceType,
        visibility: schema.rawRecords.visibility,
        content: schema.rawRecords.content,
      })
      .from(schema.rawRecords)
      .where(inArray(schema.rawRecords.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    // 保持调用方给定的 id 顺序
    const records = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => {
        const raw = (row.content as { text?: unknown }).text;
        const text = typeof raw === "string" ? raw : "";
        return {
          id: row.id,
          createdAt: row.createdAt,
          sourceType: row.sourceType,
          hidden: row.visibility !== "active",
          preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        };
      });
    return c.json({ records });
  });

  // 隐藏一条记录(L1 不硬删:仅置 visibility=hidden,从时间线移除;语料与既有快照不回溯)
  r.post("/:id/hide", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .update(schema.rawRecords)
      .set({ visibility: "hidden" })
      .where(eq(schema.rawRecords.id, id))
      .returning({ id: schema.rawRecords.id });
    if (!row) return c.json({ error: "记录不存在" }, 404);
    return c.json({ id: row.id, visibility: "hidden" });
  });

  // 速记 → 写 raw_records;M-S1 非阻断危机识别;触发 M-O1 轻量结构化(异步入队)
  r.post("/", zValidator("json", CreateQuickNote), async (c) => {
    const body = c.req.valid("json");

    const [record] = await db
      .insert(schema.rawRecords)
      .values({
        sourceType: "quick_note",
        content: { text: body.content },
        userContext: body.user_tags ? { tags: body.user_tags } : {},
      })
      .returning();
    if (!record) throw new Error("创建记录失败");

    // M-S1:命中不拦截——记录照常入库,仅附资源卡片并记 safety_events 元数据(原文不重存)
    const crisis = await flagCrisis(body.content, record.id);
    await enqueueExtract(record.id); // M-O1
    return c.json({ record, crisis: crisis.hit ? { resources: crisis.resources } : null }, 201);
  });

  // M-A1 对话一轮:写 dialogue 记录(用户的话即语料)→ M-S1 危机识别 → 入队抽取 →
  // 经 M-X2 按角色 prompt 生成回应(角色「空白」纯记录、不回应)。助手回应不入语料(非用户表达)。
  r.post("/dialogue", zValidator("json", DialogueTurn), async (c) => {
    const { role, message, history } = c.req.valid("json");

    const [record] = await db
      .insert(schema.rawRecords)
      .values({
        sourceType: "dialogue",
        content: { text: message, role },
        sourceMeta: { role },
      })
      .returning();
    if (!record) throw new Error("创建对话记录失败");

    const crisis = await flagCrisis(message, record.id);
    await enqueueExtract(record.id);

    let reply: string | null = null;
    if (gateway && role !== "空白") {
      const t0 = Date.now();
      try {
        reply = await generateReply(gateway, role, message, history);
        await db.insert(schema.llmCallLogs).values({
          agentKey: "dialogue_agent",
          modelUsed: "via-gateway",
          taskType: "dialogue",
          latencyMs: Date.now() - t0,
          status: "ok",
        });
      } catch {
        reply = null; // LLM 失败不阻断:记录已存,回应缺省
        await db.insert(schema.llmCallLogs).values({
          agentKey: "dialogue_agent",
          modelUsed: "via-gateway",
          taskType: "dialogue",
          latencyMs: Date.now() - t0,
          status: "error",
        });
      }
    }

    return c.json(
      { record, reply, crisis: crisis.hit ? { resources: crisis.resources } : null },
      201,
    );
  });

  // M-A3 文本导入(uploaded_text):长文切分为多条记录,各自入队 M-O1。
  // 批量导入不做逐条危机弹卡(无单一交互时刻);情绪/危机在洞察侧再呈现。
  r.post("/import", zValidator("json", ImportText), async (c) => {
    const { text, source_meta } = c.req.valid("json");
    const chunks = chunkText(text);
    let created = 0;
    for (const chunk of chunks) {
      const [rec] = await db
        .insert(schema.rawRecords)
        .values({
          sourceType: "uploaded_text",
          content: { text: chunk },
          sourceMeta: source_meta ?? {},
        })
        .returning();
      if (!rec) continue;
      await enqueueExtract(rec.id);
      created++;
    }
    return c.json({ created, chunks: chunks.length }, 201);
  });

  return r;
}
