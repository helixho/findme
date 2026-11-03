import { LightExtract } from "@findme/shared";
import type { createGateway } from "./gateway.js";

// M-O1 抽取 agent。R2 的 agent_registry/Call Audit 完整接法留待后续;现以常量承载 prompt + 版本。
export const EXTRACTION_VERSION = "extract_agent@v1";

const EXTRACT_PROMPT = `你是「找我」的轻量结构化助手。把用户的一条原始记录客观归纳为结构化字段——只基于文本本身,不推断、不评判、不诊断。严格输出 JSON,字段:
- topics:涉及主题(名词短语)2–5 个
- emotion_hints:文本显露的情绪线索词,只取文本支持的,无则空数组,不贴诊断标签
- mentioned_objects:提到的具体人/物/事(只抽文本,不建实体)
- user_tags:保留用户自带标签,可补 0–2 个明显标签
- evidence_snippets:支撑归纳的原文片段(直接摘录、不改写)1–3 条
- confidence:0~1 的数字,对本次归纳贴合原文的把握
规则:不超出文本所说;宁少勿编;不确定就降 confidence;只输出 JSON,不要任何解释。`;

type Gateway = ReturnType<typeof createGateway>;

// 经 M-X2 gateway 调 LLM,json_mode + LightExtract zod 校验。失败由调用方标记任务 failed。
export async function runLightExtract(gateway: Gateway, text: string): Promise<LightExtract> {
  const result = await gateway.extract({
    route: "extraction_model",
    system: EXTRACT_PROMPT,
    text,
    schema: LightExtract,
    strategy: "json_mode",
  });
  return {
    topics: result.topics,
    emotion_hints: result.emotion_hints ?? [],
    mentioned_objects: result.mentioned_objects ?? [],
    user_tags: result.user_tags ?? [],
    evidence_snippets: result.evidence_snippets,
    confidence: result.confidence,
  };
}
