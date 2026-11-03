import { createHash } from "node:crypto";
import type { ExplorationPlan, UnderstandingDraft } from "@findme/core";

export const PURPOSEFUL_EXPLORATION_POLICY = {
  version: "epistemic-policy@v1",
  profile: "purposeful-exploration@v1",
  defaultQuestionBudget: 3,
  hardQuestionCap: 5,
  allowForceDeeper: true,
  maxQuickOptions: 4,
  semanticAskCriteria: [
    "存在一个明确、具体的 key uncertainty",
    "不同答案会明显改变当前解释、适用范围或是否能形成认识",
    "现有 evidence 不能回答",
    "这个信息增益值得再次打扰用户",
  ],
  semanticStopCriteria: [
    "下一问只会增加细节，不会改变判断",
    "已有材料足够形成有限认识",
    "剩余未知更适合未来新经历验证，而不是继续追问",
    "连续两轮只增加细节、没有改变判断",
  ],
} as const;

export const PLAN_VALIDATOR_VERSION = "exploration-plan-validator@v2";
export const UNDERSTANDING_VALIDATOR_VERSION = "understanding-policy-validator@v2";
export const REVISION_VALIDATOR_VERSION = "revision-policy-validator@v1";

export type PlannerGateResult =
  | { action: "allow_model" }
  | {
      action: "stop";
      reasonCode: "default_budget_reached" | "hard_cap_reached";
      stopReason: string;
      intent: string;
    };

export function plannerGate(args: {
  questionCount: number;
  forceDeeper: boolean;
}): PlannerGateResult {
  if (args.questionCount >= PURPOSEFUL_EXPLORATION_POLICY.hardQuestionCap) {
    return {
      action: "stop",
      reasonCode: "hard_cap_reached",
      stopReason: "已经达到本次探索的追问上限，继续提问的边际价值不足。",
      intent: "本次探索先停在这里，避免为了深度而继续发散。",
    };
  }

  if (
    args.questionCount >= PURPOSEFUL_EXPLORATION_POLICY.defaultQuestionBudget &&
    !args.forceDeeper
  ) {
    return {
      action: "stop",
      reasonCode: "default_budget_reached",
      stopReason: "已经达到本轮默认追问预算，先整理当前认识；需要时可以由用户主动继续深入。",
      intent: "先把已经得到的信息整理成有限认识，再由用户决定是否继续。",
    };
  }

  return { action: "allow_model" };
}

function normalizedQuestion(value: string) {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * This is deliberately a small, high-precision guard for known overreach
 * phrases. It is not a general Chinese semantic parser. A nearby negation,
 * scope qualifier, or quotation means the phrase is being discussed as a
 * limitation/example and must not be rejected as an assertion.
 */
const NEGATION_OR_QUOTE_TERMS = [
  "不能",
  "无法",
  "并非",
  "不是",
  "不代表",
  "不等于",
  "不一定",
  "未必",
  "原话",
  "引用",
] as const;
const LOCAL_SCOPE_TERMS = ["仅限", "只在", "只有", "这次", "当时"] as const;

const STABLE_SCOPE_TERMS = [
  "本质上",
  "固定性格",
  "总是",
  "从不",
  "所有场景",
  "任何情况下",
  "必然",
  "一定会",
  "你就是",
  "你属于",
] as const;

const HIGH_RISK_INFERENCE_TERMS = [
  "回避型人格",
  "回避型依恋",
  "焦虑型依恋",
  "人格障碍",
  "创伤导致",
  "疾病导致",
  "潜意识导致",
] as const;
const EXPLANATORY_HIGH_RISK_TERMS = ["人格", "创伤", "依恋", "疾病", "障碍"] as const;

function sentenceStart(text: string, index: number) {
  const separators = ["。", "！", "？", "；", "，", ",", "\n"];
  return Math.max(...separators.map((separator) => text.lastIndexOf(separator, index - 1))) + 1;
}

function isInsideQuotation(text: string, index: number) {
  // Quotation spans may contain sentence/clause delimiters.
  const segment = text.slice(0, index);
  const pairedQuotes = [
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
  ] as const;
  if (segment.split('"').length % 2 === 0 || segment.split("'").length % 2 === 0) return true;
  return pairedQuotes.some(
    ([open, close]) =>
      (segment.match(new RegExp(`\\${open}`, "g"))?.length ?? 0) >
      (segment.match(new RegExp(`\\${close}`, "g"))?.length ?? 0),
  );
}

function hasUnqualifiedTerm(text: string, terms: readonly string[]) {
  for (const term of terms) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(term, offset);
      if (index < 0) break;
      const start = sentenceStart(text, index);
      const prefix = text.slice(start, index);
      if (
        !isInsideQuotation(text, index) &&
        !NEGATION_OR_QUOTE_TERMS.some((qualifier) => prefix.includes(qualifier))
      ) {
        return true;
      }
      offset = index + term.length;
    }
  }
  return false;
}

function hasStableScopeOverreach(text: string) {
  for (const term of STABLE_SCOPE_TERMS) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(term, offset);
      if (index < 0) break;
      const start = sentenceStart(text, index);
      const prefix = text.slice(start, index);
      const locallyScoped = LOCAL_SCOPE_TERMS.some((qualifier) => prefix.includes(qualifier));
      const unresolved = /(?:是否|能否|尚不清楚|还不确定)[^。；，,\n]*$/.test(prefix);
      const explanatory = /(?:说明|表明|导致|证明)/.test(prefix);
      if (
        !isInsideQuotation(text, index) &&
        !NEGATION_OR_QUOTE_TERMS.some((qualifier) => prefix.includes(qualifier)) &&
        !unresolved &&
        (!locallyScoped || explanatory)
      ) {
        return true;
      }
      offset = index + term.length;
    }
  }
  return false;
}

function hasHighRiskExplanatoryInference(text: string) {
  for (const term of EXPLANATORY_HIGH_RISK_TERMS) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(term, offset);
      if (index < 0) break;
      const start = sentenceStart(text, index);
      const prefix = text.slice(start, index);
      if (
        !isInsideQuotation(text, index) &&
        !NEGATION_OR_QUOTE_TERMS.some((qualifier) => prefix.includes(qualifier)) &&
        /(?:这|因此|所以).{0,12}(?:说明|表明).{0,12}你/.test(prefix)
      ) {
        return true;
      }
      offset = index + term.length;
    }
  }
  return false;
}

export function hasPlanScopeOverreach(plan: ExplorationPlan) {
  const text = [
    plan.current_reading,
    plan.key_uncertainty ?? "",
    plan.question ?? "",
    plan.intent,
    plan.stop_reason ?? "",
  ].join("\n");
  return (
    hasStableScopeOverreach(text) ||
    hasUnqualifiedTerm(text, HIGH_RISK_INFERENCE_TERMS) ||
    hasHighRiskExplanatoryInference(text)
  );
}

/** Same text checks as validateUnderstandingPolicy, for revisions outside a draft claim. */
export function hasUnsafeUnderstandingText(text: string) {
  return (
    hasStableScopeOverreach(text) ||
    hasUnqualifiedTerm(text, HIGH_RISK_INFERENCE_TERMS) ||
    hasHighRiskExplanatoryInference(text)
  );
}

export function validateUnderstandingPolicy(draft: UnderstandingDraft) {
  const issues: string[] = [];
  for (const claim of draft.claims) {
    if (hasStableScopeOverreach(`${claim.text}\n${claim.scope}`)) {
      issues.push(`claim_scope_overreach:${claim.key}`);
    }

    if (
      hasUnqualifiedTerm(`${claim.text}\n${claim.scope}`, HIGH_RISK_INFERENCE_TERMS) ||
      hasHighRiskExplanatoryInference(`${claim.text}\n${claim.scope}`)
    ) {
      issues.push(`interpretation_high_risk_inference:${claim.key}`);
    }
  }
  return issues;
}

export function validateExplorationPlan(
  plan: ExplorationPlan,
  args: {
    previousQuestions: string[];
    questionCount: number;
    forceDeeper: boolean;
  },
) {
  const issues: string[] = [];
  const gate = plannerGate({
    questionCount: args.questionCount,
    forceDeeper: args.forceDeeper,
  });

  if (hasPlanScopeOverreach(plan)) {
    issues.push("plan_scope_overreach");
  }

  if (plan.quick_options.length > PURPOSEFUL_EXPLORATION_POLICY.maxQuickOptions) {
    issues.push("quick_options_exceed_policy_limit");
  }

  if (plan.decision === "ask") {
    if (gate.action !== "allow_model") {
      issues.push(`ask_blocked_by_gate:${gate.reasonCode}`);
    }

    const normalized = normalizedQuestion(plan.question ?? "");
    if (!normalized) issues.push("ask_question_empty");

    const previous = new Set(args.previousQuestions.map(normalizedQuestion).filter(Boolean));
    if (normalized && previous.has(normalized)) {
      issues.push("ask_repeats_previous_question");
    }

    const normalizedOptions = plan.quick_options.map(normalizedQuestion).filter(Boolean);
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      issues.push("quick_options_duplicate");
    }
  } else {
    if (plan.question !== null) issues.push("stop_must_not_have_question");
    if (plan.quick_options.length > 0) issues.push("stop_must_not_have_quick_options");
  }

  return issues;
}

export function deterministicStopPlan(args: {
  gate: Exclude<PlannerGateResult, { action: "allow_model" }>;
  fallbackReading?: string | null;
  fallbackUncertainty?: string | null;
}): ExplorationPlan {
  return {
    current_reading:
      args.fallbackReading?.trim() || "本轮先整理已经得到的材料，不再为了增加细节继续追问。",
    key_uncertainty: args.fallbackUncertainty?.trim() || null,
    decision: "stop",
    question: null,
    intent: args.gate.intent,
    quick_options: [],
    stop_reason: args.gate.stopReason,
  };
}

export type PlannerContextInput = {
  experience: string;
  evidenceText: string;
  currentClaims: Array<{
    key: string;
    text: string;
    scope: string;
    evidence_status: string;
  }>;
  questions: Array<{
    sequence: number;
    question: string;
    intent: string;
    status: string;
  }>;
  lastStep: {
    current_reading: string;
    key_uncertainty: string | null;
    decision: string;
  } | null;
  questionCount: number;
  forceDeeper: boolean;
};

export function buildPlannerContext(args: PlannerContextInput) {
  return [
    "EXPERIENCE:",
    args.experience,
    "",
    "EVIDENCE:",
    args.evidenceText,
    "",
    "CURRENT_CLAIMS:",
    JSON.stringify(args.currentClaims),
    "",
    "QUESTIONS_ALREADY_ASKED:",
    JSON.stringify(args.questions),
    "",
    "LAST_STEP:",
    JSON.stringify(args.lastStep),
    "",
    "EPISTEMIC_POLICY:",
    JSON.stringify(PURPOSEFUL_EXPLORATION_POLICY),
    "",
    "QUESTION_BUDGET:",
    JSON.stringify({
      asked: args.questionCount,
      default_budget: PURPOSEFUL_EXPLORATION_POLICY.defaultQuestionBudget,
      hard_cap: PURPOSEFUL_EXPLORATION_POLICY.hardQuestionCap,
      force_deeper: args.forceDeeper,
    }),
  ].join("\n");
}

export function policyPromptPayload() {
  return {
    version: PURPOSEFUL_EXPLORATION_POLICY.version,
    profile: PURPOSEFUL_EXPLORATION_POLICY.profile,
    semantic_ask_criteria: PURPOSEFUL_EXPLORATION_POLICY.semanticAskCriteria,
    semantic_stop_criteria: PURPOSEFUL_EXPLORATION_POLICY.semanticStopCriteria,
    max_quick_options: PURPOSEFUL_EXPLORATION_POLICY.maxQuickOptions,
  };
}

export function inputFingerprint(parts: Array<string | number | boolean | null | undefined>) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part ?? ""));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}
