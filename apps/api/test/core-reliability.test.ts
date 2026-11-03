import { coreSchema, createDb } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { inputFingerprint } from "../src/core/epistemic-policy.js";
import {
  evaluateDecisionLineage,
  evaluateLatencySegments,
} from "../src/core/exploration-quality.js";

const testUrl = process.env.DATABASE_URL_TEST;
const dbDescribe = testUrl ? describe : describe.skip;

function fakeGateway(options?: { onExtract?: () => void }) {
  const gateway = {
    extract: async (input: { system?: string; text?: string }) => {
      options?.onExtract?.();
      const system = input.system ?? "";
      const text = input.text ?? "";
      if (system.includes("目标不是延长对话")) {
        const asked = Number(text.match(/"asked":(\d+)/)?.[1] ?? "0");
        const forceDeeper = text.includes('"force_deeper":true');
        if (asked === 0) {
          return {
            current_reading: "目前能确认的是：这次选择发生在信息还不完整的具体情境中。",
            key_uncertainty: "真正影响当时选择的是信息不足，还是其他约束？",
            decision: "ask",
            question: "当时最影响你决定的是什么？",
            intent: "不同答案会改变当前理解的适用范围，而不是只增加细节。",
            quick_options: ["信息还不完整", "时机不合适"],
            stop_reason: null,
          };
        }
        if (forceDeeper && asked < 5) {
          return {
            current_reading: "目前更支持：信息完整度会影响你是否立即表达。",
            key_uncertainty: "信息充分时，这种先等待的选择是否仍会出现？",
            decision: "ask",
            question: `如果信息已经充分，同类讨论里你通常还会先等一会儿吗？（第${asked + 1}问）`,
            intent: "这能区分一次性的情境选择和更广范围的模式，从而改变适用范围。",
            quick_options: ["通常还是会等", "通常会直接表达"],
            stop_reason: null,
          };
        }
        return {
          current_reading: "现在更能确认：你当时先等待，主要与信息尚未确认有关。",
          key_uncertainty: "其他情境下是否也会这样，留给后续真实经历验证。",
          decision: "stop",
          question: null,
          intent: "继续追问主要会增加细节，不足以显著改变这次有限理解。",
          quick_options: [],
          stop_reason: "当前材料已经足够形成有限认识，剩余未知更适合未来事件验证。",
        };
      }
      if (system.includes("认识修订器") && text.includes("全部撤回")) {
        return {
          claims: [],
          gaps: [],
          next_question: null,
          change_summary: "原有理解全部撤回，目前不形成替代结论。",
          revision_reason: "用户补充的信息使原理解不再成立。",
          withdrawn_claim_keys: ["wait_for_information"],
        };
      }
      if (system.includes("认识修订器")) {
        return {
          claims: [
            {
              key: "wait_for_information",
              kind: "pattern",
              mode: "observation",
              text: "在这次信息尚不完整的情境里，你选择先等待，再补充表达。",
              scope: "仅限这次信息未准备完整的讨论情境。",
              confidence_level: "medium",
              confidence_basis: "来自本次事件与补充说明，尚无跨情境重复。",
              evidence: [
                {
                  evidence_key: "E1",
                  relation: "supports",
                  directness: "direct",
                  contribution: "medium",
                  scope_match: "同一事件",
                  rationale: "直接描述了事件背景。",
                },
                {
                  evidence_key: "E3",
                  relation: "supports",
                  directness: "direct",
                  contribution: "high",
                  scope_match: "同一事件的纠正",
                  rationale: "直接补充了原理解遗漏的背景。",
                },
              ],
            },
          ],
          gaps: [
            {
              key: "gap_repeat",
              question: "信息充分时你是否也会等待？",
              why_it_matters: "这会改变当前认识的适用范围。",
            },
          ],
          next_question: null,
          change_summary: "把理解收窄到信息未完整的情境。",
          revision_reason: "用户补充了关键背景。",
          withdrawn_claim_keys: [],
        };
      }
      if (text.includes("证据不足")) {
        return {
          claims: [],
          gaps: [
            {
              key: "gap_missing_context",
              question: "还缺少什么背景才能形成可靠认识？",
              why_it_matters: "当前材料不足以区分不同解释。",
            },
          ],
          next_question: null,
        };
      }
      return {
        claims: [
          {
            key: "wait_for_information",
            kind: "pattern",
            mode: "observation",
            text: "在这次信息尚不完整的情境里，你选择先等待，再补充表达。",
            scope: "仅限这次信息未准备完整的讨论情境。",
            confidence_level: "medium",
            confidence_basis: "来自单次事件，仍需要其他情境验证。",
            evidence: [
              {
                evidence_key: "E1",
                relation: "supports",
                directness: "direct",
                contribution: "medium",
                scope_match: "同一事件",
                rationale: "直接描述了事件。",
              },
              {
                evidence_key: "E2",
                relation: "supports",
                directness: "direct",
                contribution: "high",
                scope_match: "同一事件的回答",
                rationale: "直接补充了当时约束。",
              },
            ],
          },
        ],
        gaps: [
          {
            key: "gap_repeat",
            question: "信息充分时你是否也会等待？",
            why_it_matters: "这会改变当前认识的适用范围。",
          },
        ],
        next_question: null,
      };
    },
    chat: async () => ({ text: "" }),
    describe: (route: string) => ({ route, model: "test-observation-model" }),
  };
  return gateway as unknown as NonNullable<Parameters<typeof createApp>[0]["gateway"]>;
}

function scriptedGateway(
  extract: (input: { system?: string; text?: string }) => Promise<Record<string, unknown>>,
) {
  return {
    extract,
    chat: async () => ({ text: "" }),
    describe: (route: string) => ({ route, model: "test-observation-model" }),
  } as unknown as NonNullable<Parameters<typeof createApp>[0]["gateway"]>;
}

dbDescribe("Core reliability", () => {
  const { db, sql } = createDb(testUrl ?? "");
  const app = createApp({
    db,
    gateway: fakeGateway(),
    auth: { mode: "static", accessToken: "secret" },
  });
  const auth = {
    Authorization: "Bearer secret",
    "content-type": "application/json",
  };

  beforeEach(async () => {
    await sql.unsafe("TRUNCATE TABLE tenants, access_bootstrap_tokens RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await sql.end();
  });

  async function start(
    key = "start-1",
    event = "评审临时提前，关键数据还没核完，所以我先听讨论。",
  ) {
    const response = await app.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify({ event }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function plan(
    explorationId: string,
    expectedVersion: number,
    key = "plan-1",
    forceDeeper = false,
  ) {
    const response = await app.request(`/api/core/explorations/${explorationId}/continue`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify({ expected_version: expectedVersion, force_deeper: forceDeeper }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function respond(
    started: Awaited<ReturnType<typeof start>>,
    planned: Awaited<ReturnType<typeof plan>>,
    key = "respond-1",
    selectedOptions: string[] = [],
  ) {
    const response = await app.request(`/api/core/explorations/${started.exploration.id}/respond`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify({
        expected_version: planned.version,
        question_id: planned.question.id,
        answer: "主要是数据没确认；确认后我补充了观点。",
        selected_options: selectedOptions,
      }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function understand(
    keyPrefix = "flow",
    event = "评审临时提前，关键数据还没核完，所以我先听讨论。",
  ) {
    const started = await start(`${keyPrefix}-start`, event);
    const planned = await plan(
      started.exploration.id,
      started.exploration.version,
      `${keyPrefix}-plan`,
    );
    const answered = await respond(started, planned, `${keyPrefix}-respond`);
    const understood = await plan(
      started.exploration.id,
      answered.version,
      `${keyPrefix}-synthesize`,
    );
    return { started, planned, answered, understood };
  }

  it("同一 Start Idempotency-Key 重放只创建一份领域数据", async () => {
    const first = await start("same-start");
    const second = await start("same-start");

    expect(second.exploration.id).toBe(first.exploration.id);
    expect((await db.select().from(coreSchema.explorations)).length).toBe(1);
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(1);
  });

  it("相同 Idempotency-Key 携带不同 payload 返回 409", async () => {
    await start("reused-key");
    const response = await app.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "reused-key" },
      body: JSON.stringify({ event: "这是另一个事件。" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("Start 不依赖模型即可先保存，Planner 缺模型时明确失败", async () => {
    const noModelApp = createApp({
      db,
      auth: { mode: "static", accessToken: "secret" },
    });
    const started = await noModelApp.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "no-model-start" },
      body: JSON.stringify({ event: "这条输入必须先保存。" }),
    });
    expect(started.status).toBe(201);
    const startedBody = await started.json();
    expect(startedBody.phase).toBe("ready_to_plan");
    expect(startedBody.saved).toBe(true);

    const continued = await noModelApp.request(
      `/api/core/explorations/${startedBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "no-model-plan" },
        body: JSON.stringify({ expected_version: startedBody.exploration.version }),
      },
    );
    expect(continued.status).toBe(503);
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(1);
  });

  it("Quick options 支持多选且无需强制补自由文本", async () => {
    const started = await start("multi-start");
    const planned = await plan(started.exploration.id, started.exploration.version, "multi-plan");
    const response = await app.request(`/api/core/explorations/${started.exploration.id}/respond`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "multi-respond" },
      body: JSON.stringify({
        expected_version: planned.version,
        question_id: planned.question.id,
        answer: "",
        selected_options: ["信息还不完整", "时机不合适"],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.phase).toBe("ready_to_plan");

    const sources = await db.select().from(coreSchema.sourceItems);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.content).toContain("信息还不完整；时机不合适");
  });

  it("Planner 持久化 policy/prompt/model/validator/input fingerprint 决策血缘", async () => {
    const started = await start("lineage-start");
    const planned = await plan(started.exploration.id, started.exploration.version, "lineage-plan");

    expect(planned.question_budget.policy_version).toBe("epistemic-policy@v1");

    const steps = await db.select().from(coreSchema.explorationSteps);
    expect(steps).toHaveLength(1);
    const meta = steps[0]?.modelMeta as Record<string, unknown>;
    expect(meta.policy_version).toBe("epistemic-policy@v1");
    expect(meta.prompt_version).toBe("purposeful-planner-prompt@v5");
    expect(meta.model_route).toBe("observation_model");
    expect(meta.model_version).toBe("test-observation-model");
    expect(meta.validator_version).toBe("exploration-plan-validator@v2");
    expect(String(meta.input_fingerprint)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(meta.validator_status).toBe("passed");
  });

  it("Respond 快速写入可安全重放，且旧 expected_version 被拒绝", async () => {
    const started = await start();
    const planned = await plan(started.exploration.id, started.exploration.version, "respond-plan");
    const first = await respond(started, planned, "same-respond", ["信息还不完整"]);
    const replay = await respond(started, planned, "same-respond", ["信息还不完整"]);

    expect(replay.source_id).toBe(first.source_id);
    expect(replay.phase).toBe("ready_to_plan");
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(2);

    const stale = await app.request(`/api/core/explorations/${started.exploration.id}/respond`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "stale-respond" },
      body: JSON.stringify({
        expected_version: started.exploration.version,
        question_id: planned.question.id,
        answer: "再次提交旧版本。",
        selected_options: [],
      }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("STALE_VERSION");
  });

  it("探索可恢复、用户可主动再深入并完成", async () => {
    const { started, understood } = await understand("resume");

    const detail = await app.request(`/api/core/explorations/${started.exploration.id}`, {
      headers: auth,
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.phase).toBe("review");
    expect(detailBody.latest_step.decision).toBe("stop");

    const continuedBody = await plan(
      started.exploration.id,
      understood.version,
      "continue-deeper",
      true,
    );
    expect(continuedBody.phase).toBe("awaiting_answer");

    const resumed = await app.request(`/api/core/explorations/${started.exploration.id}`, {
      headers: auth,
    });
    expect((await resumed.json()).open_question.id).toBe(continuedBody.question.id);

    const completed = await app.request(
      `/api/core/explorations/${started.exploration.id}/complete`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "complete-1" },
        body: JSON.stringify({ expected_version: continuedBody.version }),
      },
    );
    expect(completed.status).toBe(200);

    const active = await app.request("/api/core/explorations?status=active&limit=20", {
      headers: auth,
    });
    expect((await active.json()).items).toHaveLength(0);
  });

  it("默认预算由 deterministic gate 截止，不再调用 Planner 生成第 4 问", async () => {
    const { started, understood } = await understand("budget-gate");
    const question2 = await plan(started.exploration.id, understood.version, "budget-q2", true);
    const answer2 = await respond(started, question2, "budget-a2");
    const question3 = await plan(started.exploration.id, answer2.version, "budget-q3", true);
    const answer3 = await respond(started, question3, "budget-a3");

    const stopped = await plan(started.exploration.id, answer3.version, "budget-stop", false);
    expect(stopped.phase).toBe("review");
    expect(stopped.question_budget.asked).toBe(3);

    const steps = (await db.select().from(coreSchema.explorationSteps)).sort(
      (a, b) => a.sequence - b.sequence,
    );
    const lastMeta = steps.at(-1)?.modelMeta as Record<string, unknown>;
    expect(steps.at(-1)?.decision).toBe("stop");
    expect(lastMeta.decision_source).toBe("deterministic_gate");
    expect(lastMeta.validator_status).toBe("gate_stop");
    expect(lastMeta.planner_attempts).toBe(0);
    expect((await db.select().from(coreSchema.explorationQuestions)).length).toBe(3);
  });

  it("并发纠正基于同一 version 时只允许一个成功", async () => {
    const { started, understood } = await understand("concurrent-correct");
    const revisionIds = understood.claims.map(
      (claim: { claim_revision_id: string }) => claim.claim_revision_id,
    );

    const submit = (key: string, note: string) =>
      app.request(`/api/core/explorations/${started.exploration.id}/correct`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": key },
        body: JSON.stringify({
          expected_version: understood.version,
          claim_revision_ids: revisionIds,
          correction: { type: "missing_context", note },
        }),
      });

    const [first, second] = await Promise.all([
      submit("correct-a", "补充背景 A：当时主要是信息不完整。"),
      submit("correct-b", "补充背景 B：当时还受到时间限制。"),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(["STALE_VERSION", "STALE_CLAIM_REVISION"]).toContain((await conflict.json()).error.code);
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(3);
  });

  it("证据不足时成功返回 insufficient，不强造 Claim", async () => {
    const { started, understood } = await understand(
      "insufficient",
      "证据不足：只有一句很模糊的记录。",
    );

    expect(understood.outcome).toBe("insufficient");
    expect(understood.claims).toHaveLength(0);
    expect(understood.gaps.length).toBeGreaterThan(0);

    const detail = await app.request(`/api/core/explorations/${started.exploration.id}`, {
      headers: auth,
    });
    const detailBody = await detail.json();
    expect(detailBody.phase).toBe("insufficient");
    expect(detailBody.understanding.outcome).toBe("insufficient");

    const current = await app.request("/api/core/understanding", { headers: auth });
    expect((await current.json()).state).toBe("empty");
  });

  it("全部撤回后返回 withdrawn，刷新后仍保持 withdrawn", async () => {
    const { started, understood } = await understand("withdraw");
    const revisionIds = understood.claims.map(
      (claim: { claim_revision_id: string }) => claim.claim_revision_id,
    );

    const corrected = await app.request(
      `/api/core/explorations/${started.exploration.id}/correct`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "withdraw-all" },
        body: JSON.stringify({
          expected_version: understood.version,
          claim_revision_ids: revisionIds,
          correction: {
            type: "overinterpreted",
            note: "全部撤回：现有材料不足以支持原来的理解。",
          },
        }),
      },
    );
    expect(corrected.status).toBe(201);
    const correctedBody = await corrected.json();
    expect(correctedBody.outcome).toBe("withdrawn");
    expect(correctedBody.claims).toHaveLength(0);

    const detail = await app.request(`/api/core/explorations/${started.exploration.id}`, {
      headers: auth,
    });
    const detailBody = await detail.json();
    expect(detailBody.phase).toBe("review");
    expect(detailBody.understanding.outcome).toBe("withdrawn");

    const current = await app.request("/api/core/understanding", { headers: auth });
    expect((await current.json()).state).toBe("empty");
  });

  it("输入更正保留原文但旧证据退出分析，新来源可重新综合", async () => {
    const { started, understood } = await understand("amend");
    const targetSourceId = understood.evidence[1].sourceItemId as string;

    const amended = await app.request(`/api/core/explorations/${started.exploration.id}/amend`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "amend-correct" },
      body: JSON.stringify({
        expected_version: understood.version,
        target_source_id: targetSourceId,
        type: "corrects",
        note: "刚才说得不准确，实际主要是信息没确认，不是我不想表达。",
      }),
    });
    expect(amended.status).toBe(201);
    const amendedBody = await amended.json();
    expect(amendedBody.phase).toBe("ready_to_plan");

    const links = await db.select().from(coreSchema.sourceLinks);
    expect(links).toHaveLength(1);
    expect(links[0]?.relation).toBe("corrects");

    const currentAssessments = await db.select().from(coreSchema.sourceAssessments);
    const targetCurrent = currentAssessments.find(
      (assessment) => assessment.sourceItemId === targetSourceId && assessment.isCurrent,
    );
    expect(targetCurrent?.eligibility).toBe("excluded");

    const resynthesized = await plan(
      started.exploration.id,
      amendedBody.version,
      "amend-resynthesize",
    );
    expect(resynthesized.phase).toBe("review");
    expect(
      resynthesized.evidence.some(
        (item: { sourceItemId: string }) => item.sourceItemId === targetSourceId,
      ),
    ).toBe(false);
  });

  it("来源归属改为 other 后保留材料，但不再作为本人观点的有效证据", async () => {
    const { started, understood } = await understand("not-mine");
    const sourceId = understood.evidence[1].sourceItemId as string;

    const assessment = await app.request(`/api/core/sources/${sourceId}/assessment`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "not-mine-source" },
      body: JSON.stringify({
        expected_assessment_version: 1,
        assessment: {
          attribution_status: "confirmed_other",
          context_completeness: "partial",
          temporal_precision: "unknown",
          eligibility: "context_only",
          rationale: "用户指出这段内容不是本人表达。",
        },
      }),
    });
    expect(assessment.status).toBe(200);

    const detail = await app.request(`/api/core/explorations/${started.exploration.id}`, {
      headers: auth,
    });
    const detailBody = await detail.json();
    const evidence = detailBody.evidence.find(
      (item: { source_item_id: string }) => item.source_item_id === sourceId,
    );
    expect(evidence.attribution_status).toBe("confirmed_other");
    expect(evidence.eligibility).toBe("context_only");
    expect(detailBody.phase).toBe("needs_review");

    const current = await app.request("/api/core/understanding", { headers: auth });
    const currentBody = await current.json();
    expect(currentBody.claims).toHaveLength(0);
    expect(currentBody.needs_review).toHaveLength(1);
  });

  it("来源排除立即使依赖认识退出有效 Current Understanding", async () => {
    const { started, understood } = await understand("exclude");
    const sourceId = understood.evidence[1].sourceItemId as string;

    const assessment = await app.request(`/api/core/sources/${sourceId}/assessment`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "exclude-source" },
      body: JSON.stringify({
        expected_assessment_version: 1,
        assessment: {
          attribution_status: "confirmed_subject",
          context_completeness: "partial",
          temporal_precision: "unknown",
          eligibility: "excluded",
          rationale: "用户明确要求这条来源不再参与分析。",
        },
      }),
    });
    expect(assessment.status).toBe(200);

    const current = await app.request("/api/core/understanding", { headers: auth });
    const currentBody = await current.json();
    expect(currentBody.claims).toHaveLength(0);
    expect(currentBody.state).toBe("needs_review");
    expect(currentBody.needs_review).toHaveLength(1);
  });

  it("Start/Respond 只报告 save_ms 且不调用模型，Continue 分开报告 planner/synthesis", async () => {
    let extractCalls = 0;
    const timingApp = createApp({
      db,
      gateway: fakeGateway({ onExtract: () => extractCalls++ }),
      auth: { mode: "static", accessToken: "secret" },
    });
    const started = await timingApp.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "timing-start" },
      body: JSON.stringify({ event: "这条事件先保存，再决定是否追问。" }),
    });
    const startBody = await started.json();
    expect(started.status).toBe(201);
    expect(startBody.timing.save_ms).toBeGreaterThanOrEqual(0);
    expect(startBody.timing.planner_ms).toBeUndefined();
    expect(extractCalls).toBe(0);

    const asked = await timingApp.request(
      `/api/core/explorations/${startBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "timing-ask" },
        body: JSON.stringify({ expected_version: startBody.exploration.version }),
      },
    );
    const askedBody = await asked.json();
    expect(asked.status).toBe(201);
    expect(askedBody.timing.planner_ms).toBeGreaterThanOrEqual(0);
    expect(askedBody.timing.synthesis_ms).toBeUndefined();
    expect(extractCalls).toBe(1);

    const answered = await timingApp.request(
      `/api/core/explorations/${startBody.exploration.id}/respond`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "timing-answer" },
        body: JSON.stringify({
          expected_version: askedBody.version,
          question_id: askedBody.question.id,
          answer: "数据核完后我会补充观点。",
          selected_options: [],
        }),
      },
    );
    const answeredBody = await answered.json();
    expect(answered.status).toBe(201);
    expect(answeredBody.timing.save_ms).toBeGreaterThanOrEqual(0);
    expect(answeredBody.timing.planner_ms).toBeUndefined();
    expect(extractCalls).toBe(1);

    const synthesized = await timingApp.request(
      `/api/core/explorations/${startBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "timing-stop" },
        body: JSON.stringify({ expected_version: answeredBody.version }),
      },
    );
    const synthesizedBody = await synthesized.json();
    expect(synthesized.status).toBe(201);
    expect(synthesizedBody.timing.planner_ms).toBeGreaterThanOrEqual(0);
    expect(synthesizedBody.timing.synthesis_ms).toBeGreaterThanOrEqual(0);
    expect(extractCalls).toBe(3);
    expect(evaluateLatencySegments({ ...startBody.timing, ...synthesizedBody.timing }).pass).toBe(
      true,
    );
    const stopStep = (await db.select().from(coreSchema.explorationSteps)).find(
      (step) => step.decision === "stop",
    );
    const meta = stopStep?.modelMeta ?? {};
    expect(evaluateDecisionLineage(meta).pass).toBe(true);
    expect(
      evaluateDecisionLineage({
        policy_version: meta.policy_version,
        prompt_version: meta.synthesis_prompt_version,
        model_route: meta.synthesis_model_route,
        model_version: meta.synthesis_model_version,
        validator_version: meta.synthesis_validator_version,
        input_fingerprint: meta.synthesis_input_fingerprint,
        decision_source: "synthesis",
      }).pass,
    ).toBe(true);
  });

  it("理解越界会带具体 policy issue 重试；两次失败不发布，之后可重试", async () => {
    let understandingCalls = 0;
    let allowUnderstanding = false;
    let revisionCalls = 0;
    let allowRevision = false;
    const retryTexts: string[] = [];
    const retryApp = createApp({
      db,
      gateway: scriptedGateway(async (input) => {
        const system = input.system ?? "";
        if (system.includes("目标不是延长对话")) {
          const asked = Number((input.text ?? "").match(/"asked":(\d+)/)?.[1] ?? "0");
          return asked === 0
            ? {
                current_reading: "这次先等待与信息尚未确认有关。",
                key_uncertainty: "信息确认后是否会直接表达？",
                decision: "ask",
                question: "数据确认后你会直接表达吗？",
                intent: "不同答案会改变这次理解的适用范围。",
                quick_options: ["会直接表达", "仍会等待"],
                stop_reason: null,
              }
            : {
                current_reading: "现有材料足以形成有限认识。",
                key_uncertainty: "其他情境仍待未来验证。",
                decision: "stop",
                question: null,
                intent: "继续追问只会增加细节。",
                quick_options: [],
                stop_reason: "先整理当前材料。",
              };
        }
        if (system.includes("认识整理器")) {
          understandingCalls++;
          retryTexts.push(input.text ?? "");
          if (!allowUnderstanding || understandingCalls % 2 === 1) {
            return {
              claims: [
                {
                  key: "wait_for_information",
                  kind: "pattern",
                  mode: "observation",
                  text: "你总是会等待。",
                  scope: "所有场景",
                  confidence_level: "medium",
                  confidence_basis: "一次事件。",
                  evidence: [
                    {
                      evidence_key: "E1",
                      relation: "supports",
                      directness: "direct",
                      contribution: "high",
                      scope_match: "同一事件",
                      rationale: "事件描述。",
                    },
                  ],
                },
              ],
              gaps: [],
              next_question: null,
            };
          }
          return {
            claims: [
              {
                key: "wait_for_information",
                kind: "pattern",
                mode: "observation",
                text: "这次信息未确认时你先等待。",
                scope: "仅限这次讨论",
                confidence_level: "medium",
                confidence_basis: "来自本次事件与回答。",
                evidence: [
                  {
                    evidence_key: "E1",
                    relation: "supports",
                    directness: "direct",
                    contribution: "high",
                    scope_match: "同一事件",
                    rationale: "事件描述。",
                  },
                ],
              },
            ],
            gaps: [],
            next_question: null,
          };
        }
        if (system.includes("认识修订器")) {
          revisionCalls++;
          retryTexts.push(input.text ?? "");
          if (!allowRevision || revisionCalls % 2 === 1) {
            return {
              claims: [
                {
                  key: "wait_for_information",
                  kind: "pattern",
                  mode: "observation",
                  text: "你总是会等待。",
                  scope: "所有场景",
                  confidence_level: "medium",
                  confidence_basis: "一次事件。",
                  evidence: [
                    {
                      evidence_key: "E1",
                      relation: "supports",
                      directness: "direct",
                      contribution: "high",
                      scope_match: "同一事件",
                      rationale: "原始事件。",
                    },
                  ],
                },
              ],
              gaps: [],
              next_question: null,
              change_summary: "错误地泛化。",
              revision_reason: "错误地泛化。",
              withdrawn_claim_keys: [],
            };
          }
          return {
            claims: [
              {
                key: "wait_for_information",
                kind: "pattern",
                mode: "observation",
                text: "信息未确认时先听，信息充分时会直接表达。",
                scope: "仅限信息未确认与信息充分这两类讨论情境。",
                confidence_level: "medium",
                confidence_basis: "来自事件、回答与反例纠正。",
                evidence: [
                  {
                    evidence_key: "E1",
                    relation: "supports",
                    directness: "direct",
                    contribution: "high",
                    scope_match: "原始事件",
                    rationale: "说明信息未确认时先听。",
                  },
                  {
                    evidence_key: "E3",
                    relation: "challenges",
                    directness: "direct",
                    contribution: "high",
                    scope_match: "反例情境",
                    rationale: "说明信息充分时会直接表达。",
                  },
                ],
              },
            ],
            gaps: [],
            next_question: null,
            change_summary: "按反例收窄认识。",
            revision_reason: "反例说明原范围过宽。",
            withdrawn_claim_keys: [],
          };
        }
        throw new Error("unexpected_model_route");
      }),
      auth: { mode: "static", accessToken: "secret" },
    });
    const started = await retryApp.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "retry-start" },
      body: JSON.stringify({ event: "数据没确认时我先听讨论。" }),
    });
    const startBody = await started.json();
    const asked = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "retry-ask" },
        body: JSON.stringify({ expected_version: startBody.exploration.version }),
      },
    );
    const askBody = await asked.json();
    const answered = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/respond`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "retry-answer" },
        body: JSON.stringify({
          expected_version: askBody.version,
          question_id: askBody.question.id,
          answer: "确认后会表达。",
          selected_options: [],
        }),
      },
    );
    const answerBody = await answered.json();

    const rejected = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "retry-rejected" },
        body: JSON.stringify({ expected_version: answerBody.version }),
      },
    );
    expect(rejected.status).toBe(500);
    expect(understandingCalls).toBe(2);
    expect(retryTexts[1]).toContain("claim_scope_overreach:wait_for_information");
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(2);
    expect((await db.select().from(coreSchema.claimRevisions)).length).toBe(0);

    allowUnderstanding = true;
    const retried = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "retry-valid" },
        body: JSON.stringify({ expected_version: answerBody.version }),
      },
    );
    expect(retried.status).toBe(201);
    const retriedBody = await retried.json();
    expect(retriedBody.claims).toHaveLength(1);
    const stopMeta = (await db.select().from(coreSchema.explorationSteps)).find(
      (step) => step.decision === "stop",
    )?.modelMeta;
    expect(stopMeta?.synthesis_input_fingerprint).toBe(
      inputFingerprint([
        "epistemic-policy@v1",
        "understanding-prompt@v2",
        "understanding-policy-validator@v2",
        "observation_model",
        "test-observation-model",
        answerBody.version,
        retryTexts[3],
      ]),
    );

    const rejectedRevision = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/correct`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "revision-rejected" },
        body: JSON.stringify({
          expected_version: retriedBody.version,
          claim_revision_ids: retriedBody.claims.map(
            (claim: { claim_revision_id: string }) => claim.claim_revision_id,
          ),
          correction: {
            type: "missing_context",
            note: "反例：信息充分的同类讨论里我会直接表达。",
          },
        }),
      },
    );
    expect(rejectedRevision.status).toBe(500);
    expect(revisionCalls).toBe(2);
    expect(retryTexts.at(-1)).toContain("claim_scope_overreach:wait_for_information");
    expect((await db.select().from(coreSchema.sourceItems)).length).toBe(2);
    expect(
      (await db.select().from(coreSchema.claimRevisions)).filter(
        (revision) => revision.status === "current",
      ),
    ).toHaveLength(1);

    allowRevision = true;
    const revised = await retryApp.request(
      `/api/core/explorations/${startBody.exploration.id}/correct`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "revision-valid" },
        body: JSON.stringify({
          expected_version: retriedBody.version,
          claim_revision_ids: retriedBody.claims.map(
            (claim: { claim_revision_id: string }) => claim.claim_revision_id,
          ),
          correction: {
            type: "missing_context",
            note: "反例：信息充分的同类讨论里我会直接表达。",
          },
        }),
      },
    );
    expect(revised.status).toBe(201);
    const revisedBody = await revised.json();
    expect(revisedBody.claims[0].scope).toContain("信息充分");
    const sourcesAfterRevision = await db.select().from(coreSchema.sourceItems);
    expect(sourcesAfterRevision).toHaveLength(3);
    const correctionSource = sourcesAfterRevision.find((source) =>
      source.content.includes("反例：信息充分的同类讨论里"),
    );
    const generation = (correctionSource?.sourceMeta as Record<string, unknown>)
      .generation as Record<string, unknown>;
    expect(evaluateDecisionLineage(generation).pass).toBe(true);
    expect(generation.policy_version).toBe("epistemic-policy@v1");
    expect(generation.prompt_version).toBe("revision-prompt@v2");
    expect(generation.model_route).toBe("observation_model");
    expect(generation.model_version).toBe("test-observation-model");
    expect(generation.validator_version).toBe("revision-policy-validator@v1");
    expect(String(generation.input_fingerprint)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(generation.decision_source).toBe("revision");
    expect(generation.input_fingerprint).toBe(
      inputFingerprint([
        "epistemic-policy@v1",
        "revision-prompt@v2",
        "revision-policy-validator@v1",
        "observation_model",
        "test-observation-model",
        retriedBody.version,
        retryTexts.at(-1),
      ]),
    );
    expect(generation.revision_latency_ms).toEqual(expect.any(Number));
    expect(generation.claim_revision_ids).toEqual(
      revisedBody.claims.map((claim: { claim_revision_id: string }) => claim.claim_revision_id),
    );
  });

  it("反例纠正会把收窄后的认识关联到真实纠正证据", async () => {
    const { started, understood } = await understand("counterexample");
    const corrected = await app.request(
      `/api/core/explorations/${started.exploration.id}/correct`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "counterexample-correct" },
        body: JSON.stringify({
          expected_version: understood.version,
          claim_revision_ids: understood.claims.map(
            (claim: { claim_revision_id: string }) => claim.claim_revision_id,
          ),
          correction: {
            type: "missing_context",
            note: "反例：另一场信息已经充分的讨论里，我会直接表达。",
          },
        }),
      },
    );
    expect(corrected.status).toBe(201);
    const body = await corrected.json();
    expect(body.claims[0].scope).toContain("信息未准备完整");
    const correctionSource = (await db.select().from(coreSchema.sourceItems)).find((source) =>
      source.content.includes("反例：另一场信息已经充分"),
    );
    expect(correctionSource).toBeDefined();
    const correctionSpan = (await db.select().from(coreSchema.evidenceSpans)).find(
      (span) => span.sourceItemId === correctionSource?.id,
    );
    const claimEvidence = await db.select().from(coreSchema.claimEvidence);
    expect(claimEvidence.some((link) => link.evidenceSpanId === correctionSpan?.id)).toBe(true);
  });
  it("Planner 重试的血缘指纹对应实际带纠错约束的输入", async () => {
    const inputs: string[] = [];
    const baseline = fakeGateway();
    const retryApp = createApp({
      db,
      auth: { mode: "static", accessToken: "secret" },
      gateway: scriptedGateway(async (input) => {
        inputs.push(input.text ?? "");
        if (inputs.length === 1)
          return {
            current_reading: "你是回避型人格。",
            key_uncertainty: "信息是否确认？",
            decision: "ask",
            question: "当时信息确认了吗？",
            intent: "区分信息约束与其他约束。",
            quick_options: [],
            stop_reason: null,
          };
        return baseline.extract(input as Parameters<typeof baseline.extract>[0]) as Promise<
          Record<string, unknown>
        >;
      }),
    });
    const startedResponse = await retryApp.request("/api/core/explorations", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "planner-retry-start" },
      body: JSON.stringify({ event: "信息还没确认时先听讨论。" }),
    });
    const started = await startedResponse.json();
    const response = await retryApp.request(
      `/api/core/explorations/${started.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": "planner-retry-plan" },
        body: JSON.stringify({ expected_version: started.exploration.version }),
      },
    );
    expect(response.status).toBe(201);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("plan_scope_overreach");
    const meta = (await db.select().from(coreSchema.explorationSteps))[0]?.modelMeta;
    expect(meta?.planner_attempts).toBe(2);
    expect(meta?.input_fingerprint).toBe(
      inputFingerprint([
        "epistemic-policy@v1",
        "purposeful-planner-prompt@v5",
        "exploration-plan-validator@v2",
        "observation_model",
        "test-observation-model",
        started.exploration.version,
        inputs[1],
      ]),
    );
  });
});
