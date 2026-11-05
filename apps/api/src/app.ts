import type { Db } from "@findme/db";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type AccountSessionProvider, accountSessionAccess } from "./auth/account.js";
import { invalidateCloudSources } from "./cloud-diagnostic/effects.js";
import type { CloudServices } from "./cloud-diagnostic/runtime.js";
import { withProfileTransaction } from "./cloud-diagnostic/scope.js";
import { createCoreReportBackend } from "./core/report-source-service.js";
import { readAccountHealth } from "./health.js";
import type { createGateway } from "./llm/gateway.js";
import { onError } from "./middleware/error.js";
import { accountCoreModelRoutes } from "./routes/account-core-model.js";
import {
  cloudBlobRoutes,
  cloudDataRoutes,
  cloudFrameworkRoutes,
  cloudProfileRoutes,
} from "./routes/cloud-data.js";
import { cloudDiagnosticRoutes } from "./routes/cloud-diagnostics.js";
import { contentRoutes } from "./routes/content.js";
import { coreRoutes } from "./routes/core.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { specialistRoutes } from "./routes/specialist.js";

type LlmGateway = Pick<ReturnType<typeof createGateway>, "extract" | "chat" | "describe">;
export type AuthOpts = {
  mode: "account";
  sessions: AccountSessionProvider;
  trustedOrigins: string[];
  /** Configured IdP handler only; never a browser-supplied callback. */
  handler?: (request: Request) => Response | Promise<Response>;
};

export function createApp(opts: {
  db: Db;
  cloud: CloudServices;
  auth: AuthOpts;
  gateway?: LlmGateway;
  /** Automatic Core processing; absent or 0 keeps those endpoints off. */
  coreModel?: { dailyOperationLimit: number };
  /** Called after the model settings change so the runtime can reload them. */
}) {
  const app = new Hono();
  app.onError(onError);
  const auth = opts.auth;

  app.use(
    "/api/*",
    cors({
      origin: auth.trustedOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-FindMe-Profile"],
    }),
  );

  const health = async (c: Context) => {
    const body = await readAccountHealth(opts.db);
    const strict = c.req.query("strict") === "1";
    return c.json(body, strict && body.status !== "ok" ? 503 : 200);
  };
  app.get("/health", health);
  app.get("/api/health", health);

  if (auth.handler) {
    const handler = auth.handler;
    app.all("/api/auth/*", (c) => handler(c.req.raw));
  }

  const api = new Hono();
  const account = accountSessionAccess(auth.sessions, auth.trustedOrigins);
  api.use("*", account.middleware);
  // Shared, versioned method content; protected by the account session middleware above.
  api.route("/content", contentRoutes());

  const cloud = opts.cloud;
  const principal = account.principal;
  const contextFor = async (c: Context) =>
    cloud.profiles.resolve(await principal(c), c.req.header("X-FindMe-Profile"));
  api.route("/diagnostics", cloudDiagnosticRoutes(cloud.repository, contextFor, cloud.processing));
  api.route("/profiles", cloudProfileRoutes(cloud, principal));
  api.route("/data", cloudDataRoutes(cloud, contextFor));
  api.route("/blobs", cloudBlobRoutes(cloud, contextFor));
  api.route("/understanding/frameworks", cloudFrameworkRoutes(cloud, contextFor));
  api.route("/knowledge", knowledgeRoutes(opts.db, contextFor));
  api.route("/specialist", specialistRoutes(opts.db, contextFor));

  const root = new Hono();
  root.all("*", async (c) => {
    const ctx = await contextFor(c);
    // Core endpoints are model-free here; paid diagnostics use the durable processing queue.
    return withProfileTransaction(opts.db, ctx, async (tx) => {
      const scoped = tx as unknown as Db;
      const router = new Hono().route(
        "/api/core",
        coreRoutes(scoped, undefined, principal, undefined, {
          contextFor: async () => ctx,
          backend: createCoreReportBackend(scoped),
        }),
      );
      const response = await router.fetch(c.req.raw);
      if (response.ok && c.req.method === "POST") {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as {
          source_id?: string;
          amendment?: { target_source_id?: string };
        } | null;
        const source = body?.source_id ?? body?.amendment?.target_source_id;
        if (source) await invalidateCloudSources(tx, ctx, [source]);
      }
      return response;
    });
  });
  // Registered first so its model-backed routes win; everything else falls through.
  api.route(
    "/core",
    accountCoreModelRoutes({
      db: opts.db,
      gateway: opts.coreModel ? opts.gateway : undefined,
      contextFor,
      dailyOperationLimit: opts.coreModel?.dailyOperationLimit ?? 0,
    }),
  );
  api.route("/core", root);
  app.route("/api", api);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
