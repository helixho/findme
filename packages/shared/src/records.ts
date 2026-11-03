import { z } from "zod";

export const SourceType = z.enum([
  "dialogue",
  "quick_note",
  "questionnaire_response",
  "uploaded_text",
  "material_feedback", // 读学习素材后的反馈(带素材关联)
]);
export type SourceType = z.infer<typeof SourceType>;

export const Visibility = z.enum(["active", "hidden", "archived"]);
export type Visibility = z.infer<typeof Visibility>;

// M-O1 轻量结构化输出(LightExtract)
export const LightExtract = z.object({
  topics: z.array(z.string()),
  emotion_hints: z.array(z.string()).default([]),
  mentioned_objects: z.array(z.string()).default([]),
  user_tags: z.array(z.string()).default([]),
  evidence_snippets: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type LightExtract = z.infer<typeof LightExtract>;

// 创建速记的入参
export const CreateQuickNote = z.object({
  content: z.string().min(1),
  user_tags: z.array(z.string()).optional(),
});
export type CreateQuickNote = z.infer<typeof CreateQuickNote>;

// 导入文本(M-A3 uploaded_text):长文切分为多条记录,各自入队 M-O1。上限防失控。
export const ImportText = z.object({
  text: z.string().min(1).max(500_000),
  source_meta: z.record(z.unknown()).optional(),
});
export type ImportText = z.infer<typeof ImportText>;

// M-O5 洞察候选(LLM 输出):事实与推测分离,证据 + 置信度 + 数据充分性。非诊断、候选不固化。
export const InsightCandidate = z.object({
  title: z.string(), // 该维度一句话发现
  summary: z.string(),
  facts: z.array(z.string()).default([]), // verified:语料里直接有的(原话/频率/反复)
  inferences: z.array(z.string()).default([]), // inference:推断(须能由 facts 推出)
  evidence: z.array(z.string()).default([]), // 引用的原文片段
  evidence_ordinals: z.array(z.number().int().positive()).default([]), // 证据依据的语料行序号 [n](由代码侧解析为 record_id)
  confidence: z.number().min(0).max(1),
  sufficient: z.boolean(), // 语料是否足够;false=只给很初步印象
});
export type InsightCandidate = z.infer<typeof InsightCandidate>;

// 对话一轮(M-A1):角色骨架 + 用户消息 + 近况上下文。角色边界在后端 prompt 强制。
export const DialogueTurn = z.object({
  role: z.enum(["晨", "夜", "空白"]),
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["char", "user"]), text: z.string() }))
    .max(40)
    .default([]),
});
export type DialogueTurn = z.infer<typeof DialogueTurn>;

// 提问驱动洞察入参
export const AskInsight = z.object({ question: z.string().min(1).max(500) });
export type AskInsight = z.infer<typeof AskInsight>;

// 证据溯源:按 record_id 批量取记录摘要(供洞察展示"由哪几条记录支撑")
export const RecordIds = z.object({ ids: z.array(z.string()).max(300) });
export type RecordIds = z.infer<typeof RecordIds>;

// 把候选洞察"标记为重要"→ 固化为 Insight(T4)
export const SaveInsight = z.object({
  dimension: z.string(),
  label: z.string(),
  insight_type: z.string(),
  title: z.string().min(1),
  summary: z.string().default(""),
  facts: z.array(z.string()).default([]),
  inferences: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  evidence_record_ids: z.array(z.string()).default([]), // 生成时已解析的逐条证据 record_id;空=无可溯证据,拒绝固化
  confidence: z.number().min(0).max(1),
});
export type SaveInsight = z.infer<typeof SaveInsight>;

// 对已固化 Insight 的确认/否认/补充
export const AckInsight = z.object({
  action: z.enum(["confirm", "deny", "note"]),
  note: z.string().max(2000).optional(),
});
export type AckInsight = z.infer<typeof AckInsight>;

// 提交答题(M-A2)→ 存 questionnaire_response 记录
export const QuestionnaireResponse = z.object({
  questionnaire_id: z.string().optional(),
  summary: z.string().min(1),
  answers: z.array(z.object({ prompt: z.string(), answer: z.string() })).default([]),
});
export type QuestionnaireResponse = z.infer<typeof QuestionnaireResponse>;

// 深析(Dr. Sharp 式锋利镜,探索期全开;LLM 输出契约)
export const DeepDive = z.object({
  hidden_narrative: z.string(), // 反复出现却未明说的底层故事线
  core_emotion: z.string(), // 驱动模式的核心情绪及可能来源
  triggers: z.array(z.string()).default([]),
  fundamental_contradiction: z.string(), // 想要 X 却做着妨碍 X 的 Y
  toxic_loop: z.string(), // 情境→反应→后果→强化
  constructive_loop: z.string(),
  high_leverage: z.array(z.string()).default([]), // 80/20 高杠杆行动
  high_cost: z.array(z.string()).default([]), // 高成本低回报消耗
  shadow_monologue: z.string(), // 阴影之我独白(推测性叙事)
  future_monologue: z.string(), // n 个月后的我独白
  metaphor: z.string(), // 反直觉隐喻
  hard_truth: z.string(), // 语料支撑的不适真相
  challenge: z.string(), // 一周内可做的针对性挑战
  closing_question: z.string(), // 把球交回用户的结束性提问
  evidence: z.array(z.string()).default([]),
  evidence_ordinals: z.array(z.number().int().positive()).default([]), // 证据依据的语料行序号 [n]
  confidence: z.number().min(0).max(1),
});
export type DeepDive = z.infer<typeof DeepDive>;
