import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlannerContext } from "../src/core/epistemic-policy.js";
import {
  CONVERSATION_REPLY_PROMPT_VERSION,
  EXPLORATION_PLAN_PROMPT_VERSION,
  generateConversationReply,
  generateExplorationPlan,
} from "../src/core/llm.js";
import { createGateway } from "../src/llm/gateway.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class {
      static APIConnectionTimeoutError = actual.default.APIConnectionTimeoutError;
      static AuthenticationError = actual.default.AuthenticationError;
      static NotFoundError = actual.default.NotFoundError;
      static RateLimitError = actual.default.RateLimitError;
      static BadRequestError = actual.default.BadRequestError;
      static APIError = actual.default.APIError;
      chat = { completions: { create: mocks.create } };
    },
  };
});

const gateway = () =>
  createGateway({
    deepseekKey: "synthetic-key",
    mx2BaseUrl: "https://provider.invalid",
    deepseekModel: "synthetic-model",
  });

const initial =
  "参加周末展览，直达车费用较低，换乘车时间较短但晚间末班安排未知。我必须在闭馆前到达。";
const update = "换乘车运营方已发书面时刻表，确认活动期间包括加场日都有闭馆前到达的班次。";
const oldUncertainty = "换乘车在加场日是否也能在闭馆前到达？";

function plannerInput(includeUpdate: boolean) {
  return buildPlannerContext({
    experience: initial,
    evidenceText: [
      `[E1] author=user; eligibility=eligible\n${initial}`,
      ...(includeUpdate ? [`[E2] author=user; eligibility=eligible\n${update}`] : []),
    ].join("\n\n"),
    currentClaims: [],
    // This fact was volunteered, rather than an answer to a formal question.
    questions: [],
    lastStep: {
      current_reading: "目前仍在比较交通方案。",
      key_uncertainty: oldUncertainty,
      decision: "ask",
    },
    questionCount: 0,
    forceDeeper: false,
  });
}

function respondWith(output: unknown) {
  mocks.create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(output) } }],
  });
}

function sentMessages() {
  expect(mocks.create).toHaveBeenCalledTimes(1);
  const body = mocks.create.mock.calls[0]![0];
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
    "system",
    "user",
  ]);
  return {
    system: body.messages[0].content as string,
    input: body.messages[1].content as string,
  };
}

beforeEach(() => mocks.create.mockReset());

// These inspect the actual provider-bound request and schema-parsed scripted
// responses. They guard prompt/context wiring, not a live model's compliance.
describe("conversation and planner provider request contracts (DB-free)", () => {
  it("sends volunteered new evidence alongside the stale uncertainty and explicit reconciliation rules", async () => {
    const stop = {
      current_reading: "你报告已拿到覆盖加场日的时刻表，原先的班次未知已有回答。",
      key_uncertainty: null,
      decision: "stop",
      question: null,
      intent: "先保留当前材料支持的有限比较。",
      quick_options: [],
      stop_reason: "同一班次条件已经回答，继续问只增加重复。",
    };
    respondWith(stop);
    const input = plannerInput(true);
    expect(await generateExplorationPlan(gateway(), input)).toEqual(stop);
    const sent = sentMessages();
    expect(sent.input).toBe(input);
    expect(sent.input).toContain(update);
    expect(sent.input).toContain(oldUncertainty);
    expect(sent.input).toContain("QUESTIONS_ALREADY_ASKED:\n[]");
    expect(sent.system).toContain("先用全部 EVIDENCE 核对哪些事实已回答");
    expect(sent.system).toContain("新材料已解答的旧未知不得继续追问");
    expect(sent.system).toContain("不把承诺等同于未来必然兑现");
    expect(sent.system).toContain("只有材料出现实际矛盾或仍未说明、且会改变判断的条件时");
    expect(EXPLORATION_PLAN_PROMPT_VERSION).toBe("purposeful-planner-prompt@v6");
  });

  it("preserves an actually unanswered condition without manufacturing an answer or forcing stop", async () => {
    const ask = {
      current_reading: "费用和时长已有信息，活动期间的班次仍未知。",
      key_uncertainty: oldUncertainty,
      decision: "ask",
      question: oldUncertainty,
      intent: "这会改变换乘方案能否满足到达时间。",
      quick_options: ["确认有班次", "仍未确认"],
      stop_reason: null,
    };
    respondWith(ask);
    const input = plannerInput(false);
    expect(await generateExplorationPlan(gateway(), input)).toEqual(ask);
    const sent = sentMessages();
    expect(sent.input).toBe(input);
    expect(sent.input).not.toContain(update);
    expect(sent.system).toContain("比较选项时逐项区分已知与未知");
    expect(sent.system).toContain("未提供的安排、能力、优势与动机不能补成事实");
  });

  it("keeps assistant suggestions separate from user facts and conditions advice on unknown option details", async () => {
    const input = [
      `MATTER: ${initial}`,
      "CONVERSATION (oldest first; earlier turns may be omitted):",
      `[USER/message] ${initial}`,
      "[FINDME/reply] 你很擅长规划行程，直达车也肯定能赶在闭馆前到。",
      `[USER/message] ${update}`,
      "THIS_CONVERSATION_CLAIMS: []",
      "PRIOR_UNDERSTANDING: []",
      "DO_NOT_USE_AS_PREMISE: []",
      "USER_MESSAGE (respond to this):",
      update,
    ].join("\n");
    const reply = {
      reply:
        "换乘方案的班次未知已经有了书面答复。直达方案能否赶在闭馆前到，材料还没说明；如果它也满足，再比较费用与时长。时刻表是承诺，实际运行结果仍待发生。",
      used_claim_keys: [],
      new_information: true,
      new_information_note: "用户报告运营方已提供覆盖加场日的书面时刻表。",
    };
    respondWith(reply);
    expect(await generateConversationReply(gateway(), input)).toEqual(reply);
    const sent = sentMessages();
    expect(sent.input).toBe(input);
    expect(sent.system).toContain("FINDME 发言只是此前的系统回应");
    expect(sent.system).toContain("不因用户未反驳就变成事实或独立证据");
    expect(sent.system).toContain("不能因为没有提到冲突就说没有冲突");
    expect(sent.system).toContain("建议依赖未知条件时明确写“如果”");
    expect(sent.system).toContain("不要编造用户的能力、经历、优势或人格特征");
    expect(sent.system).toContain("不要再次询问已回答的同一承诺");
    expect(CONVERSATION_REPLY_PROMPT_VERSION).toBe("conversation-reply-prompt@v2");
  });
});
