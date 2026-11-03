import { type Db, coreSchema } from "@findme/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type AccountSessionProvider, accountSessionAccess } from "./auth/account.js";
import { invalidateCloudSources } from "./cloud-diagnostic/effects.js";
import { CloudDiagnosticRepository } from "./cloud-diagnostic/repository.js";
import type { CloudServices } from "./cloud-diagnostic/runtime.js";
import { withProfileTransaction } from "./cloud-diagnostic/scope.js";
import { resolvePersonalContext } from "./core/identity.js";
import type { NativeReportService } from "./core/report-bridge.js";
import { requireReportBridge } from "./core/report-bridge.js";
import { createCoreReportBackend } from "./core/report-source-service.js";
import { readAccountHealth, readHealth } from "./health.js";
import type { createGateway } from "./llm/gateway.js";
import { bearerAuth } from "./middleware/auth.js";
import { onError } from "./middleware/error.js";
import { sessionAuth } from "./middleware/session-auth.js";
import { accountCoreModelRoutes } from "./routes/account-core-model.js";
import { archiveUnderstandingRoutes } from "./routes/archive-understanding.js";
import { authRoutes } from "./routes/auth.js";
import {
  cloudBlobRoutes,
  cloudDataRoutes,
  cloudFrameworkRoutes,
  cloudProfileRoutes,
} from "./routes/cloud-data.js";
import { cloudDiagnosticRoutes } from "./routes/cloud-diagnostics.js";
import { contentRoutes } from "./routes/content.js";
import { coreRoutes } from "./routes/core.js";
import type { PrincipalResolver } from "./routes/core.js";
import { exportRoutes } from "./routes/export.js";
import { insightsRoutes } from "./routes/insights.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { materialsRoutes } from "./routes/materials.js";
import { questionnairesRoutes } from "./routes/questionnaires.js";
import { recordsRoutes } from "./routes/records.js";
import { reviewRoutes } from "./routes/review.js";
import { specialistRoutes } from "./routes/specialist.js";
import { nativeUnderstandingRoutes } from "./routes/understanding.js";
import type { TaskEnqueuer } from "./tasks/enqueue.js";
import type { ArchiveUnderstandingRuntime } from "./understanding-app/archive-runtime.js";

type LlmGateway = Pick<ReturnType<typeof createGateway>, "extract" | "chat" | "describe">;
export type AuthOpts =
  | { mode: "none" }
  | {
      mode: "session";
      loginPassword: string;
      sessionTtlDays?: number;
      loginRateLimit?: { maxFailures: number; windowSeconds: number };
    }
  | { mode: "static"; accessToken: string }
  | {
      mode: "account";
      sessions: AccountSessionProvider;
      trustedOrigins: string[];
      /** Configured IdP handler only; never a browser-supplied callback. */
      handler?: (request: Request) => Response | Promise<Response>;
    };

async function sha256Hex(value: string) {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createApp(opts: {
  db: Db;
  gateway?: LlmGateway;
  auth?: AuthOpts;
  accessToken?: string;
  enqueueTask?: TaskEnqueuer;
  reportService?: NativeReportService;
  archiveRuntime?: ArchiveUnderstandingRuntime;
  corePrincipal?: PrincipalResolver;
  cloud?: CloudServices;
  /** Account-mode automatic Core processing; absent or 0 keeps those endpoints off. */
  coreModel?: { dailyOperationLimit: number };
}) {
  const app = new Hono();
  app.onError(onError);
  const configuredAuth: AuthOpts =
    opts.auth ??
    (opts.accessToken ? { mode: "static", accessToken: opts.accessToken } : { mode: "none" });
  if (configuredAuth.mode === "account" && opts.corePrincipal)
    throw new Error("ACCOUNT_PRINCIPAL_OVERRIDE_FORBIDDEN");

  // Web 跨域请求携带 Authorization 时会触发 OPTIONS 预检。
  // CORS 必须在鉴权中间件之前:预检的 OPTIONS 不带 token,由 cors 中间件短路放行,
  // 否则 Web 内的鉴权请求在到达路由前被浏览器层挡掉。
  app.use(
    "/api/*",
    cors({
      origin:
        configuredAuth.mode === "account"
          ? configuredAuth.trustedOrigins
          : [
              "http://localhost",
              "http://127.0.0.1:5174",
              "http://localhost:5174",
              "https://app.findme.example.com",
            ],
      credentials: configuredAuth.mode === "account",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-FindMe-Profile"],
    }),
  );

  const health = async (c: Context) => {
    const body = await (configuredAuth.mode === "account"
      ? readAccountHealth(opts.db)
      : readHealth(opts.db));
    const strict = c.req.query("strict") === "1";
    return c.json(body, strict && body.status !== "ok" ? 503 : 200);
  };
  app.get("/health", health);
  app.get("/api/health", health);

  if (configuredAuth.mode === "account" && configuredAuth.handler) {
    const handler = configuredAuth.handler;
    app.all("/api/auth/*", (c) => handler(c.req.raw));
  }

  if (configuredAuth.mode === "session") {
    app.route(
      "/api/auth",
      authRoutes(opts.db, {
        loginPassword: configuredAuth.loginPassword,
        sessionTtlDays: configuredAuth.sessionTtlDays,
        rateLimit: configuredAuth.loginRateLimit,
      }),
    );
  }

  if (configuredAuth.mode === "static") {
    app.post("/api/core/bootstrap", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!code || code.length > 256) return c.json({ error: "invalid_bootstrap_code" }, 400);

      const codeHash = await sha256Hex(code);
      const now = new Date();
      const [used] = await opts.db
        .update(coreSchema.accessBootstrapTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(coreSchema.accessBootstrapTokens.codeHash, codeHash),
            isNull(coreSchema.accessBootstrapTokens.usedAt),
            gt(coreSchema.accessBootstrapTokens.expiresAt, now),
          ),
        )
        .returning({ id: coreSchema.accessBootstrapTokens.id });

      if (!used) return c.json({ error: "bootstrap_expired_or_used" }, 401);
      return c.json({ access_token: configuredAuth.accessToken });
    });
  }

  const api = new Hono();
  const auth = configuredAuth;
  const account =
    auth.mode === "account" ? accountSessionAccess(auth.sessions, auth.trustedOrigins) : undefined;
  if (account) api.use("*", account.middleware);
  if (auth.mode === "static") api.use("*", bearerAuth(auth.accessToken));
  else if (auth.mode === "session") api.use("*", sessionAuth(opts.db));
  // Shared, versioned method content; account mode is protected by the
  // account session middleware above like every other /api route.
  api.route("/content", contentRoutes());
  // Legacy routes are unscoped; never expose them to multi-account sessions.
  if (auth.mode !== "account") {
    api.route("/records", recordsRoutes(opts.db, opts.gateway, opts.enqueueTask)); // M-A3 速记 + 导入 + M-A1 对话
    api.route("/insights", insightsRoutes(opts.db, opts.gateway, opts.enqueueTask)); // M-O5 洞察网格 + 提问
    api.route("/review", reviewRoutes(opts.db)); // M-O2 回顾(主题频率)
    api.route("/questionnaires", questionnairesRoutes(opts.db, opts.enqueueTask)); // M-A2 题库 + 作答
    api.route("/materials", materialsRoutes(opts.db, opts.enqueueTask)); // M-B0 学习素材 + 阅读反馈
    api.route("/export", exportRoutes(opts.db)); // M-S2 数据导出
  }

  const principal: PrincipalResolver =
    account?.principal ??
    opts.corePrincipal ??
    (async () => ({
      provider: "findme-runtime",
      principalId: "owner",
    }));
  const contextFor = async (c: Context) =>
    opts.cloud && account
      ? opts.cloud.profiles.resolve(await principal(c), c.req.header("X-FindMe-Profile"))
      : resolvePersonalContext(opts.db, await principal(c));
  if (account) {
    api.route(
      "/diagnostics",
      cloudDiagnosticRoutes(
        opts.cloud?.repository ?? new CloudDiagnosticRepository(opts.db),
        contextFor,
        opts.cloud?.processing,
      ),
    );
    if (opts.cloud) {
      api.route("/profiles", cloudProfileRoutes(opts.cloud, principal));
      api.route("/data", cloudDataRoutes(opts.cloud, contextFor));
      api.route("/blobs", cloudBlobRoutes(opts.cloud, contextFor));
      api.route("/understanding/frameworks", cloudFrameworkRoutes(opts.cloud, contextFor));
    }
  }
  if (opts.reportService) {
    // A report adapter is explicitly opt-in and requires an authenticated runtime.
    if (auth.mode === "none") throw new Error("REPORT_BRIDGE_AUTH_REQUIRED");
    api.route(
      "/understanding",
      nativeUnderstandingRoutes(requireReportBridge(opts.reportService), contextFor),
    );
  }
  if (opts.archiveRuntime) {
    if ((auth.mode !== "static" && auth.mode !== "account") || opts.reportService)
      throw Error("ARCHIVE_RUNTIME_AUTH_REQUIRED");
    api.route("/understanding", archiveUnderstandingRoutes(opts.archiveRuntime, contextFor));
  }
  if (account && opts.cloud) {
    api.route("/knowledge", knowledgeRoutes(opts.db, contextFor));
    api.route("/specialist", specialistRoutes(opts.db, contextFor));
    const root = new Hono();
    root.all("*", async (c) => {
      const ctx = await contextFor(c);
      // Account Core endpoints are model-free here; paid diagnostics use the durable C3 queue.
      return withProfileTransaction(opts.db, ctx, async (tx) => {
        const scoped = tx as unknown as Db;
        const router = new Hono().route(
          "/api/core",
          coreRoutes(scoped, undefined, principal, opts.reportService, {
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
  } else
    api.route(
      "/core",
      coreRoutes(opts.db, account ? undefined : opts.gateway, principal, opts.reportService),
    );
  app.route("/api", api);

  return app;
}

// I2:仅类型导出,web 用 `import type`,不带运行时副作用
export type AppType = ReturnType<typeof createApp>;
