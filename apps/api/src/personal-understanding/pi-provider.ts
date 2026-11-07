import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type PiProviderLimits = {
  maxRequests: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
};
export type PiProviderPayloadRecord = { sequence: number; payload: unknown; reservedUsd: number };

/** Validate the final serialized request, not an approximation of the pi context. */
export function createPiProviderBudget(input: PiProviderLimits) {
  const limits = Object.freeze({ ...input });
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_PI_PROVIDER_LIMIT:${key}`);
  }
  for (const key of ["maxRequests", "maxInputBytes", "maxOutputTokens"] as const)
    if (!Number.isSafeInteger(limits[key])) throw new Error(`INVALID_PI_PROVIDER_LIMIT:${key}`);
  let requests = 0;
  let reservedUsd = 0;
  return {
    reserve(payload: unknown): PiProviderPayloadRecord {
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (bytes > limits.maxInputBytes) throw new Error("PI_INPUT_LIMIT_REACHED");
      if (requests >= limits.maxRequests) throw new Error("PI_REQUEST_LIMIT_REACHED");
      // Include a conservative fixed allowance for provider tokenization framing.
      const cost =
        ((bytes + 4096) * limits.inputPricePerMillion +
          limits.maxOutputTokens * limits.outputPricePerMillion) /
        1_000_000;
      if (reservedUsd + cost > limits.maxCostUsd) throw new Error("PI_COST_LIMIT_REACHED");
      requests++;
      reservedUsd += cost;
      // Failed/cancelled requests keep their reservation; no unverified refunds.
      return { sequence: requests, payload: structuredClone(payload), reservedUsd: cost };
    },
    usage: () => ({ requests, reservedUsd }),
  };
}

/** Preserve visible provider input without archiving provider reasoning carried between tool calls. */
export function visibleProviderPayload(payload: Record<string, unknown>) {
  const copy = structuredClone(payload);
  if (Array.isArray(copy.messages))
    copy.messages = copy.messages.map((message) => {
      if (!message || message.role !== "assistant") return message;
      const {
        reasoning_content: _content,
        reasoning_details: _details,
        reasoning: _reasoning,
        thinking: _thinking,
        ...visible
      } = message;
      return visible;
    });
  return copy;
}

/** Price ceilings are supported only on the actual OpenRouter endpoint. */
export function validatePiOpenRouterEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !["openrouter.ai", "us.openrouter.ai", "eu.openrouter.ai"].includes(url.hostname) ||
    url.pathname.replace(/\/$/, "") !== "/api/v1"
  )
    throw new Error("PI_OPENROUTER_ENDPOINT_REQUIRED");
  return url.toString().replace(/\/$/, "");
}

/** Local runtime with one explicit provider; no catalog/auth files or discovery. */
export async function createFindMePiProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  limits: PiProviderLimits;
  reasoningEffort?: () => "low" | undefined;
  recordPayload: (record: PiProviderPayloadRecord) => unknown | Promise<unknown>;
}) {
  const baseUrl = validatePiOpenRouterEndpoint(options.baseUrl);
  if (!options.apiKey || !options.model) throw new Error("PI_PROVIDER_CONFIGURATION_REQUIRED");
  const limits = Object.freeze({ ...options.limits });
  const budget = createPiProviderBudget(limits);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let failure: unknown;
  runtime.registerProvider("findme-openrouter", {
    baseUrl,
    apiKey: options.apiKey,
    api: "openai-completions",
    models: [
      {
        id: options.model,
        name: options.model,
        reasoning: false,
        input: ["text"],
        contextWindow: limits.maxInputBytes + limits.maxOutputTokens + 4096,
        maxTokens: limits.maxOutputTokens,
        cost: {
          input: limits.inputPricePerMillion,
          output: limits.outputPricePerMillion,
          cacheRead: limits.inputPricePerMillion,
          cacheWrite: limits.inputPricePerMillion,
        },
      },
    ],
    streamSimple: (model, context, controls) =>
      openAICompletionsApi().streamSimple(model, context, {
        ...controls,
        apiKey: options.apiKey,
        maxRetries: 0,
        maxTokens: limits.maxOutputTokens,
        timeoutMs: 110000,
        onPayload: async (raw) => {
          if (failure) throw failure;
          try {
            const payload: Record<string, unknown> = {
              ...(raw as Record<string, unknown>),
              model: options.model,
              max_tokens: limits.maxOutputTokens,
              provider: {
                require_parameters: true,
                max_price: {
                  prompt: limits.inputPricePerMillion,
                  completion: limits.outputPricePerMillion,
                  request: 0,
                },
              },
            };
            const reasoningEffort = options.reasoningEffort?.();
            if (reasoningEffort) payload.reasoning = { effort: reasoningEffort };
            payload.max_completion_tokens = undefined;
            const reservation = budget.reserve(payload);
            await options.recordPayload({
              ...reservation,
              payload: visibleProviderPayload(payload),
            });
            return payload;
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      }),
  });
  const model = runtime.getModel("findme-openrouter", options.model);
  if (!model) throw new Error("PI_PROVIDER_MODEL_MISSING");
  return {
    modelRuntime: runtime,
    model,
    usage: budget.usage,
    assertHealthy: () => {
      if (failure) throw failure;
    },
  };
}
