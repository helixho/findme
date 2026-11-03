import { type Db, schema } from "@findme/db";
import { DeepDive } from "@findme/shared";
import { sql } from "drizzle-orm";
import { resolveEvidence } from "./evidence.js";
import type { createGateway } from "./gateway.js";
import { buildCorpus } from "./profile.js";

type Gateway = Pick<ReturnType<typeof createGateway>, "extract">;

export const DEEPDIVE_TYPE = "deep_dive";
export const DEEPDIVE_VERSION = "deepdive_agent@v1";

// Dr. Sharp 式深析(锋利镜):递归挖掘 + 循环识别 + 镜像独白 + 收尾四件套。
// 探索期全开(用户决议 2026-06-12);产品化再加知情入口/语气档位/合规禁令。
// 质量线(非合规线):证据链硬性、只析模式因果不做道德评判、不诊断。
const DEEPDIVE_PROMPT = `你是「找我」的深析助手——一面更锋利的镜子。用户主动选择了这次深析:诚实优先于客套,直说语料支撑的真相;但只分析模式与因果,不做道德评判,不贴诊断标签。
对每个发现追问"它背后的为什么",持续向下挖,直到语料撑不住为止。
基于语料严格输出如下 JSON(字段全必填;尖括号是占位说明,必须替换为真实内容):
{
  "hidden_narrative": "<用户叙述自己时反复出现、却未明说的底层故事线>",
  "core_emotion": "<驱动这些模式的核心情绪,及它可能的来源(只取语料可支撑的)>",
  "triggers": ["<最容易触发该模式的情境,1-3 条>"],
  "fundamental_contradiction": "<最深的一组底层矛盾:想要 X,却持续做着妨碍 X 的 Y>",
  "toxic_loop": "<一条正在消耗用户的循环:情境→反应→后果→强化>",
  "constructive_loop": "<一条值得替换上去的循环,具体可执行>",
  "high_leverage": ["<20% 投入换 80% 改变的高杠杆行动,1-3 条>"],
  "high_cost": ["<80% 投入只换 20% 回报的高成本消耗,1-3 条>"],
  "shadow_monologue": "<以「阴影之我」第一人称写 ≤200 字独白:那个被压下去的部分想说什么>",
  "future_monologue": "<以「六个月后的我」第一人称写 ≤200 字独白:若循环被替换,那时回看现在>",
  "metaphor": "<一个反直觉但贴切的隐喻,概括用户当前处境>",
  "hard_truth": "<一句用户可能不想听、但语料支撑的真相>",
  "challenge": "<一个针对性的、一周内可完成的挑战>",
  "closing_question": "<一个把球交回用户的精准提问——不是修辞,是真的需要回答的>",
  "evidence": ["<支撑以上判断的原文片段,3-5 条,直接引用不改写>"],
  "evidence_ordinals": [1, 4, 7],
  "confidence": 0.0
}
规则:每个判断都要能落到语料上;宁可锋利而准,不要锋利而空;两段独白是推测性叙事、不是事实陈述;绝不诊断。evidence_ordinals 填以上判断所依据的语料行序号 [n](整数列表,只填语料真实出现的序号)。只输出 JSON。`;

// 生成一次深析并持久化(insights 行,type=deep_dive)。单次大调用,走 worker 异步。
export async function generateDeepDive(db: Db, gateway: Gateway, taskId?: string): Promise<string> {
  const { text, recordCount, index } = await buildCorpus(db);
  if (recordCount === 0) throw new Error("无语料,无法深析");
  const t0 = Date.now();
  const dive = await gateway.extract({
    route: "observation_model",
    system: DEEPDIVE_PROMPT,
    text,
    schema: DeepDive,
    strategy: "json_mode",
  });
  const evidenceRecordIds = resolveEvidence(dive.evidence_ordinals, index);
  // 深析为用户显式触发的异步分析(探索期"点了就给"),不拒;无可溯证据时标 unverified
  const evidenceStatus = evidenceRecordIds.length === 0 ? "unverified" : "ok";
  const [row] = await db
    .insert(schema.insights)
    .values({
      insightType: DEEPDIVE_TYPE,
      content: dive.metaphor,
      evidenceRefs: { l1_record_ids: evidenceRecordIds },
      generationMeta: {
        ...dive,
        evidence_record_ids: evidenceRecordIds,
        evidence_status: evidenceStatus,
        recordCount,
        version: DEEPDIVE_VERSION,
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
  if (!row) throw new Error("深析保存失败");
  await db.insert(schema.llmCallLogs).values({
    agentKey: "deepdive_agent",
    modelUsed: "via-gateway",
    taskType: DEEPDIVE_TYPE,
    latencyMs: Date.now() - t0,
    status: "ok",
  });
  return row.id;
}
