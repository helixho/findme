import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { onError } from "../src/middleware/error.js";
import {
  defaultModelSettings,
  readModelSettings,
  settingsRoutes,
  writeModelSettings,
} from "../src/standalone/settings.js";

it("stores model settings through the runtime role and never returns the key", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const admin = createDb(process.env.DATABASE_URL_TEST!);
  const runtime = createDb(config.runtime_url);
  try {
    await admin.sql`delete from app_settings`;
    expect(await readModelSettings(runtime.db)).toEqual(defaultModelSettings);

    let reloads = 0;
    const routes = new Hono();
    routes.onError(onError);
    routes.route(
      "/",
      settingsRoutes(runtime.db, async () => {
        reloads++;
      }),
    );
    const put = (body: unknown) =>
      routes.request("/model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const saved = await (await put({ enabled: true, apiKey: "sk-synthetic", model: "m1" })).json();
    expect(saved).toMatchObject({ enabled: true, model: "m1", apiKeyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain("sk-synthetic");
    expect(reloads).toBe(1);

    // An empty key keeps the stored one; other fields update.
    await writeModelSettings(runtime.db, { apiKey: "", coreDailyOperationLimit: 3 });
    expect(await readModelSettings(runtime.db)).toMatchObject({
      apiKey: "sk-synthetic",
      model: "m1",
      coreDailyOperationLimit: 3,
    });
    expect((await put({ jobCallLimit: 99 })).status).toBe(400);
    expect(await (await routes.request("/model")).json()).not.toHaveProperty("apiKey");
  } finally {
    await admin.sql`delete from app_settings`;
    await Promise.all([admin.sql.end(), runtime.sql.end()]);
  }
});
