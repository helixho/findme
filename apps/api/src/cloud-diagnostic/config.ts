import { z } from "zod";
import type { AccountConfig } from "../auth/server.js";
import type { ModelSettings } from "../standalone/settings.js";
import type { CloudProcessingOptions } from "./processing.js";

/** Account startup configuration from the environment. */
export function accountOptions(env: Record<string, string | undefined>) {
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
  return auth;
}

/** Processing budgets derived from the stored model settings. */
export function processingOptions(settings: ModelSettings) {
  const enabled = settings.enabled && settings.apiKey.length > 0;
  const processing: CloudProcessingOptions = {
    enabled,
    profileCallLimit: settings.profileCallLimit,
    maxCallsPerJob: settings.jobCallLimit,
    maxOutputTokens: 6000,
    timeoutMs: 90000,
  };
  return {
    processing,
    // Conversation processing is automatic but needs the inference switch plus an explicit
    // rolling-24h operation limit (0 = off).
    coreModel: { dailyOperationLimit: enabled ? settings.coreDailyOperationLimit : 0 },
    frameworkCallLimit: settings.frameworkCallLimit,
  };
}
