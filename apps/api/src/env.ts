import { z } from "zod";

// Startup configuration only. Model provider, key and budgets are app settings stored in the database.
const EnvSchema = z.object({
  DATABASE_URL_RUNTIME: z.string().min(1),
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default("127.0.0.1"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(3),
  DB_POOL_IDLE_TIMEOUT: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
