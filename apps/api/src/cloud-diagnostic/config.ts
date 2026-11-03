import { z } from "zod";
import type { AccountConfig } from "../auth/server.js";
import type { CloudProcessingOptions } from "./processing.js";
const number = (value: string | undefined, fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? fallback);
export function cloudOptions(env: Record<string, string | undefined>) {
  const origins = (env.ACCOUNT_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const baseUrl = z.string().url().parse(env.ACCOUNT_BASE_URL);
  const secret = z.string().min(32).parse(env.ACCOUNT_SECRET);
  if (!origins.length) throw new Error("ACCOUNT_TRUSTED_ORIGINS_REQUIRED");
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin) throw new Error("ACCOUNT_ORIGIN_INVALID");
  }
  const mail = env.ACCOUNT_MAIL_ENDPOINT;
  if (mail && new URL(mail).protocol !== "https:") throw new Error("ACCOUNT_MAIL_HTTPS_REQUIRED");
  const auth: Omit<AccountConfig, "databaseUrl"> = {
    baseUrl,
    secret,
    trustedOrigins: origins,
    registrationEnabled: env.ACCOUNT_REGISTRATION_ENABLED === "1",
    sendMail: mail
      ? async (message) => {
          const response = await fetch(mail, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(env.ACCOUNT_MAIL_TOKEN
                ? { authorization: `Bearer ${env.ACCOUNT_MAIL_TOKEN}` }
                : {}),
            },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error("ACCOUNT_MAIL_DELIVERY_FAILED");
        }
      : undefined,
  };
  const processing: CloudProcessingOptions = {
    enabled: env.CLOUD_INFERENCE_ENABLED === "1",
    profileCallLimit: number(env.CLOUD_PROFILE_CALL_LIMIT, 0, 100000),
    maxCallsPerJob: number(env.CLOUD_JOB_CALL_LIMIT, 4, 20),
    maxOutputTokens: number(env.CLOUD_MAX_OUTPUT_TOKENS, 6000, 16000),
    timeoutMs: number(env.CLOUD_TIMEOUT_MS, 90000, 120000),
  };
  // Owner decision 2026-10-31: conversation processing is automatic but needs the
  // global inference switch plus an explicit rolling-24h operation limit (default 0 = off).
  const coreDailyOperationLimit =
    env.CLOUD_INFERENCE_ENABLED === "1" ? number(env.CORE_MODEL_DAILY_OPERATION_LIMIT, 0, 1000) : 0;
  return {
    auth,
    processing,
    coreModel: { dailyOperationLimit: coreDailyOperationLimit },
    allowDraftFrameworks: env.CLOUD_ALLOW_DRAFT_FRAMEWORKS === "1",
    frameworkCallLimit: number(env.CLOUD_FRAMEWORK_CALL_LIMIT, 0, 100000),
  };
}
