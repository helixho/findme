import { type Db, schema } from "@findme/db";
import type { LightExtract } from "@findme/shared";
import { eq, sql } from "drizzle-orm";

// 处理器依赖注入:lightExtract 抽取函数 + 可选画像生成器 + 模型名(审计)。测试注入 fake,不真调 LLM。
export type ProcessDeps = {
  lightExtract: (text: string) => Promise<LightExtract>;
  modelName: string;
  profileSnapshot?: (taskId: string) => Promise<string>; // 生成并持久化一次画像快照,返回快照 id
  deepDive?: (taskId: string) => Promise<string>; // 生成并持久化一次深析(锋利镜)
};
export type Task = { id: string; taskType: string; payload: Record<string, unknown> };

const EXTRACTION_VERSION = "extract_agent@v1"; // 与 llm/extract.ts 对齐;此处独立常量保持 process 不依赖 llm 模块

// worker 按任务类型分派。未知类型不处理,直接闭合(由调用方 completeTask)。
export async function processTask(db: Db, task: Task, deps: ProcessDeps): Promise<void> {
  if (task.taskType === "light_extract") {
    await processLightExtract(db, task, deps);
  } else if (task.taskType === "profile_snapshot") {
    if (!deps.profileSnapshot) throw new Error("profileSnapshot 处理器未注入");
    if (await hasTaskInsight(db, task.id)) return;
    await deps.profileSnapshot(task.id);
  } else if (task.taskType === "deep_dive") {
    if (!deps.deepDive) throw new Error("deepDive 处理器未注入");
    if (await hasTaskInsight(db, task.id)) return;
    await deps.deepDive(task.id);
  }
}

async function hasTaskInsight(db: Db, taskId: string) {
  const [row] = await db
    .select({ id: schema.insights.id })
    .from(schema.insights)
    .where(sql`${schema.insights.generationMeta}->>'async_task_id' = ${taskId}`)
    .limit(1);
  return Boolean(row);
}

async function processLightExtract(db: Db, task: Task, deps: ProcessDeps): Promise<void> {
  const recordId = task.payload.record_id as string | undefined;
  if (!recordId) throw new Error("light_extract 任务缺 record_id");

  const [rec] = await db.select().from(schema.rawRecords).where(eq(schema.rawRecords.id, recordId));
  if (!rec) throw new Error(`raw_record 不存在: ${recordId}`);

  // A lease can expire after the result is written but before the task is
  // marked completed. Never call the LLM or insert a second extract then.
  const [existing] = await db
    .select({ id: schema.lightExtracts.id })
    .from(schema.lightExtracts)
    .where(eq(schema.lightExtracts.asyncTaskId, task.id))
    .limit(1);
  if (existing) return;

  const text = (rec.content as { text?: string }).text ?? "";

  const t0 = Date.now();
  try {
    const r = await deps.lightExtract(text);
    const [inserted] = await db
      .insert(schema.lightExtracts)
      .values({
        sourceRecordId: recordId,
        asyncTaskId: task.id,
        topics: r.topics,
        emotionHints: r.emotion_hints,
        mentionedObjects: r.mentioned_objects,
        userTags: r.user_tags,
        evidenceSnippets: r.evidence_snippets,
        confidence: r.confidence,
        extractionVersion: EXTRACTION_VERSION,
      })
      .onConflictDoNothing()
      .returning({ id: schema.lightExtracts.id });
    if (!inserted) return;
    // Call Audit:写 llm_call_logs(只记元数据,不存原文/输出)
    await db.insert(schema.llmCallLogs).values({
      agentKey: "extract_agent",
      modelUsed: deps.modelName,
      taskType: "light_extract",
      latencyMs: Date.now() - t0,
      status: "ok",
    });
  } catch (error) {
    await db.insert(schema.llmCallLogs).values({
      agentKey: "extract_agent",
      modelUsed: deps.modelName,
      taskType: "light_extract",
      latencyMs: Date.now() - t0,
      status: "error",
      errorCode: "provider_error",
    });
    throw error; // 由 worker 走 B4 失败退避
  }
}
