import { type Db, schema } from "@findme/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { type CorpusIndex, isAssertion, resolveEvidence } from "./evidence.js";
import type { createGateway } from "./gateway.js";
import { DIMENSIONS, SYNTHESIS, generateInsight } from "./insight.js";

type Gateway = Pick<ReturnType<typeof createGateway>, "extract">;

export const PROFILE_VERSION = "profile_agent@v1";
export const SNAPSHOT_TYPE = "profile_snapshot";

// 语料 = light_extracts 的脱水视图(主题/情绪/对象/原文片段),全量交叉、便宜可负担。上限防 token 爆。
// 每行带行序号 [n] + 时间 + 来源类型;index 给出 [n]→record_id 的权威映射(供证据解析)。
export async function buildCorpus(
  db: Db,
): Promise<{ text: string; recordCount: number; recordIds: string[]; index: CorpusIndex }> {
  // 隐藏的记录不参与回顾/洞察——join raw_records 过滤 visibility
  const rows = await db
    .select({ ext: schema.lightExtracts, record: schema.rawRecords })
    .from(schema.lightExtracts)
    .innerJoin(
      schema.rawRecords,
      and(
        eq(schema.lightExtracts.sourceRecordId, schema.rawRecords.id),
        eq(schema.rawRecords.visibility, "active"),
      ),
    )
    .orderBy(desc(schema.lightExtracts.extractedAt))
    .limit(300);
  const index: CorpusIndex = [];
  const lines = rows.map((r, i) => {
    const e = r.ext;
    const ord = i + 1;
    const topics = (e.topics ?? []).join("、") || "-";
    const emo = (e.emotionHints ?? []).join("、") || "-";
    const obj = (e.mentionedObjects ?? []).join("、") || "-";
    const snip = (e.evidenceSnippets ?? []).join(" / ");
    const created = r.record.createdAt;
    const day =
      created instanceof Date ? created.toISOString().slice(0, 10) : String(created).slice(0, 10);
    const src = r.record.sourceType;
    index.push({ ord, recordId: e.sourceRecordId, createdAt: day, sourceType: src });
    return `[${ord}] (${day} · ${src}) 主题:${topics} | 情绪:${emo} | 对象:${obj} | 原文:「${snip}」`;
  });
  return {
    text: lines.join("\n"),
    recordCount: rows.length,
    recordIds: [...new Set(index.map((e) => e.recordId))],
    index,
  };
}

// 生成一次完整画像快照(9 维顺序跑,防限流)并持久化为 insights 行。
// 洞察=单次快照;回顾=快照间的变化(由读取侧对比,不在此生成)。
export async function generateProfileSnapshot(
  db: Db,
  gateway: Gateway,
  taskId?: string,
): Promise<string> {
  const { text, recordCount, index } = await buildCorpus(db);
  if (recordCount === 0) throw new Error("无语料,无法生成画像");
  const t0 = Date.now();
  const dims: Record<string, unknown>[] = [];
  const evidenceUnion = new Set<string>();
  for (const d of [...DIMENSIONS, SYNTHESIS]) {
    try {
      const cand = await generateInsight(gateway, d.lens, text);
      const evidenceRecordIds = resolveEvidence(cand.evidence_ordinals, index);
      // 断言但无可溯证据 → 标 unverified 并降级为非断言(保留展示,不静默当作有据)
      const unverified = isAssertion(cand) && evidenceRecordIds.length === 0;
      for (const id of evidenceRecordIds) evidenceUnion.add(id);
      dims.push({
        dimension: d.key,
        label: d.label,
        insight_type: d.insightType,
        ...cand,
        ...(unverified ? { sufficient: false } : {}),
        evidence_record_ids: evidenceRecordIds,
        evidence_status: unverified ? "unverified" : "ok",
      });
    } catch (e) {
      console.error(`profile dim ${d.key} failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (dims.length === 0) throw new Error("全部维度生成失败");
  const synthesis = dims.find((x) => x.dimension === "synthesis") as { title?: string } | undefined;
  const [row] = await db
    .insert(schema.insights)
    .values({
      insightType: SNAPSHOT_TYPE,
      content: synthesis?.title ?? "画像快照",
      // 逐维度证据的并集(由真实引用派生,非盲绑全量语料);逐条证据见 generationMeta.dimensions[].evidence_record_ids
      evidenceRefs: { l1_record_ids: [...evidenceUnion] },
      generationMeta: {
        dimensions: dims,
        recordCount,
        version: PROFILE_VERSION,
        ...(taskId ? { async_task_id: taskId } : {}),
      },
    })
    .onConflictDoNothing()
    .returning();
  if (!row && taskId) {
    const [existing] = await db
      .select({ id: schema.insights.id })
      .from(schema.insights)
      .where(sql`${schema.insights.generationMeta}->>'async_task_id' = ${taskId}`)
      .limit(1);
    if (existing) return existing.id;
  }
  if (!row) throw new Error("快照保存失败");
  await db.insert(schema.llmCallLogs).values({
    agentKey: "profile_agent",
    modelUsed: "via-gateway",
    taskType: SNAPSHOT_TYPE,
    latencyMs: Date.now() - t0,
    status: "ok",
  });
  return row.id;
}
