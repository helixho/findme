import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { createAccountAuth } from "./auth/server.js";
import { accountOptions, processingOptions } from "./cloud-diagnostic/config.js";
import { accountRuntimeRoleQuery } from "./cloud-diagnostic/runtime-role.js";
import { createCloudServices } from "./cloud-diagnostic/runtime.js";
import { parseEnv } from "./env.js";
import { createGateway } from "./llm/gateway.js";
import { fileBlobStore } from "./standalone/files.js";
import { readModelSettings } from "./standalone/settings.js";
import { startLocalWorker } from "./standalone/worker.js";

const env = parseEnv();
const connection = createDb(env.DATABASE_URL_RUNTIME, {
  max: env.DB_POOL_MAX,
  idleTimeout: env.DB_POOL_IDLE_TIMEOUT,
});
const { db } = connection;
const authConfig = accountOptions(process.env);
const authUrl = process.env.DATABASE_URL_AUTH;
const identityUrl = process.env.DATABASE_URL_IDENTITY;
if (!authUrl || !identityUrl) throw new Error("ACCOUNT_DATABASE_ROLES_REQUIRED");
const account = createAccountAuth({ ...authConfig, databaseUrl: authUrl });
const identity = createDb(identityUrl, { max: 2 });
const blobs = fileBlobStore(process.env.FINDME_FILES_ROOT ?? "/data/files");
const staticRoot = process.env.FINDME_STATIC_ROOT ?? "/app/public";

/** Everything that depends on the stored model settings; rebuilt when they change. */
async function build() {
  const settings = await readModelSettings(db);
  const options = processingOptions(settings);
  const gateway = settings.apiKey
    ? createGateway({
        deepseekKey: settings.apiKey,
        mx2BaseUrl: settings.baseUrl,
        deepseekModel: settings.model,
      })
    : undefined;
  const cloud = createCloudServices({
    db,
    identityDb: identity.db,
    gateway,
    processing: options.processing,
    frameworkCallLimit: options.frameworkCallLimit,
    blobs,
    // New jobs wake the local worker; the jobs table itself is the queue.
    send: async () => {
      await worker.wake();
    },
  });
  const worker = startLocalWorker({
    db,
    identityDb: identity.db,
    processing: cloud.processing,
    enabled: options.processing.enabled && !!gateway,
  });
  const app = createApp({
    db,
    cloud,
    gateway,
    coreModel: options.coreModel,
    auth: {
      mode: "account",
      sessions: account.sessions,
      trustedOrigins: authConfig.trustedOrigins,
      handler: (request) => account.auth.handler(request),
    },
  });
  app.get("/ready", async (c) => {
    const [result] = await db.execute<{ allowed: boolean }>(accountRuntimeRoleQuery);
    const ok = result?.allowed && worker.healthy();
    return c.json({ status: ok ? "ok" : "degraded", worker: worker.state() }, ok ? 200 : 503);
  });
  app.get("*", async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return c.notFound();
    if (c.req.path.startsWith("/assets/"))
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    else c.header("Cache-Control", "no-cache");
    return serveStatic({ root: staticRoot })(c, next);
  });
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/assets/")) return c.notFound();
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(`${staticRoot}/index.html`, "utf8"));
  });
  return { app, worker };
}

// Model settings are deployment configuration, read once at start (restart to apply).
const current = await build();

const server = serve({
  fetch: (request) => current.app.fetch(request),
  hostname: env.HOST,
  port: env.PORT,
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 110000);
    timeout.unref();
    server.close();
    await current.worker.stop();
    await Promise.all([connection.sql.end(), identity.sql.end(), account.close()]);
    process.exit(0);
  });
console.log(`api listening on ${env.HOST}:${env.PORT}`);
