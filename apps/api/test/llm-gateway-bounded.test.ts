import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type GatewayAttemptResult,
  type GatewayControls,
  createGateway,
  estimateGatewayRequest,
} from "../src/llm/gateway.js";

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
    deepseekKey: "secret",
    mx2BaseUrl: "https://provider.invalid",
    deepseekModel: "test-model",
  });
const response = (content: string, usage?: Record<string, unknown>) => ({
  choices: [{ message: { content } }],
  usage,
});

function observed(extra: Partial<GatewayControls> = {}) {
  const ledger: GatewayAttemptResult[] = [];
  const observer = {
    beforeAttempt: vi.fn(async () => {}),
    afterAttempt: vi.fn(async (entry: GatewayAttemptResult) => {
      ledger.push(entry);
    }),
  };
  return { controls: { retries: 0, ...extra, observer }, observer, ledger };
}

beforeEach(() => {
  mocks.create.mockReset();
});

describe("bounded Gateway requests", () => {
  it.each(["disabled", "enabled"] as const)(
    "serializes opt-in thinking %s before reserving chat/extraction budgets",
    async (thinkingMode) => {
      for (const operation of ["chat", "extract"] as const) {
        const run = observed({ thinkingMode });
        mocks.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: '{"value":"ok"}',
                reasoning_content: "PRIVATE_HIDDEN_REASONING",
              },
            },
          ],
        });
        const result =
          operation === "chat"
            ? await gateway().chat({ route: "default_model", messages: [], controls: run.controls })
            : await gateway().extract({
                route: "extraction_model",
                text: "input",
                schema: z.object({ value: z.string() }),
                controls: run.controls,
              });
        const body = mocks.create.mock.calls.at(-1)?.[0];
        expect(body.thinking).toEqual({ type: thinkingMode });
        expect(run.observer.beforeAttempt.mock.calls[0]?.[0]).toMatchObject({
          thinkingMode,
          estimate: estimateGatewayRequest(body),
        });
        const { thinking: ignored, ...withoutThinking } = body;
        expect(estimateGatewayRequest(body).serializedUtf8Bytes).toBeGreaterThan(
          estimateGatewayRequest(withoutThinking).serializedUtf8Bytes,
        );
        expect(run.ledger[0]).toMatchObject({ thinkingMode, usage: null });
        expect(JSON.stringify({ result, ledger: run.ledger })).not.toContain(
          "PRIVATE_HIDDEN_REASONING",
        );
      }
    },
  );
  it("reserves the full serialized UTF-8 request before sending and disables hidden retries", async () => {
    const run = observed({ maxOutputTokens: 2500, timeoutMs: 1234 });
    let reserved = false;
    run.observer.beforeAttempt.mockImplementation(async () => {
      reserved = true;
    });
    mocks.create.mockImplementation(async () => {
      expect(reserved).toBe(true);
      return response('{"value":"ok"}', {
        prompt_tokens: 31,
        completion_tokens: 9,
        total_tokens: 40,
        prompt_cache_hit_tokens: 12,
      });
    });
    const result = await gateway().extract({
      route: "extraction_model",
      text: "用户正文",
      system: "系统 prompt",
      schema: z.object({ value: z.string() }),
      strategy: "json_mode",
      controls: run.controls,
    });
    expect(result).toEqual({ value: "ok" });
    const body = mocks.create.mock.calls[0][0];
    expect(mocks.create.mock.calls[0][1]).toEqual({ maxRetries: 0, timeout: 1234 });
    expect(body.max_tokens).toBe(2500);
    expect(run.observer.beforeAttempt.mock.calls[0][0].estimate).toEqual(
      estimateGatewayRequest(body),
    );
    expect(run.ledger[0].usage).toEqual({
      inputTokens: 31,
      outputTokens: 9,
      totalTokens: 40,
      cacheInputTokens: 12,
      cacheOutputTokens: null,
    });
    expect(run.ledger[0].status).toBe("ok");
  });

  it("does not call a provider when the atomic budget reservation is denied", async () => {
    const run = observed({ retries: 2 });
    run.observer.beforeAttempt.mockRejectedValue(new Error("budget exhausted"));
    await expect(
      gateway().chat({
        route: "default_model",
        messages: [{ role: "user", content: "input" }],
        controls: run.controls,
      }),
    ).rejects.toThrow("budget exhausted");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(run.observer.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(run.ledger).toEqual([]);
  });

  it("records each provider failure with unknown usage, bounds retries, and sanitizes errors", async () => {
    const run = observed({ retries: 1 });
    mocks.create.mockRejectedValue(new Error("provider body secret input"));
    await expect(
      gateway().chat({ route: "default_model", messages: [], controls: run.controls }),
    ).rejects.toThrow("Gateway request failed (provider)");
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(run.observer.beforeAttempt).toHaveBeenCalledTimes(2);
    expect(run.ledger.map((entry) => [entry.attempt, entry.errorKind, entry.usage])).toEqual([
      [1, "provider", null],
      [2, "provider", null],
    ]);
    expect(JSON.stringify(run.ledger)).not.toContain("secret");
    expect(run.ledger.every((entry) => entry.latencyMs >= 0)).toBe(true);
  });

  it("retains provider usage on JSON/schema failures and reserves a fresh retry", async () => {
    const run = observed({ retries: 2 });
    mocks.create
      .mockResolvedValueOnce(response("not JSON", { prompt_tokens: 10, completion_tokens: 2 }))
      .mockResolvedValueOnce(response('{"value":3}', { prompt_tokens: 11, completion_tokens: 4 }))
      .mockResolvedValueOnce(response('{"value":"ok"}'));
    await expect(
      gateway().extract({
        route: "extraction_model",
        text: "input",
        schema: z.object({ value: z.string() }),
        controls: run.controls,
      }),
    ).resolves.toEqual({ value: "ok" });
    expect(run.ledger.map((entry) => entry.errorKind)).toEqual([
      "json_parse",
      "schema_validation",
      null,
    ]);
    expect(run.ledger[0].usage?.inputTokens).toBe(10);
    expect(run.ledger[1].usage?.cacheInputTokens).toBeNull();
    expect(run.ledger[2].usage).toBeNull();
    expect(run.observer.beforeAttempt).toHaveBeenCalledTimes(3);
  });

  it("records a timeout and stops a retry when the next reservation exceeds budget", async () => {
    const run = observed({ retries: 2, timeoutMs: 100 });
    mocks.create.mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    run.observer.beforeAttempt
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("budget exhausted"));
    await expect(
      gateway().chat({ route: "default_model", messages: [], controls: run.controls }),
    ).rejects.toThrow("budget exhausted");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(run.ledger).toHaveLength(1);
    expect(run.ledger[0]).toMatchObject({ errorKind: "timeout", status: "error", usage: null });
  });

  it("stops on ledger failure without retrying a request whose result could not be persisted", async () => {
    const run = observed({ retries: 2 });
    mocks.create.mockRejectedValue(new Error("provider failed"));
    run.observer.afterAttempt.mockRejectedValue(new Error("ledger failed"));
    await expect(
      gateway().chat({ route: "default_model", messages: [], controls: run.controls }),
    ).rejects.toThrow("ledger failed");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("rejects unbounded/invalid controls before reserving or requesting", async () => {
    for (const retries of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0.5]) {
      const run = observed({ retries });
      await expect(
        gateway().chat({ route: "default_model", messages: [], controls: run.controls }),
      ).rejects.toThrow("Invalid Gateway control: retries");
      expect(run.observer.beforeAttempt).not.toHaveBeenCalled();
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps legacy chat and fenced extraction behavior", async () => {
    mocks.create.mockResolvedValueOnce(response("hello"));
    await expect(gateway().chat({ route: "default_model", messages: [] })).resolves.toMatchObject({
      text: "hello",
      meta: { status: "ok" },
    });
    mocks.create
      .mockResolvedValueOnce(response("bad"))
      .mockResolvedValueOnce(response('```json\n{"value":"ok"}\n```'));
    await expect(
      gateway().extract({
        route: "extraction_model",
        text: "input",
        schema: z.object({ value: z.string() }),
      }),
    ).resolves.toEqual({ value: "ok" });
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.create.mock.calls.every(([body]) => !Object.hasOwn(body, "thinking"))).toBe(true);
  });
});
