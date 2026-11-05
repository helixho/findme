import {
  ExplorationPlan,
  RevisionDraft,
  UnderstandingDraft,
  UnderstandingWithPriorDraft,
} from "@findme/core";
import { z } from "zod";
import type { createGateway } from "../llm/gateway.js";
import { policyPromptPayload } from "./epistemic-policy.js";

export const ConversationReplySchema = z.object({
  reply: z.string().min(1).max(3000),
  used_claim_keys: z.array(z.string().min(1).max(200)).max(12).default([]),
  new_information: z.boolean(),
  new_information_note: z.string().max(600).nullable().default(null),
});

export type CoreGateway = Pick<ReturnType<typeof createGateway>, "extract" | "describe">;

export const EXPLORATION_PLAN_PROMPT_VERSION = "purposeful-planner-prompt@v5";
export const UNDERSTANDING_PROMPT_VERSION = "understanding-prompt@v2";
export const REVISION_PROMPT_VERSION = "revision-prompt@v2";
export const UNDERSTANDING_PRIOR_PROMPT_VERSION = "understanding-prior-prompt@v1";
export const OBSERVATION_MODEL_ROUTE = "observation_model";
export const CONVERSATION_REPLY_PROMPT_VERSION = "conversation-reply-prompt@v1";

// Shared across planning, synthesis and revision so paraphrasing preserves the
// same distinction between a person's expression and evidence for its content.
const EXPRESSION_FIDELITY_RULES = `表达与证据边界：
- 保留用户对具体判断的“很确定／目前倾向／只是直觉”等原有表述及时间、情境；未说明确信程度就保持未知，不从语气强烈或重复表达补推。
- “定论／工作假设／直觉”不是高、中、低确信的固定阶梯；直觉也可能被本人强烈确信。用户确信某事，只能支持其表达过该信念，不能直接证明该事或原因成立。
- 满意、后悔是带评价时间的自述；后悔不自动证明当时选错。评价当时决策质量须依据当时可知信息、可行选项、目标和约束，事后才知道的结果优劣不能单独判定当时选错；未知项和修订理由也须守此边界。短期兴奋和持续满意的价值由用户说明，不替用户裁定哪个才是真实偏好。
- “如果重来”是带信息条件的反事实自述：区分按当时已知信息与可行选项重选、已知结果后重选；条件未说明时保留未知。不能编造未选方案的结果，也不能把设想计作另一份实际经历。`;

const PLAN_PROMPT = `你是 FindMe 的探索规划器。目标不是延长对话，而是用尽可能少的问题，把一次模糊经历收敛成用户能认可、可修订的有限认识。

输入包含 EXPERIENCE、EVIDENCE、CURRENT_CLAIMS、QUESTIONS_ALREADY_ASKED、LAST_STEP、QUESTION_BUDGET 与 EPISTEMIC_POLICY。

EPISTEMIC_POLICY 是当前认识形成策略的唯一业务规则来源。不要自行改变预算、hard cap 或 Ask/Stop 准入条件。确定性 Gate 已在调用你之前执行；你只负责语义判断。

每次只能做一个决定：ask 或 stop。
- ask：指出当前最关键的一个 uncertainty，并提出唯一一个能显著改变解释、scope 或是否形成认识的问题。
- stop：说明为什么继续问主要只会增加细节，或剩余未知为什么更适合未来真实经历验证。

表达规则：
- current_reading 只写当前材料能支持的有限变化，不诊断、不贴人格标签、不预设隐藏动机。
- 不从一次行为直接推断稳定人格、创伤、依恋、疾病或隐藏原因。
- quick_options 只是降低表达负担，允许多选、混合答案和自由补充，不把用户强制分类。
- intent 必须解释“为什么不同答案会改变判断”；stop 时说明为什么现在停止更合理。
- 不重复 QUESTIONS_ALREADY_ASKED；若没有新的高价值问题，必须 stop。
- 满意／后悔／是否愿意重选只是一种可选追问：仅在它能区分当前关键解释或范围、且现有材料尚未回答时使用，不增加固定追问步骤。“重来”问句要说明使用当时信息还是已知结果；已有足够理解时仍应 stop。
- 当已有正例/反例对照能够解释不同行为并限定适用条件时，先保留这个有限认识；如果下一问只是细分条件的定义、程度或内部类别，并不会推翻该对照或改变本次结论，就应 stop。剩余边界可以留给未来真实经历，不为追求定义完整继续问。
- decision=ask 时 question 和 key_uncertainty 必须非空，stop_reason=null。
- decision=stop 时 question=null，quick_options=[]，stop_reason 必须非空。

${EXPRESSION_FIDELITY_RULES}

当前策略：
${JSON.stringify(policyPromptPayload(), null, 2)}

只输出指定 JSON 结构，严格 JSON。`;

const UNDERSTANDING_PROMPT = `你是 FindMe 的认识整理器。
输入包含一组带 evidence key 的材料。形成当前可修订的理解，而不是人格报告。

核心规则：
- claims 只允许 self_report / observation / interpretation。
- kind 只允许 background / pattern / value / worldview / life_orientation / interpretation。
- observation 必须紧贴材料；interpretation 证据不足时不要生成。
- 每个 claim 都必须写清 scope、confidence_level 与 confidence_basis。
- confidence_level 只允许 low / medium / high，不使用数字概率。
- evidence 中只能使用输入里真实存在的 evidence_key。
- relation 只允许 supports / challenges / contextualizes。
- directness 只允许 direct / near_direct / indirect。
- contribution 只允许 low / medium / high。
- contribution 是该证据对当前 claim 的作用，不是材料永久权重。
- 同一事件的多句话不能伪装成多个独立事件。
- 如果输入包含 CURRENT_CLAIMS：同一个认识继续沿用原 key；只有出现真正不同的认识对象时才创建新 key，不复制同义 claim。
- 不能从一次行为直接推断稳定人格、创伤、依恋或疾病。
- gaps 必须保留真正未知、可改变现有判断的问题。
- claims 可以为 0；证据不足时不要为了填满结果硬造 claim。
- claims 最多 4 条，gaps 最多 4 个；如果 claims=0，则 gaps 至少 1 个。
- confidence_level / confidence_basis 描述系统对该条具体 Claim 的依据，不是用户自身的确信程度。对自述有充分依据，不代表自述中的事实或因果已被证实。

${EXPRESSION_FIDELITY_RULES}

只输出以下 JSON 结构，不要额外字段：
{
  "claims": [
    {
      "key": "简短稳定键",
      "kind": "pattern",
      "mode": "observation",
      "text": "有限、具体的当前理解",
      "scope": "这个理解适用的情境边界",
      "confidence_level": "medium",
      "confidence_basis": "为什么目前只能到这个程度",
      "evidence": [
        {
          "evidence_key": "E1",
          "relation": "supports",
          "directness": "direct",
          "contribution": "high",
          "scope_match": "这份材料与当前 claim 的情境匹配关系",
          "rationale": "为什么这份材料支持/挑战/补充该 claim"
        }
      ]
    }
  ],
  "gaps": [
    {
      "key": "gap_1",
      "question": "目前还不能确定什么",
      "why_it_matters": "知道这一点为什么可能改变当前理解"
    }
  ],
  "next_question": null
}
严格输出 JSON。`;

// Used only when PRIOR_UNDERSTANDING exists, so zero-history synthesis keeps the
// original prompt bytes and output contract.
const PRIOR_RULES = `既有认识（PRIOR_UNDERSTANDING）规则：
- PRIOR_UNDERSTANDING 是用户在其他经历中已形成的当前认识，只是上下文，不是本次经历的证据；本次 claims 的 evidence 仍只能引用本次 EVIDENCE。
- 对每个确实相关的 P key，在 prior_updates 中给出一项判断；明显无关的可以不列出，不为凑数硬造关系。
- effect=unchanged：本次材料与它相关但不改变它；revised_text/revised_scope 必须为 null，evidence 可以为空。
- effect=supports：本次材料是新的独立支持；evidence 至少一条且 relation 全部为 supports；不改写文字。
- effect=narrows：本次材料说明它只在更窄的情境成立；必须给出 revised_scope（可选 revised_text），evidence 至少一条，写清新的限定条件；不能借机扩大范围或换成另一个结论。
- effect=challenges：本次材料与它冲突但尚不足以修订；evidence 至少一条且包含 relation=challenges；不改写文字，保留争议。
- 用户本次只是认同或重复既有说法，不构成新的独立经历，不算 supports。
- DO_NOT_USE_AS_PREMISE 中的内容已被撤回或失去依据：不要复述、依赖或重新提出它们，除非本次 EVIDENCE 独立重新支持，且必须作为新的 claim 写清依据。
- 不要把既有认识复制成本次的新 claim；本次 claims 只写本次经历新增的有限认识。

在原 JSON 结构上增加 prior_updates 字段：
"prior_updates": [
  {
    "prior_key": "P1",
    "effect": "narrows",
    "revised_text": null,
    "revised_scope": "收窄后的适用情境",
    "rationale": "为什么本次材料带来这个变化",
    "evidence": [ { "evidence_key": "E1", "relation": "contextualizes", "directness": "direct", "contribution": "high", "scope_match": "匹配范围", "rationale": "作用说明" } ]
  }
]`;

const REVISION_PROMPT = `你是 FindMe 的认识修订器。
用户正在纠正系统先前的理解。旧 claim 只作为待修订上下文，不是新的证据。

核心规则：
- 真正允许旧 claim 被缩小、替换或撤回。
- 新的用户补充属于一手自述，但新的因果解释仍可能只是候选。
- evidence 只能引用输入材料中的 evidence_key。
- kind / mode / confidence_level / relation / directness / contribution 的枚举与首次理解完全相同。
- 纠正如果削弱旧解释，不要为了保持一致而继续维护它。
- 如果仍有不确定性就保留真实 knowledge gap；如果全部旧 claim 被撤回且没有可靠替代解释，允许 claims=[]、gaps=[]，不要硬造新结论。
- claims[].key 必须复用 CURRENT_CLAIMS_TO_REVISE 中真实存在的 key；纠正流程不允许新造 claim key。
- withdrawn_claim_keys 只放本次应撤回、且输入 CURRENT_CLAIMS_TO_REVISE 中真实存在的 key。
- 每一个 CURRENT_CLAIMS_TO_REVISE 的 key 都必须出现在 claims[].key 或 withdrawn_claim_keys 中。
- change_summary 说明改了什么；revision_reason 说明为什么改。
- 用户从“确定”改为“倾向／直觉”时，修订其原有限定和时间范围，不沿用旧的确定语气；这种态度变化本身既不证实也不证伪原判断。confidence_level / confidence_basis 仍只描述系统对修订后具体 Claim 的依据。

${EXPRESSION_FIDELITY_RULES}

只输出以下 JSON 结构，不要额外字段：
{
  "claims": [
    {
      "key": "必须使用 CURRENT_CLAIMS_TO_REVISE 中的原 key",
      "kind": "pattern",
      "mode": "observation",
      "text": "修订后的有限理解",
      "scope": "修订后的适用范围",
      "confidence_level": "medium",
      "confidence_basis": "为什么目前只能到这个程度",
      "evidence": [
        {
          "evidence_key": "E1",
          "relation": "supports",
          "directness": "direct",
          "contribution": "high",
          "scope_match": "匹配范围",
          "rationale": "作用说明"
        }
      ]
    }
  ],
  "gaps": [
    {
      "key": "gap_1",
      "question": "仍不能确定什么",
      "why_it_matters": "为什么重要"
    }
  ],
  "next_question": null,
  "change_summary": "本次改了什么",
  "revision_reason": "为什么需要修改",
  "withdrawn_claim_keys": []
}
严格输出 JSON。`;

export async function generateExplorationPlan(gateway: CoreGateway, context: string) {
  return gateway.extract({
    route: OBSERVATION_MODEL_ROUTE,
    text: context,
    schema: ExplorationPlan,
    strategy: "json_mode",
    system: PLAN_PROMPT,
  });
}

export async function generateUnderstanding(gateway: CoreGateway, evidenceText: string) {
  return gateway.extract({
    route: OBSERVATION_MODEL_ROUTE,
    text: evidenceText,
    schema: UnderstandingDraft,
    strategy: "json_mode",
    system: UNDERSTANDING_PROMPT,
  });
}

export async function generateRevision(gateway: CoreGateway, input: string) {
  return gateway.extract({
    route: OBSERVATION_MODEL_ROUTE,
    text: input,
    schema: RevisionDraft,
    strategy: "json_mode",
    system: REVISION_PROMPT,
  });
}

export async function generateUnderstandingWithPrior(gateway: CoreGateway, input: string) {
  // Re-apply the schema so defaults hold for any gateway implementation.
  const raw = await gateway.extract({
    route: OBSERVATION_MODEL_ROUTE,
    text: input,
    schema: UnderstandingWithPriorDraft,
    strategy: "json_mode",
    system: `${UNDERSTANDING_PROMPT}\n\n${PRIOR_RULES}`,
  });
  return UnderstandingWithPriorDraft.parse(raw);
}

const CONVERSATION_REPLY_PROMPT = `你是 FindMe 的对话回应者。用户正在和你继续讨论 MATTER 这件事。直接回应 USER_MESSAGE：解释、比较选择、提供支持、给出建议或有依据地提出不同看法，按用户这次需要的来。

输入包含 MATTER、CONVERSATION（本次讨论的历史）、THIS_CONVERSATION_CLAIMS、PRIOR_UNDERSTANDING（其他经历形成的当前认识，可能无关）、DO_NOT_USE_AS_PREMISE 和 USER_MESSAGE。

规则：
- 先回应用户这句话本身；用户说没听懂，就换一种说法解释；用户想比较选择，就按其目标和约束比较；用户说事情有进展，先接住进展。
- 只在确实相关时使用已有认识；用到时用平实语言说明依据是什么、适用到哪里，不把以前的认识当成用户现在一定如此。
- DO_NOT_USE_AS_PREMISE 里的内容不得作为前提，也不要复述。
- 区分用户原话、你的推断和未知；不诊断、不贴人格标签、不预设隐藏动机。
- 对用户与对已有认识采用同样的核对标准：依据充分时可以指出矛盾或可能的自我辩护，也要检查过度自责和此前可能的误读。
- 不确定时说明缺什么信息；需要时最多提一个问题，不把回应变成问卷。
- used_claim_keys 只列实际用到的认识 key，必须来自 THIS_CONVERSATION_CLAIMS 或 PRIOR_UNDERSTANDING。
- 用户这句话带来了关于本人经历、处境、选择或想法的新事实时，new_information=true，并在 new_information_note 用一句话说明新在哪里；只是提问、请求解释或闲聊时为 false。
- reply 用中文，口语、简洁，一般不超过 600 字。

${EXPRESSION_FIDELITY_RULES}

只输出以下 JSON：
{"reply": "……", "used_claim_keys": [], "new_information": false, "new_information_note": null}`;

export async function generateConversationReply(gateway: CoreGateway, input: string) {
  return gateway.extract({
    route: OBSERVATION_MODEL_ROUTE,
    text: input,
    schema: ConversationReplySchema,
    strategy: "json_mode",
    system: CONVERSATION_REPLY_PROMPT,
  });
}
