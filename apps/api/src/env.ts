import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_RUNTIME: z.string().min(1).optional(),
  APP_AUTH_MODE: z.enum(["none", "session", "static", "account"]).default("none"),
  APP_ACCESS_TOKEN: z.string().min(1).optional(),
  APP_LOGIN_PASSWORD: z.string().optional(),
  LLM_DEFAULT_PROVIDER: z.string().default("deepseek"),
  DEEPSEEK_API_KEY: z.string().default(""),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com"),
  M_X2_BASE_URL: z.string().url().optional(),
  DEEPSEEK_MODEL: z.string().min(1), // B3:必填,不固化默认型号;实施时按 DeepSeek 官方 docs 填本地 .env
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default("127.0.0.1"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(3),
  DB_POOL_IDLE_TIMEOUT: z.coerce.number().int().positive().default(30),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  LOGIN_RATE_LIMIT_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof EnvSchema> & { DATABASE_URL_RUNTIME: string };

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = EnvSchema.parse(source);
  if (!env.DATABASE_URL_RUNTIME && !env.DATABASE_URL) {
    throw new Error("DATABASE_URL_RUNTIME or DATABASE_URL is required");
  }
  if (env.APP_AUTH_MODE === "session" && !env.APP_LOGIN_PASSWORD) {
    throw new Error("APP_LOGIN_PASSWORD is required");
  }
  if (env.APP_AUTH_MODE === "static" && !env.APP_ACCESS_TOKEN) {
    throw new Error("APP_ACCESS_TOKEN is required");
  }
  return { ...env, DATABASE_URL_RUNTIME: env.DATABASE_URL_RUNTIME ?? env.DATABASE_URL ?? "" };
}
