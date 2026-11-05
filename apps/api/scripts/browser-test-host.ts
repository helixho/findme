/** Test-only HTTP host. No dotenv, production bindings, models, migrations or user services. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb } from "@findme/db";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { ownerSessions } from "../src/auth/owner.js";
import { createAccountAuth, createOwnerLogin } from "../src/auth/server.js";
import { createCloudServices } from "../src/cloud-diagnostic/runtime.js";

const configPath = process.env.FINDME_ACCOUNT_VERIFY_CONFIG;
if (!configPath) throw new Error("DISPOSABLE_DATABASE_CONFIG_REQUIRED");
const cfg = JSON.parse(await readFile(configPath, "utf8"));
if (cfg.database !== "findme_test" || cfg.host !== "127.0.0.1")
  throw new Error("DISPOSABLE_LOOPBACK_DATABASE_REQUIRED");
for (const role of ["runtime", "identity", "auth"]) {
  const url = new URL(cfg[`${role}_url`]);
  if (
    url.hostname !== cfg.host ||
    url.pathname !== "/findme_test" ||
    url.username !== `test_${role}`
  )
    throw new Error("DISPOSABLE_ROLE_URL_MISMATCH");
}
const origin = "http://127.0.0.1:18765";
const runtime = createDb(cfg.runtime_url, { max: 2 });
const identity = createDb(cfg.identity_url, { max: 2 });
const account = createAccountAuth({
  databaseUrl: cfg.auth_url,
  secret: cfg.secret,
  baseUrl: origin,
  trustedOrigins: [origin],
  sendMail: async () => {
    throw new Error("TEST_MAIL_DISABLED");
  },
});
const cloud = createCloudServices({
  db: runtime.db,
  identityDb: identity.db,
  processing: {
    enabled: false,
    profileCallLimit: 0,
    maxCallsPerJob: 0,
    maxOutputTokens: 1000,
    timeoutMs: 1000,
  },
});
// No sign-in, as in production: the single owner account is created first.
const owner = await createOwnerLogin(account.auth, {
  email: "browser@validation.invalid",
  name: "浏览器合成账号",
  password: "Synthetic-Browser-Only-2026!",
});
const app = createApp({
  db: runtime.db,
  cloud,
  auth: { mode: "account", sessions: ownerSessions(owner.id), trustedOrigins: [origin] },
});
const dist = fileURLToPath(new URL("../../app/dist/", import.meta.url));
const host = new Hono();
host.route("/", app);
host.all("/api/*", (c) => c.json({ error: { code: "TEST_API_NOT_FOUND" } }, 404));
host.get("*", serveStatic({ root: dist }));
host.get("*", async (c) => c.html(await readFile(`${dist}index.html`, "utf8")));
let closing = false;
let server: ReturnType<typeof serve> | undefined;
async function close() {
  if (closing) return;
  closing = true;
  const forced = setTimeout(() => process.exit(1), 4000);
  forced.unref();
  server?.close();
  if (server && "closeAllConnections" in server) server.closeAllConnections();
  await Promise.all([runtime.sql.end(), identity.sql.end(), account.close()]);
  clearTimeout(forced);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void close();
  });
try {
  server = serve({ fetch: host.fetch, hostname: "127.0.0.1", port: 18765 });
  server.on("error", async (error) => {
    console.error(error.message);
    process.exitCode = 1;
    await close();
  });
  // A bounded lifetime also cleans pools when the caller disappears unexpectedly.
  setTimeout(() => {
    process.exitCode = 1;
    void close();
  }, 300_000).unref();
} catch (error) {
  await close();
  throw error;
}
