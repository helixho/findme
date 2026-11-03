import { InsightCandidate } from "@findme/shared";
import type { createGateway } from "./gateway.js";

type Gateway = Pick<ReturnType<typeof createGateway>, "extract">;

export type Dimension = { key: string; label: string; insightType: string; lens: string };

// me-模型固定维度网格。系统主动按这些维度分析,提问驱动为补充。
export const DIMENSIONS: Dimension[] = [
  {
    key: "topics",
    label: "关注主题",
    insightType: "frequency",
    lens: "用户反复关注、想到的主题,以及它们随时间的变化",
  },
  {
    key: "communication",
    label: "表达与沟通习惯",
    insightType: "behavioral_pattern",
    lens: "用户如何表达、如何与人或 agent 沟通的方式与风格",
  },
  {
    key: "behavior",
    label: "行为与反应模式",
    insightType: "behavioral_pattern",
    lens: "用户面对冲突、压力、不确定时反复出现的行为与反应套路",
  },
  {
    key: "relationship",
    label: "关系模式",
    insightType: "relationship_pattern",
    lens: "用户与他人或某类关系(家人/同事/权威等)中的互动与反应模式",
  },
  {
    key: "emotion",
    label: "情绪模式与轨迹",
    insightType: "emotion_trajectory",
    lens: "文本显露的情绪线索、可能的触发与走向(只取文本支持的,绝不诊断)",
  },
  {
    key: "values",
    label: "价值与边界",
    insightType: "value",
    lens: "用户真正在意什么、底线与边界在哪、什么不能接受",
  },
  {
    key: "identity_gap",
    label: "自我认知落差",
    insightType: "identity_gap",
    lens: "用户自述/期望的自己,与记录中实际表现出的自己之间的落差",
  },
  {
    key: "evolution",
    label: "矛盾与演化",
    insightType: "value_evolution",
    lens: "用户立场的变化是摇摆,还是探索→收敛;表面变化下底层标准是否一致",
  },
];

export const SYNTHESIS: Dimension = {
  key: "synthesis",
  label: "一句话画像",
  insightType: "synthesis",
  lens: "综合以上各维度,给出一句凝练、可记忆的整体画像——优先用一个贴切的身份隐喻(如「××式的××者」),而非平铺描述;仍是推测、须附证据、保持克制",
};

function buildSystem(lens: string): string {
  return `你是「找我」的洞察助手。下面是用户的"轻量结构化记录语料",每条以行序号 [n] 开头(含日期与来源),其后是:主题、情绪线索、提到的对象、原文片段。
请只就【${lens}】这一个维度,给出克制、非诊断、非评判的观察,严格按以下 JSON 形状输出(8 字段全必填;尖括号是占位说明,必须替换成真实内容,不可原样保留):
{
  "title": "<一句话的克制发现>",
  "summary": "<2-3 句概述这一维度的观察>",
  "facts": ["<语料里直接可见的:原话、反复出现、明显频率>"],
  "inferences": ["<由 facts 推出的判断,每条都要能落到某条 fact 上>"],
  "evidence": ["<1-3 条最能支撑的原文片段,直接引用、不改写>"],
  "evidence_ordinals": [1, 3],
  "confidence": 0.0,
  "sufficient": true
}

规则:
- evidence_ordinals:上面 facts/inferences/evidence 所依据的语料行序号 [n] 的整数列表(如发现来自第 1、3 行就填 [1,3])。只填语料里真实出现的序号;说不出依据就留空数组并把 sufficient 设为 false。
- 只基于语料,不引入语料外的知识或假设;facts 与 inferences 必须分开。
- inferences 中至少一条要往下追一层:不止说"是什么",还要对发现追问"它背后的为什么"(仍须能落到 facts)。
- confidence 是 0~1 的数字,语料越少、越间接越低。
- sufficient 是布尔:语料是否足以就该维度说出有意义的观察;不足则 sufficient=false、summary 写"数据还少,这只是很初步的印象",facts/inferences 尽量少甚至为空。
- 绝不诊断、不贴心理标签、不下定论;用"倾向/似乎/也许/在……上"这类措辞。
- 只输出 JSON,不要任何解释或代码围栏。`;
}

// 经 M-X2 gateway 生成单个维度的候选洞察(json_mode + InsightCandidate zod 校验)
export async function generateInsight(
  gateway: Gateway,
  lens: string,
  corpus: string,
): Promise<InsightCandidate> {
  const result = await gateway.extract({
    route: "observation_model",
    system: buildSystem(lens),
    text: corpus,
    schema: InsightCandidate,
    strategy: "json_mode",
  });
  return {
    title: result.title,
    summary: result.summary,
    facts: result.facts ?? [],
    inferences: result.inferences ?? [],
    evidence: result.evidence ?? [],
    evidence_ordinals: result.evidence_ordinals ?? [],
    confidence: result.confidence,
    sufficient: result.sufficient,
  };
}
