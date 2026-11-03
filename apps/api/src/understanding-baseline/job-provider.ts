import type { z } from "zod";
import { atomic, fail } from "./io.js";
import type { Attempt, JobOptions } from "./jobs.js";
import { PROMPTS } from "./policy.js";
export function providerAttempt<T>(context: {
  options: JobOptions;
  stage: keyof typeof PROMPTS;
  payload: unknown;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  timeout: number;
  expectedRuntimeModel: string;
  attempt: Attempt;
  rawFile: string;
  persist: () => Promise<void>;
}) {
  const {
    options,
    stage,
    payload,
    schema,
    timeout,
    expectedRuntimeModel,
    attempt,
    rawFile,
    persist,
  } = context;
  let active = true;
  let rawCaptured = false;
  let observed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    async request() {
      const gateway = required(options.gateway);
      return Promise.race([
        gateway.extract({
          route: "extraction_model",
          system: PROMPTS[stage],
          text: JSON.stringify(payload),
          schema,
          controls: {
            retries: 0,
            timeoutMs: timeout,
            maxOutputTokens: 5000,
            captureRawOutput: async (raw) => {
              // Late output is retained independently, but cannot overwrite a failed/current job.
              await atomic(active ? rawFile : `${rawFile}.late`, raw, true);
              if (active) rawCaptured = true;
            },
            observer: {
              beforeAttempt: async (providerInfo) => {
                if (!active || observed) fail("ATTEMPT_NO_LONGER_ACTIVE");
                observed = true;
                if (providerInfo.model !== expectedRuntimeModel || providerInfo.attempt !== 1)
                  fail("UNEXPECTED_PROVIDER_RETRY_OR_MODEL");
                attempt.info = providerInfo;
                await persist();
              },
              afterAttempt: async (providerResult) => {
                if (!active) {
                  await atomic(`${rawFile}.late-usage.json`, providerResult);
                  return;
                }
                attempt.info = providerResult;
                attempt.usage = providerResult.usage;
                await persist();
              },
            },
          },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("STAGE_TIMEOUT")), timeout);
        }),
      ]);
    },
    get rawCaptured() {
      return rawCaptured;
    },
    close() {
      active = false;
      if (timer) clearTimeout(timer);
    },
  };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
