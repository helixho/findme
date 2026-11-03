import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { createAccountAuth } from "./auth/server.js";
import { cloudOptions } from "./cloud-diagnostic/config.js";
import { accountRuntimeRoleQuery } from "./cloud-diagnostic/runtime-role.js";
import { createCloudServices } from "./cloud-diagnostic/runtime.js";
import { parseEnv } from "./env.js";
import { createGateway } from "./llm/gateway.js";
import { fileBlobStore } from "./standalone/files.js";
import { startLocalWorker } from "./standalone/worker.js";
const standalone = process.env.FINDME_LOCAL_RUNTIME === "1";
let worker: ReturnType<typeof startLocalWorker> | undefined;
const close: (() => Promise<unknown>)[] = [];
const env = parseEnv();
const connection = createDb(env.DATABASE_URL_RUNTIME, {
  max: env.DB_POOL_MAX,
  idleTimeout: env.DB_POOL_IDLE_TIMEOUT,
});
const { db } = connection;
close.push(() => connection.sql.end());
const gateway = env.DEEPSEEK_API_KEY
  ? createGateway({
      deepseekKey: env.DEEPSEEK_API_KEY,
      mx2BaseUrl: env.M_X2_BASE_URL ?? env.DEEPSEEK_BASE_URL,
      deepseekModel: env.DEEPSEEK_MODEL,
    })
  : undefined;
let app: ReturnType<typeof createApp>;
if (env.APP_AUTH_MODE === "account") {
  const config = cloudOptions(process.env);
  const authUrl = process.env.DATABASE_URL_AUTH;
  const identityUrl = process.env.DATABASE_URL_IDENTITY;
  if (!authUrl || !identityUrl) throw new Error("ACCOUNT_DATABASE_ROLES_REQUIRED");
  const account = createAccountAuth({ ...config.auth, databaseUrl: authUrl });
  const identity = createDb(identityUrl, { max: 2 });
  const identityDb = identity.db;
  close.push(
    () => identity.sql.end(),
    () => account.close(),
  );
  // Node can serve read/save; durable processing requires an explicitly configured queue dispatcher.
  const queueEndpoint = process.env.CLOUD_QUEUE_DISPATCH_ENDPOINT;
  const queueToken = process.env.CLOUD_QUEUE_DISPATCH_TOKEN;
  const cloud = createCloudServices({
    db,
    identityDb,
    gateway,
    ...config,
    blobs: standalone ? fileBlobStore(process.env.FINDME_FILES_ROOT ?? "/data/files") : undefined,
    send: standalone
      ? async () => {
          await worker?.wake();
        }
      : queueEndpoint && queueToken
        ? async (message) => {
            const url = new URL(queueEndpoint);
            if (url.protocol !== "https:") throw new Error("QUEUE_DISPATCH_HTTPS_REQUIRED");
            const response = await fetch(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${queueToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(message),
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error("QUEUE_DISPATCH_FAILED");
          }
        : undefined,
  });
  if (standalone)
    worker = startLocalWorker({
      db,
      identityDb,
      processing: cloud.processing,
      enabled: config.processing.enabled && !!gateway,
    });
  app = createApp({
    db,
    cloud,
    gateway,
    coreModel: config.coreModel,
    auth: {
      mode: "account",
      sessions: account.sessions,
      trustedOrigins: config.auth.trustedOrigins,
      handler: (request) => account.auth.handler(request),
    },
  });
} else
  app = createApp({
    db,
    gateway,
    auth:
      env.APP_AUTH_MODE === "session"
        ? {
            mode: "session",
            loginPassword: env.APP_LOGIN_PASSWORD ?? "",
            sessionTtlDays: env.SESSION_TTL_DAYS,
            loginRateLimit: {
              maxFailures: env.LOGIN_RATE_LIMIT_MAX_FAILURES,
              windowSeconds: env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
            },
          }
        : env.APP_AUTH_MODE === "static"
          ? { mode: "static", accessToken: env.APP_ACCESS_TOKEN ?? "" }
          : { mode: "none" },
  });
if (standalone) {
  if (env.APP_AUTH_MODE !== "account") throw new Error("LOCAL_RUNTIME_REQUIRES_ACCOUNT_MODE");
  app.get("/ready", async (c) => {
    const [result] = await db.execute<{ allowed: boolean }>(accountRuntimeRoleQuery);
    const ok = result?.allowed && worker?.healthy();
    return c.json({ status: ok ? "ok" : "degraded", worker: worker?.state() }, ok ? 200 : 503);
  });
  const root = process.env.FINDME_STATIC_ROOT ?? "/app/public";
  app.get("*", async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return c.notFound();
    if (c.req.path.startsWith("/assets/"))
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    else c.header("Cache-Control", "no-cache");
    return serveStatic({ root })(c, next);
  });
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/assets/")) return c.notFound();
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(`${root}/index.html`, "utf8"));
  });
}
const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 110000);
    timeout.unref();
    server.close();
    await worker?.stop();
    await Promise.all(close.map((fn) => fn()));
    process.exit(0);
  });
console.log(`api listening on ${env.HOST}:${env.PORT}`);
