import {
  PLAN_VALIDATOR_VERSION,
  PURPOSEFUL_EXPLORATION_POLICY,
  buildPlannerContext,
  deterministicStopPlan,
  inputFingerprint,
  plannerGate,
} from "../src/core/epistemic-policy.js";
import {
  EXPLORATION_QUALITY_FIXTURES,
  evaluateDecisionLineage,
  evaluateExplorationQuality,
  evaluateLatencySegments,
} from "../src/core/exploration-quality.js";
import {
  EXPLORATION_PLAN_PROMPT_VERSION,
  OBSERVATION_MODEL_ROUTE,
  generateExplorationPlan,
} from "../src/core/llm.js";
import { createGateway } from "../src/llm/gateway.js";

const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.error("DEEPSEEK_API_KEY is required for live Exploration Quality Eval");
  process.exit(2);
}

const gateway = createGateway({
  deepseekKey: key,
  mx2BaseUrl: process.env.M_X2_BASE_URL ?? "https://api.deepseek.com",
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
});

const results = [];
for (const fixture of EXPLORATION_QUALITY_FIXTURES) {
  const gate = plannerGate({
    questionCount: fixture.questionCount,
    forceDeeper: fixture.forceDeeper ?? false,
  });

  const context = buildPlannerContext({
    experience: fixture.experience,
    evidenceText: fixture.evidence
      .map((evidence, index) => `[E${index + 1}] author=subject; eligibility=eligible\n${evidence}`)
      .join("\n\n"),
    currentClaims: [],
    questions: fixture.previousQuestions.map((question, index) => ({
      sequence: index + 1,
      question,
      intent: "synthetic fixture prior question",
      status: "answered",
    })),
    lastStep: null,
    questionCount: fixture.questionCount,
    forceDeeper: fixture.forceDeeper ?? false,
  });
  const model = gateway.describe(OBSERVATION_MODEL_ROUTE);
  const startedAt = Date.now();
  const plan =
    gate.action === "stop"
      ? deterministicStopPlan({ gate })
      : await generateExplorationPlan(gateway, context);
  const timing = { planner_ms: gate.action === "stop" ? 0 : Date.now() - startedAt };
  const lineage = {
    policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
    prompt_version: EXPLORATION_PLAN_PROMPT_VERSION,
    model_route: model.route,
    model_version: model.model,
    validator_version: PLAN_VALIDATOR_VERSION,
    input_fingerprint: inputFingerprint([
      PURPOSEFUL_EXPLORATION_POLICY.version,
      EXPLORATION_PLAN_PROMPT_VERSION,
      PLAN_VALIDATOR_VERSION,
      model.route,
      model.model,
      context,
    ]),
    decision_source: gate.action === "stop" ? "deterministic_gate" : "semantic_planner",
  };
  const quality = evaluateExplorationQuality(fixture, plan);
  const lineageCheck = evaluateDecisionLineage(lineage);
  const latencyCheck = evaluateLatencySegments(timing, ["planner_ms"]);

  results.push({
    model: gateway.describe(OBSERVATION_MODEL_ROUTE).model,
    ...quality,
    pass: quality.pass && lineageCheck.pass && latencyCheck.pass,
    lineage,
    timing,
    lineage_check: lineageCheck,
    latency_check: latencyCheck,
    plan,
  });
}

console.log(
  JSON.stringify(
    {
      coverage:
        "live synthetic Planner candidates; deterministic fixture assertions, lineage and Planner latency",
      excluded: [
        "database publication/replay",
        "Save ACK latency",
        "Final Synthesis",
        "Revision",
        "general semantic correctness",
      ],
      execution_contract_tests:
        "test/core-reliability.test.ts and test/exploration-quality.test.ts",
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.pass)) process.exit(1);
