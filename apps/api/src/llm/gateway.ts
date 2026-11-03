import OpenAI from "openai";
import type { z } from "zod";
import { type OutputStrategy, resolveModel, resolveStrategy } from "./router.js";

export type GatewayEstimate = {
  method: "serialized_utf8_bytes_conservative" | "codex_prompt_bytes_plus_overhead";
  serializedUtf8Bytes: number;
  estimatedInputTokens: number;
};
export type GatewayUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheInputTokens: number | null;
  cacheOutputTokens: number | null;
};
export type GatewayErrorKind =
  | "timeout"
  | "provider"
  | "quota"
  | "rate_limit"
  | "authentication"
  | "model_not_found"
  | "bad_request"
  | "json_parse"
  | "schema_validation";
export type GatewayExecution = {
  provider: "codex_cli";
  cliVersion: string;
  modelName: string;
  reasoningEffort: string;
  requestUnit: "cli_execution";
  internalRequests: "not_observable";
  outputTokenLimit: "advisory";
};
export type GatewayDescription = {
  route: string;
  model: string;
  provider?: "codex_cli";
  timeoutMs?: number;
};
export type GatewayAttemptInfo = {
  route: string;
  model: string;
  attempt: number;
  estimate: GatewayEstimate;
  execution?: GatewayExecution;
  thinkingMode?: "disabled" | "enabled";
};
export type GatewayAttemptResult = GatewayAttemptInfo & {
  latencyMs: number;
  status: "ok" | "error";
  errorKind: GatewayErrorKind | null;
  usage: GatewayUsage | null;
};
export type GatewayControls = {
  /** Omitted controls preserve the provider's legacy default. */
  thinkingMode?: "disabled" | "enabled";
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Additional attempts after the initial request. */
  retries?: number;
  /** Opt-in private artifact capture before JSON parsing; never a normal application log. */
  captureRawOutput?: (raw: string) => void | Promise<void>;
  observer?: {
    /** Must atomically reserve budget; rejection prevents the provider request. */
    beforeAttempt(info: GatewayAttemptInfo): Promise<void>;
    afterAttempt(info: GatewayAttemptResult): Promise<void>;
  };
};
export type ChatInput = {
  route: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  controls?: GatewayControls;
};
export type CallMeta = { model: string; latencyMs: number; status: string };

/** A conservative byte-based estimate, never a tokenizer measurement. */
export function estimateGatewayRequest(request: unknown): GatewayEstimate {
  const serializedUtf8Bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  return {
    method: "serialized_utf8_bytes_conservative",
    serializedUtf8Bytes,
    estimatedInputTokens: serializedUtf8Bytes,
  };
}

/** No provider response body, credentials, or original error escapes this boundary. */
export class GatewayRequestError extends Error {
  constructor(public readonly kind: GatewayErrorKind) {
    super(`Gateway request failed (${kind})`);
    this.name = "GatewayRequestError";
  }
}

export function classifyGatewayError(error: unknown): GatewayErrorKind {
  return error instanceof GatewayRequestError
    ? error.kind
    : error instanceof OpenAI.APIConnectionTimeoutError
      ? "timeout"
      : error instanceof OpenAI.AuthenticationError
        ? "authentication"
        : error instanceof OpenAI.NotFoundError
          ? "model_not_found"
          : error instanceof OpenAI.RateLimitError
            ? "rate_limit"
            : error instanceof OpenAI.BadRequestError
              ? "bad_request"
              : error instanceof OpenAI.APIError && error.status === 402
                ? "quota"
                : "provider";
}

function validateControls(controls?: GatewayControls) {
  if (!controls) return;
  if (
    controls.thinkingMode !== undefined &&
    !["disabled", "enabled"].includes(controls.thinkingMode)
  )
    throw new Error("Invalid Gateway control: thinkingMode");
  for (const [name, value] of Object.entries({
    maxOutputTokens: controls.maxOutputTokens,
    timeoutMs: controls.timeoutMs,
    retries: controls.retries,
  })) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (name === "retries" ? 0 : 1))
    ) {
      throw new Error(`Invalid Gateway control: ${name}`);
    }
  }
}

function usageOf(raw: unknown): GatewayUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: number(usage.prompt_tokens),
    outputTokens: number(usage.completion_tokens),
    totalTokens: number(usage.total_tokens),
    cacheInputTokens: number(usage.prompt_cache_hit_tokens ?? details?.cached_tokens),
    cacheOutputTokens: number(usage.completion_cache_hit_tokens),
  };
}

// Business modules depend on this gateway only. Endpoint and key remain server-side.
export function createGateway(opts: {
  deepseekKey: string;
  mx2BaseUrl: string;
  deepseekModel: string;
}) {
  const client = new OpenAI({ apiKey: opts.deepseekKey, baseURL: opts.mx2BaseUrl });
  const cfg = { deepseekModel: opts.deepseekModel };

  function describe(route: string): GatewayDescription {
    const m = resolveModel(route, cfg);
    return { route, model: m.model };
  }

  async function request<T>(
    route: string,
    body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    controls: GatewayControls | undefined,
    legacyRetries: number,
    parse: (text: string) => T,
  ): Promise<T> {
    validateControls(controls);
    const retries = controls?.retries ?? legacyRetries;
    const requestBody = {
      ...body,
      ...(controls?.thinkingMode === undefined
        ? {}
        : { thinking: { type: controls.thinkingMode } }),
    };
    const estimate = estimateGatewayRequest(requestBody);
    for (let index = 0; index <= retries; index++) {
      const info: GatewayAttemptInfo = {
        route,
        model: body.model,
        attempt: index + 1,
        estimate,
        ...(controls?.thinkingMode === undefined ? {} : { thinkingMode: controls.thinkingMode }),
      };
      // Reservation is awaited outside the provider-error catch: denied budget is not retried.
      await controls?.observer?.beforeAttempt(info);
      const started = Date.now();
      let usage: GatewayUsage | null = null;
      let result: T | undefined;
      let errorKind: GatewayErrorKind | null = null;
      try {
        const response = await client.chat.completions.create(
          requestBody,
          controls
            ? {
                maxRetries: 0,
                ...(controls.timeoutMs === undefined ? {} : { timeout: controls.timeoutMs }),
              }
            : undefined,
        );
        usage = usageOf(response.usage);
        const rawOutput = response.choices[0]?.message?.content ?? "";
        await controls?.captureRawOutput?.(rawOutput);
        result = parse(rawOutput);
      } catch (error) {
        errorKind = classifyGatewayError(error);
      }
      // A failed ledger write must stop execution, not generate another unaccounted request.
      await controls?.observer?.afterAttempt({
        ...info,
        latencyMs: Date.now() - started,
        usage,
        status: errorKind === null ? "ok" : "error",
        errorKind,
      });
      if (errorKind === null) return result as T;
      if (index === retries) throw new GatewayRequestError(errorKind);
    }
    throw new GatewayRequestError("provider");
  }

  async function chat(input: ChatInput): Promise<{ text: string; meta: CallMeta }> {
    const m = resolveModel(input.route, cfg);
    const started = Date.now();
    const text = await request(
      input.route,
      {
        model: m.model,
        messages: input.messages,
        ...(input.controls?.maxOutputTokens === undefined
          ? {}
          : { max_tokens: input.controls.maxOutputTokens }),
      },
      input.controls,
      0,
      (text) => text,
    );
    return { text, meta: { model: m.model, latencyMs: Date.now() - started, status: "ok" } };
  }

  async function extract<T>(args: {
    route: string;
    text: string;
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    strategy?: OutputStrategy;
    system?: string;
    controls?: GatewayControls;
  }): Promise<T> {
    const m = resolveModel(args.route, cfg);
    const strategy = resolveStrategy(args.strategy);
    if (strategy === "tool_call") {
      throw new Error(
        "structured_output_strategy=tool_call 在 V1 未实现;请用 json_mode 或 text_parse",
      );
    }
    const messages = args.system
      ? [
          { role: "system" as const, content: args.system },
          { role: "user" as const, content: args.text },
        ]
      : [{ role: "user" as const, content: args.text }];
    return request(
      args.route,
      {
        model: m.model,
        messages,
        ...(strategy === "json_mode" ? { response_format: { type: "json_object" as const } } : {}),
        ...(args.controls?.maxOutputTokens === undefined
          ? {}
          : { max_tokens: args.controls.maxOutputTokens }),
      },
      args.controls,
      1,
      (raw) => {
        const cleaned =
          strategy === "text_parse"
            ? raw
                .replace(/^\s*```(?:json)?\s*/i, "")
                .replace(/\s*```\s*$/, "")
                .trim()
            : raw;
        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          throw new GatewayRequestError("json_parse");
        }
        try {
          return args.schema.parse(parsed);
        } catch {
          throw new GatewayRequestError("schema_validation");
        }
      },
    );
  }

  return { chat, extract, describe };
}
