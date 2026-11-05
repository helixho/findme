import { type Db, schema } from "@findme/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

/** Model provider and budgets, edited in the App and stored as plain app settings in the database. */
const ModelSettings = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  profileCallLimit: z.number().int().min(0).max(100000),
  jobCallLimit: z.number().int().min(1).max(20),
  coreDailyOperationLimit: z.number().int().min(0).max(1000),
  frameworkCallLimit: z.number().int().min(0).max(100000),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

export const defaultModelSettings: ModelSettings = {
  enabled: false,
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-v4-flash",
  profileCallLimit: 0,
  jobCallLimit: 4,
  coreDailyOperationLimit: 0,
  frameworkCallLimit: 0,
};

const KEY = "model";

export async function readModelSettings(db: Db): Promise<ModelSettings> {
  const [row] = await db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEY));
  return ModelSettings.parse({ ...defaultModelSettings, ...(row?.value as object | undefined) });
}

/** An omitted or empty apiKey keeps the stored key. */
export async function writeModelSettings(db: Db, input: unknown): Promise<ModelSettings> {
  const patch = ModelSettings.partial().parse(input);
  const current = await readModelSettings(db);
  const next = ModelSettings.parse({
    ...current,
    ...patch,
    apiKey: patch.apiKey || current.apiKey,
  });
  await db
    .insert(schema.appSettings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: next, updatedAt: sql`now()` },
    });
  return next;
}
