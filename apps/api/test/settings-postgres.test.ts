import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { expect, it } from "vitest";
import {
  defaultModelSettings,
  readModelSettings,
  writeModelSettings,
} from "../src/standalone/settings.js";

// Model settings are deployment configuration: written by the operator, read by
// the runtime role at start. There is no App or HTTP route that changes them.
it("stores model settings through the runtime role", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const admin = createDb(process.env.DATABASE_URL_TEST!);
  const runtime = createDb(config.runtime_url);
  try {
    await admin.sql`delete from app_settings`;
    expect(await readModelSettings(runtime.db)).toEqual(defaultModelSettings);
    await writeModelSettings(runtime.db, { enabled: true, apiKey: "sk-synthetic", model: "m1" });
    // An empty key keeps the stored one; other fields update.
    await writeModelSettings(runtime.db, { apiKey: "", coreDailyOperationLimit: 3 });
    expect(await readModelSettings(runtime.db)).toMatchObject({
      apiKey: "sk-synthetic",
      model: "m1",
      coreDailyOperationLimit: 3,
    });
    await expect(writeModelSettings(runtime.db, { jobCallLimit: 99 })).rejects.toThrow();
  } finally {
    await admin.sql`delete from app_settings`;
    await Promise.all([admin.sql.end(), runtime.sql.end()]);
  }
});
