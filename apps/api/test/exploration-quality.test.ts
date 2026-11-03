import { ExplorationPlan, UnderstandingDraft } from "@findme/core";
import { describe, expect, it } from "vitest";
import {
  PURPOSEFUL_EXPLORATION_POLICY,
  inputFingerprint,
  plannerGate,
  validateExplorationPlan,
  validateUnderstandingPolicy,
} from "../src/core/epistemic-policy.js";
import {
  EXPLORATION_QUALITY_FIXTURES,
  evaluateDecisionLineage,
  evaluateExplorationQuality,
  evaluateLatencySegments,
  evaluateUnderstandingQuality,
} from "../src/core/exploration-quality.js";

function parsePlan(value: unknown) {
  return ExplorationPlan.parse(value);
}

describe("Epistemic Policy", () => {
  it("默认问题预算与 hard cap 由同一个版本化策略执行", () => {
    expect(PURPOSEFUL_EXPLORATION_POLICY.version).toBe("epistemic-policy@v1");
    expect(plannerGate({ questionCount: 2, forceDeeper: false }).action).toBe("allow_model");

    const defaultStop = plannerGate({ questionCount: 3, forceDeeper: false });
    expect(defaultStop.action).toBe("stop");
    if (defaultStop.action === "stop") {
      expect(defaultStop.reasonCode).toBe("default_budget_reached");
    }

    expect(plannerGate({ questionCount: 3, forceDeeper: true }).action).toBe("allow_model");

    const hardStop = plannerGate({ questionCount: 5, forceDeeper: true });
    expect(hardStop.action).toBe("stop");
    if (hardStop.action === "stop") {
      expect(hardStop.reasonCode).toBe("hard_cap_reached");
    }
  });

  it("post-validator 阻止重复问题和绕过预算的 ask", () => {
    const repeated = parsePlan({
      current_reading: "目前更清楚的是：这次选择与信息不完整有关。",
      key_uncertainty: "还要确认信息是否是主要约束。",
      decision: "ask",
      question: "当时最影响你决定的是什么？",
      intent: "不同答案会改变当前理解的范围。",
      quick_options: [],
      stop_reason: null,
    });

    expect(
      validateExplorationPlan(repeated, {
        previousQuestions: ["当时最影响你决定的是什么？"],
        questionCount: 1,
        forceDeeper: false,
      }),
    ).toContain("ask_repeats_previous_question");

    expect(
      validateExplorationPlan(repeated, {
        previousQuestions: [],
        questionCount: 3,
        forceDeeper: false,
      }),
    ).toContain("ask_blocked_by_gate:default_budget_reached");
  });

  it("input fingerprint 对同一处理版本稳定，对输入或规则变化敏感", () => {
    const first = inputFingerprint(["policy@1", "prompt@1", "model-a", "same input"]);
    const same = inputFingerprint(["policy@1", "prompt@1", "model-a", "same input"]);
    const changedInput = inputFingerprint(["policy@1", "prompt@1", "model-a", "changed input"]);
    const changedPolicy = inputFingerprint(["policy@2", "prompt@1", "model-a", "same input"]);

    expect(first).toBe(same);
    expect(changedInput).not.toBe(first);
    expect(changedPolicy).not.toBe(first);
  });
});

describe("Exploration Quality Eval", () => {
  it("固定 synthetic fixture 可以区分合格追问与发散/过度推断", () => {
    const fixture = EXPLORATION_QUALITY_FIXTURES.find((item) => item.id === "activation-vs-reward");
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const good = parsePlan({
      current_reading: "真正参加活动后仍有正反馈，目前不像是完全失去兴趣。",
      key_uncertainty: "还不能确定主要变化在出发前的启动成本，还是积极感觉本身变短。",
      decision: "ask",
      question: "如果已经省掉准备过程，到了现场以后那种不错的感觉通常能持续多久？",
      intent: "这能区分启动阻力变大，还是活动本身的持续吸引力也在下降，从而改变当前理解。",
      quick_options: ["通常还能持续一阵", "很快就过去", "看活动而定"],
      stop_reason: null,
    });
    expect(evaluateExplorationQuality(fixture, good).pass).toBe(true);

    const bad = parsePlan({
      current_reading: "这说明你本质上就是回避型人格。",
      key_uncertainty: "还可以继续深入你的性格。",
      decision: "ask",
      question: "为什么你总是不愿意主动社交？",
      intent: "继续深入了解。",
      quick_options: [],
      stop_reason: null,
    });
    const badResult = evaluateExplorationQuality(fixture, bad);
    expect(badResult.pass).toBe(false);
    expect(badResult.checks.unsupported_inference).toBe(false);
    expect(badResult.checks.information_gain).toBe(false);
  });

  it("默认预算 fixture 只能 stop", () => {
    const fixture = EXPLORATION_QUALITY_FIXTURES.find((item) => item.id === "budget-stop");
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const stop = parsePlan({
      current_reading: "当前材料已经足够形成有限认识。",
      key_uncertainty: "剩余问题更适合后续真实事件验证。",
      decision: "stop",
      question: null,
      intent: "继续追问只会增加细节。",
      quick_options: [],
      stop_reason: "已达到本轮默认追问预算，先整理当前认识。",
    });
    expect(evaluateExplorationQuality(fixture, stop).pass).toBe(true);
  });
});

function sampleDraft(
  text = "在这次讨论中，你选择先等待信息。",
  mode: "self_report" | "observation" | "interpretation" = "observation",
) {
  return UnderstandingDraft.parse({
    claims: [
      {
        key: "context",
        kind: "pattern",
        mode,
        text,
        scope: "仅限这次讨论的信息条件。",
        confidence_level: "low",
        confidence_basis: "本次材料。",
        evidence: [
          {
            evidence_key: "E1",
            relation: "supports",
            directness: "direct",
            contribution: "medium",
            scope_match: "本次情境",
            rationale: "描述选择。",
          },
        ],
      },
    ],
    gaps: [],
    next_question: null,
  });
}

function stoppedPlan(reading: string) {
  return parsePlan({
    current_reading: reading,
    key_uncertainty: null,
    decision: "stop",
    question: null,
    intent: "材料已经支持按条件区分，继续追问只增加细节。",
    quick_options: [],
    stop_reason: "先保留有限认识。",
  });
}

describe("Quality gates beyond Planner shape", () => {
  it("uncertainty targeting 不能靠 current_reading 中无关的命中词通过", () => {
    const fixture = EXPLORATION_QUALITY_FIXTURES[0];
    const plan = parsePlan({
      current_reading: "准备与持续吸引力都有变化。",
      key_uncertainty: "还不知道你喜欢什么颜色。",
      decision: "ask",
      question: "你喜欢什么颜色？",
      intent: "改变判断。",
      quick_options: [],
      stop_reason: null,
    });
    const result = evaluateExplorationQuality(fixture, plan);
    expect(result.checks.uncertainty_targeting).toBe(false);
    expect(result.checks.information_gain).toBe(false);
  });

  it("反例必须保留两个条件与行为的对应，泛泛限定和丢弃反例均失败", () => {
    const fixture = EXPLORATION_QUALITY_FIXTURES.find(
      (item) => item.id === "counterexample-narrows-scope",
    );
    if (!fixture) throw new Error("Missing counterexample fixture");
    const narrow = "这两次情境里，信息未确认时先听，信息充分时直接表达。";
    expect(evaluateExplorationQuality(fixture, stoppedPlan(narrow)).pass).toBe(true);
    expect(
      evaluateExplorationQuality(
        fixture,
        stoppedPlan("在信息尚未确认时你先听、之后补充；在信息已充分时你会在讨论中直接表达。"),
      ).pass,
    ).toBe(true);
    for (const reading of [
      "目前信息已经足够，可以停止。",
      "这次信息未确认时先听。",
      "这说明你总是等待别人。",
    ])
      expect(
        evaluateExplorationQuality(fixture, stoppedPlan(reading)).checks.counterexample_handling,
      ).toBe(false);
  });

  it("Understanding 反例认识同时引用真实的支持与反例材料", () => {
    const draft = sampleDraft("这两次情境里，信息未确认时先听，信息充分时直接表达。");
    draft.claims[0].evidence.push({ ...draft.claims[0].evidence[0], evidence_key: "E2" });
    expect(evaluateUnderstandingQuality(draft, ["E1", "E2"], { counterexample: true }).pass).toBe(
      true,
    );
    expect(
      evaluateUnderstandingQuality(draft, ["E1"], { counterexample: true }).checks
        .evidence_traceability,
    ).toBe(false);
    draft.claims[0].evidence.pop();
    expect(
      evaluateUnderstandingQuality(draft, ["E1", "E2"], { counterexample: true }).checks
        .counterexample_handling,
    ).toBe(false);
  });

  it("缺失血缘、伪指纹和未知 decision source 都不能通过", () => {
    const meta = {
      policy_version: "policy@1",
      prompt_version: "prompt@1",
      model_route: "observation_model",
      model_version: "fake",
      validator_version: "validator@1",
      input_fingerprint: inputFingerprint(["synthetic"]),
      decision_source: "semantic_planner",
    };
    expect(evaluateDecisionLineage(meta).pass).toBe(true);
    for (const key of Object.keys(meta))
      expect(evaluateDecisionLineage({ ...meta, [key]: " " }).pass).toBe(false);
    expect(evaluateDecisionLineage({ ...meta, input_fingerprint: "sha256:not-a-hash" }).pass).toBe(
      false,
    );
    expect(evaluateDecisionLineage({ ...meta, decision_source: "unknown" }).pass).toBe(false);
    expect(evaluateDecisionLineage({ ...meta, decision_source: "deterministic_gate" }).pass).toBe(
      true,
    );
  });

  it("完整延迟报告不能只带一段，也不能含负数/NaN/Infinity", () => {
    expect(evaluateLatencySegments({ save_ms: 1, planner_ms: 0, synthesis_ms: 2 }).pass).toBe(true);
    expect(evaluateLatencySegments({ save_ms: 1 }).pass).toBe(false);
    expect(evaluateLatencySegments({}).pass).toBe(false);
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        evaluateLatencySegments({ save_ms: 1, planner_ms: invalid, synthesis_ms: 2 }).pass,
      ).toBe(false);
    expect(evaluateLatencySegments({ planner_ms: 0 }, ["planner_ms"]).pass).toBe(true);
  });

  it("观察和解释都不能用 mode 绕过明显的人格或因果推断", () => {
    for (const mode of ["observation", "interpretation"] as const) {
      expect(
        validateUnderstandingPolicy(sampleDraft("你是回避型人格。", mode)).length,
      ).toBeGreaterThan(0);
      expect(
        validateUnderstandingPolicy(sampleDraft("你总是在任何情况下等待别人。", mode)).length,
      ).toBeGreaterThan(0);
    }
  });

  it("限定的否定表达保留，肯定的过度推断被拦截", () => {
    for (const text of [
      "这不能说明你有创伤。",
      "这并非说明你总是等待别人。",
      "仅凭这次材料不能判断你是回避型人格。",
      "剩余未知是是否总是如此，更适合未来事件验证。",
    ])
      expect(validateUnderstandingPolicy(sampleDraft(text))).toEqual([]);
    expect(
      validateUnderstandingPolicy(sampleDraft("这说明你是回避型人格。")).length,
    ).toBeGreaterThan(0);
  });
  it("时间限定或猜测语气不授权人格与全称跳跃", () => {
    for (const text of [
      "这次说明你是回避型人格。",
      "目前你总是等待别人。",
      "可能你是回避型人格。",
      "无法确定原因，但你是回避型人格。",
    ])
      expect(validateUnderstandingPolicy(sampleDraft(text)).length).toBeGreaterThan(0);
  });

  it("self_report 允许引用本人原话，但不能把未经归属的标签冒充自述", () => {
    expect(
      validateUnderstandingPolicy(sampleDraft("你说：“我总是先等别人。”", "self_report")),
    ).toEqual([]);
    expect(
      validateUnderstandingPolicy(
        sampleDraft("你说：“以前想过很多，后来我总是先等别人。”", "self_report"),
      ),
    ).toEqual([]);
    expect(
      validateUnderstandingPolicy(sampleDraft("你是回避型人格。", "self_report")).length,
    ).toBeGreaterThan(0);
  });
  it("收益与成本分支允许等价词形，仍不能只有泛泛的改变判断", () => {
    const liveCandidate = parsePlan({
      current_reading:
        "当前材料显示：过去参加活动时会期待新鲜感和轻社交；最近出发前觉得准备和行动麻烦；但真正到现场通常仍觉得不错。可暂时理解为“出发前阻力增加，但现场体验未必同步变差”。",
      key_uncertainty:
        "最近的“麻烦”主要来自准备/行动成本，还是来自对活动内容或社交互动的兴趣变化，抑或精力与时间安排等情境负荷。",
      decision: "ask",
      question: "最近觉得“开始准备很麻烦”时，最主要卡住的是哪一类？",
      intent:
        "如果主要是准备/行动成本，那么现场体验仍可维持，当前更像启动摩擦；如果主要是兴趣或社交意愿下降，那么“到了仍不错”可能不足以支持继续参加，解释和适用范围会明显不同。",
      quick_options: [
        "出门准备、通勤或行动启动",
        "想到现场互动或社交",
        "对活动内容本身的兴趣下降",
        "精力、时间或事务安排",
      ],
      stop_reason: null,
    });
    expect(evaluateExplorationQuality(EXPLORATION_QUALITY_FIXTURES[0], liveCandidate).pass).toBe(
      true,
    );
    const contextual = EXPLORATION_QUALITY_FIXTURES.find(
      (fixture) => fixture.id === "specific-context-before-generalization",
    );
    if (!contextual) throw new Error("Missing contextual fixture");
    expect(
      evaluateExplorationQuality(
        contextual,
        stoppedPlan("仅限这次评审：信息未核完时先听，之后补充观点。剩余未知是是否总是如此。"),
      ).pass,
    ).toBe(true);

    const plan = parsePlan({
      current_reading: "出发前觉得麻烦，到场后仍有正向体验。",
      key_uncertainty: "是准备成本还是活动吸引力变化？",
      decision: "ask",
      question: "准备过程和对活动的期待，哪一部分变化更大？",
      intent:
        "如果是准备或出门成本，解释更偏启动摩擦；如果对活动内容的期待下降，会改变活动匹配度的判断。",
      quick_options: [],
      stop_reason: null,
    });
    expect(
      evaluateExplorationQuality(EXPLORATION_QUALITY_FIXTURES[0], plan).checks.information_gain,
    ).toBe(true);
    expect(
      evaluateExplorationQuality(EXPLORATION_QUALITY_FIXTURES[0], {
        ...plan,
        intent: "这能改变判断。",
      }).checks.information_gain,
    ).toBe(false);
  });
});
