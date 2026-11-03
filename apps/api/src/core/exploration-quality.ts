import type { ExplorationPlan, UnderstandingDraft } from "@findme/core";
import {
  hasPlanScopeOverreach,
  validateExplorationPlan,
  validateUnderstandingPolicy,
} from "./epistemic-policy.js";

export type ExplorationQualityFixture = {
  id: string;
  experience: string;
  evidence: string[];
  previousQuestions: string[];
  questionCount: number;
  forceDeeper?: boolean;
  expectedDecision: "ask" | "stop";
  targetAny?: string[];
  forbidden?: string[];
  requireLimitedScope?: boolean;
  updateBranchesAny?: string[][];
};

export const EXPLORATION_QUALITY_FIXTURES: ExplorationQualityFixture[] = [
  {
    id: "activation-vs-reward",
    experience:
      "过去周末常去参加社团活动，最近经常觉得开始准备很麻烦；真正到了现场通常仍然觉得不错。",
    evidence: [
      "以前参加活动时会期待新鲜感和轻社交。",
      "最近出发前觉得准备和行动很麻烦。",
      "真正到了现场通常仍会觉得不错。",
    ],
    previousQuestions: [],
    questionCount: 0,
    expectedDecision: "ask",
    targetAny: ["开始", "启动", "准备", "兴趣", "吸引", "持续", "感觉", "收益", "体验"],
    updateBranchesAny: [
      ["启动", "准备", "出发"],
      ["持续", "吸引", "感觉", "期待", "匹配", "回报", "价值", "收益", "兴趣", "意愿", "体验"],
    ],
  },
  {
    id: "mixed-drivers-common-structure",
    experience:
      "一次活动同时有新鲜感、放松和互动的吸引力，但这些感觉现在更短，出发前又常觉得不值得折腾。",
    evidence: [
      "新鲜感、放松和互动都仍然有一点作用。",
      "这些因素不是互斥选项，会同时出现。",
      "积极感觉现在更短暂。",
    ],
    previousQuestions: ["这些吸引力里，哪一个才是最主要的？"],
    questionCount: 1,
    expectedDecision: "ask",
    targetAny: ["短", "持续", "多久", "之后", "范围", "其他", "事情"],
    forbidden: ["只能选", "唯一"],
    updateBranchesAny: [
      ["持续", "短", "多久"],
      ["其他", "范围", "活动", "成本", "代价", "摩擦"],
    ],
  },
  {
    id: "specific-context-before-generalization",
    experience: "一次评审临时提前，关键数据没有核完，所以当时先听讨论，之后再补充观点。",
    evidence: ["评审时间临时提前。", "关键数据还没有核完。", "当时选择先听讨论，之后补充观点。"],
    previousQuestions: [],
    questionCount: 0,
    // The stated reason already supports a bounded observation; do not require another question.
    expectedDecision: "stop",
    requireLimitedScope: true,
  },
  {
    id: "counterexample-narrows-scope",
    experience: "有两次相似讨论：信息没确认时先听，信息充分时会直接表达。",
    evidence: [
      "信息没确认的一次讨论里先听，之后才补充观点。",
      "另一次信息已经充分时，会在讨论中直接表达。",
    ],
    previousQuestions: ["信息充分时你也会先等吗？"],
    questionCount: 1,
    expectedDecision: "stop",
    requireLimitedScope: true,
  },
  {
    id: "budget-stop",
    experience: "已经连续回答了三个有区分力的问题。",
    evidence: ["当前材料已经能够形成有限认识。"],
    previousQuestions: ["问题一", "问题二", "问题三"],
    questionCount: 3,
    expectedDecision: "stop",
    forbidden: ["问题四"],
  },
];

function textForPlan(plan: ExplorationPlan) {
  return [
    plan.current_reading,
    plan.key_uncertainty ?? "",
    plan.question ?? "",
    plan.intent,
    plan.stop_reason ?? "",
    ...plan.quick_options,
  ].join("\n");
}

// These are executable assertions for the named synthetic contrast, not a
// general natural-language entailment judge. Both condition/behavior links must
// be present; a generic mention of "information" cannot pass this fixture.
function counterexampleNarrowsScope(text: string) {
  const waiting =
    /信息(?:尚未确认|没确认|未确认|不完整|未完整|不足|不充分)[^。；\n]{0,28}(?:先听|等待|先等)/.test(
      text,
    );
  const speaking =
    /信息(?:已|已经)?(?:充分|完整|确认)[^。；\n]{0,28}(?:直接|主动|立即)(?:表达|发言)/.test(text);
  return waiting && speaking;
}

export function evaluateExplorationQuality(
  fixture: ExplorationQualityFixture,
  plan: ExplorationPlan,
) {
  const text = textForPlan(plan);
  const target = [plan.key_uncertainty ?? "", plan.question ?? ""].join("\n");
  const policyIssues = validateExplorationPlan(plan, {
    previousQuestions: fixture.previousQuestions,
    questionCount: fixture.questionCount,
    forceDeeper: fixture.forceDeeper ?? false,
  });
  const repeatIssue = policyIssues.some((issue) => issue === "ask_repeats_previous_question");

  const checks = {
    ask_stop: plan.decision === fixture.expectedDecision,
    deterministic_contract: policyIssues.length === 0,
    uncertainty_targeting:
      fixture.expectedDecision === "stop" ||
      !fixture.targetAny?.length ||
      fixture.targetAny.some((term) => target.includes(term)),
    information_gain:
      fixture.expectedDecision === "stop" ||
      (/改变|区分|判断|范围|确认|辨别|分清|影响/.test(plan.intent) &&
        (fixture.updateBranchesAny ?? []).every((terms) =>
          terms.some((term) => plan.intent.includes(term)),
        )),
    redundancy: !repeatIssue,
    unsupported_inference:
      !hasPlanScopeOverreach(plan) &&
      !fixture.forbidden?.some((term) => text.toLocaleLowerCase("zh-CN").includes(term)),
    scope_discipline:
      !hasPlanScopeOverreach(plan) &&
      (!fixture.requireLimitedScope ||
        counterexampleNarrowsScope(plan.current_reading) ||
        /目前|这次|当|情境|条件|范围|不一定|并非|取决于/.test(plan.current_reading)),
    counterexample_handling:
      fixture.id !== "counterexample-narrows-scope" ||
      counterexampleNarrowsScope(plan.current_reading),
  };

  return {
    fixture_id: fixture.id,
    pass: Object.values(checks).every(Boolean),
    checks,
    policy_issues: policyIssues,
  };
}

export function evaluateDecisionLineage(meta: Record<string, unknown>) {
  const required = [
    "policy_version",
    "prompt_version",
    "model_route",
    "model_version",
    "validator_version",
    "input_fingerprint",
    "decision_source",
  ] as const;
  const missing = required.filter(
    (key) => typeof meta[key] !== "string" || !String(meta[key]).trim(),
  );
  const fingerprint = meta.input_fingerprint;
  const fingerprintValid =
    typeof fingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(fingerprint);

  const sourceValid = ["semantic_planner", "deterministic_gate", "synthesis", "revision"].includes(
    String(meta.decision_source),
  );
  return {
    pass: missing.length === 0 && fingerprintValid && sourceValid,
    decision_source_valid: sourceValid,
    missing,
    fingerprint_valid: fingerprintValid,
  };
}

type LatencySegments = { save_ms?: number; planner_ms?: number; synthesis_ms?: number };

export function evaluateLatencySegments(
  timing: LatencySegments,
  required: (keyof LatencySegments)[] = ["save_ms", "planner_ms", "synthesis_ms"],
) {
  const provided = Object.entries(timing).filter(([, value]) => value !== undefined);
  const missing = required.filter((key) => timing[key] === undefined);
  const invalid = provided
    .filter(([, value]) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
    .map(([key]) => key);
  return {
    pass: required.length > 0 && missing.length === 0 && invalid.length === 0,
    observed_segments: provided.map(([key]) => key),
    missing_segments: missing,
    invalid_segments: invalid,
  };
}

export function evaluateUnderstandingQuality(
  draft: UnderstandingDraft,
  evidenceKeys: string[],
  options: { counterexample?: boolean } = {},
) {
  const allowed = new Set(evidenceKeys);
  const issues = validateUnderstandingPolicy(draft);
  const checks = {
    policy: issues.length === 0,
    evidence_traceability: draft.claims.every(
      (claim) =>
        claim.evidence.length > 0 &&
        claim.evidence.every((evidence) => allowed.has(evidence.evidence_key)),
    ),
    unique_claim_keys: new Set(draft.claims.map((claim) => claim.key)).size === draft.claims.length,
    counterexample_handling:
      !options.counterexample ||
      (draft.claims.length > 0 &&
        draft.claims.every(
          (claim) =>
            counterexampleNarrowsScope(claim.text) &&
            /这|本次|情境|信息|条件/.test(claim.scope) &&
            ["E1", "E2"].every((key) =>
              claim.evidence.some((evidence) => evidence.evidence_key === key),
            ),
        )),
  };
  return { pass: Object.values(checks).every(Boolean), checks, policy_issues: issues };
}
