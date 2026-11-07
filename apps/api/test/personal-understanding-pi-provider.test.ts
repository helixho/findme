import { expect, it, vi } from "vitest";
import {
  createFindMePiProvider,
  createPiProviderBudget,
  validatePiOpenRouterEndpoint,
} from "../src/personal-understanding/pi-provider.js";

const limits = {
  maxRequests: 2,
  maxInputBytes: 10000,
  maxOutputTokens: 100,
  maxCostUsd: 1,
  inputPricePerMillion: 1,
  outputPricePerMillion: 2,
};

it("retains failed-request reservations and refuses further calls before the dispatch boundary", () => {
  const budget = createPiProviderBudget(limits);
  budget.reserve({ messages: ["中文"] });
  budget.reserve({ messages: ["second"] });
  expect(budget.usage().requests).toBe(2);
  expect(budget.usage().reservedUsd).toBeGreaterThan(0);
  expect(() => budget.reserve({})).toThrow("PI_REQUEST_LIMIT_REACHED");
  expect(budget.usage().requests).toBe(2);
});

it("checks amount and serialized bytes without consuming a denied reservation", () => {
  const money = createPiProviderBudget({ ...limits, maxCostUsd: 0.000001 });
  expect(() => money.reserve({})).toThrow("PI_COST_LIMIT_REACHED");
  expect(money.usage().requests).toBe(0);
  const size = createPiProviderBudget({ ...limits, maxInputBytes: 10 });
  expect(() => size.reserve({ text: "中文中文" })).toThrow("PI_INPUT_LIMIT_REACHED");
  expect(size.usage().reservedUsd).toBe(0);
});

it("refuses endpoints that cannot enforce the quoted OpenRouter price ceiling", () => {
  expect(validatePiOpenRouterEndpoint("https://openrouter.ai/api/v1/")).toBe(
    "https://openrouter.ai/api/v1",
  );
  expect(validatePiOpenRouterEndpoint("https://eu.openrouter.ai/api/v1")).toContain(
    "eu.openrouter.ai",
  );
  for (const url of [
    "http://openrouter.ai/api/v1",
    "https://other.example/api/v1",
    "https://openrouter.ai/api/v1?key=x",
    "https://user:secret@openrouter.ai/api/v1",
  ])
    expect(() => validatePiOpenRouterEndpoint(url)).toThrow("PI_OPENROUTER_ENDPOINT_REQUIRED");
});

it("creates an explicit in-memory runtime without contacting a model or discovering credentials", async () => {
  const fetch = vi.fn(() => {
    throw new Error("network forbidden");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const provider = await createFindMePiProvider({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "synthetic-key",
      model: "synthetic/model",
      limits,
      recordPayload: () => {},
    });
    expect(provider.model.id).toBe("synthetic/model");
    expect(provider.model.provider).toBe("findme-openrouter");
    expect(provider.usage().requests).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("sends a bounded tool-capable OpenRouter payload through the real adapter using synthetic HTTP", async () => {
  let sent: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    sent = JSON.parse(String(init?.body));
    const chunks = [
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "synthetic/model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "search_sources", arguments: '{"query":"activity"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "synthetic/model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];
    return new Response(
      `${chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const records: unknown[] = [];
  let reviewing = false;
  const provider = await createFindMePiProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "synthetic-secret",
    model: "synthetic/model",
    limits,
    reasoningEffort: () => (reviewing ? "low" : undefined),
    outputTokenLimit: () => (reviewing ? 50 : limits.maxOutputTokens),
    recordPayload: async (record) => {
      records.push(record);
    },
  });
  const result = await provider.modelRuntime.completeSimple(
    provider.model,
    {
      messages: [{ role: "user", content: "查一下", timestamp: Date.now() }],
      tools: [
        {
          name: "search_sources",
          description: "Synthetic source search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    },
    { fetch },
  );
  provider.assertHealthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sent?.max_tokens).toBe(limits.maxOutputTokens);
  expect(sent?.provider).toEqual({
    require_parameters: true,
    max_price: { prompt: 1, completion: 2, request: 0 },
  });
  expect(result.stopReason).toBe("toolUse");
  expect(result.content.some((part) => part.type === "toolCall")).toBe(true);
  expect(JSON.stringify(records)).not.toContain("synthetic-secret");
  expect(provider.usage().requests).toBe(1);
  expect(sent).not.toHaveProperty("reasoning");
  reviewing = true;
  await provider.modelRuntime.completeSimple(
    provider.model,
    { messages: [{ role: "user", content: "复核草稿", timestamp: Date.now() }] },
    { fetch },
  );
  provider.assertHealthy();
  expect(sent?.reasoning).toEqual({ effort: "low" });
  expect(sent?.max_tokens).toBe(50);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(provider.usage().requests).toBe(2);
  expect(records).toHaveLength(2);
});

it("does not archive provider reasoning in assistant messages", async () => {
  const { visibleProviderPayload } = await import("../src/personal-understanding/pi-provider.js");
  const payload = {
    messages: [
      {
        role: "assistant",
        content: "visible",
        reasoning_content: "hidden",
        reasoning_details: ["hidden"],
      },
      { role: "user", content: "original" },
    ],
  };
  expect(visibleProviderPayload(payload)).toEqual({
    messages: [
      { role: "assistant", content: "visible" },
      { role: "user", content: "original" },
    ],
  });
  expect(payload.messages[0]?.reasoning_content).toBe("hidden");
});
