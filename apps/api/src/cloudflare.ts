import type { ExportedHandler, Hyperdrive, Queue, R2Bucket } from "@cloudflare/workers-types";
import { type Db, createDb } from "@findme/db";
import { z } from "zod";
import { createApp } from "./app.js";
import { createAccountAuth } from "./auth/server.js";
import { r2BlobStore } from "./cloud-diagnostic/blobs.js";
import { cloudOptions } from "./cloud-diagnostic/config.js";
import type { CloudQueueMessage } from "./cloud-diagnostic/processing.js";
import { type CloudServices, createCloudServices } from "./cloud-diagnostic/runtime.js";
import { NeonArchiveReader } from "./hosted/neon-archive-reader.js";
import { generateDeepDive } from "./llm/deepdive.js";
import { runLightExtract } from "./llm/extract.js";
import { createGateway } from "./llm/gateway.js";
import { generateProfileSnapshot } from "./llm/profile.js";
import { dispatchDueTasks } from "./tasks/dispatch.js";
import type { ProcessDeps } from "./tasks/process.js";
import { type QueueTaskMessage, consumeTaskMessage } from "./tasks/queue.js";
import { ArchiveUnderstandingRuntime } from "./understanding-app/archive-runtime.js";

export type FindMeWorkerEnv = {
  HYPERDRIVE: Hyperdrive;
  FINDME_TASKS: Queue<QueueTaskMessage | CloudQueueMessage>;
  FINDME_ACCESS_TOKEN: string;
  FINDME_ACCOUNT_MODE?: string;
  /** Scheduled dispatch is opt-in; only the exact string "1" enables it. */
  FINDME_SCHEDULED_ENABLED?: string;
  FINDME_AV_RUNTIME_HASH?: string;
  FINDME_AV_SOURCE_HASH?: string;
  /** Keep the read-only archive route during account migration; set to 0 after reconciliation. */
  FINDME_AV_READ_ONLY_ENABLED?: string;
  HYPERDRIVE_AUTH?: Hyperdrive;
  HYPERDRIVE_IDENTITY?: Hyperdrive;
  FINDME_BLOBS?: R2Bucket;
  ACCOUNT_BASE_URL?: string;
  ACCOUNT_SECRET?: string;
  ACCOUNT_TRUSTED_ORIGINS?: string;
  ACCOUNT_REGISTRATION_ENABLED?: string;
  ACCOUNT_MAIL_ENDPOINT?: string;
  ACCOUNT_MAIL_TOKEN?: string;
  CLOUD_INFERENCE_ENABLED?: string;
  CLOUD_PROFILE_CALL_LIMIT?: string;
  CLOUD_JOB_CALL_LIMIT?: string;
  CLOUD_MAX_OUTPUT_TOKENS?: string;
  CLOUD_TIMEOUT_MS?: string;
  CLOUD_ALLOW_DRAFT_FRAMEWORKS?: string;
  CLOUD_FRAMEWORK_CALL_LIMIT?: string;
  CLOUD_QUEUE_DISPATCH_TOKEN?: string;
  /** Rolling 24h automatic Core operation limit; requires CLOUD_INFERENCE_ENABLED=1. */
  CORE_MODEL_DAILY_OPERATION_LIMIT?: string;

  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL?: string;
  M_X2_BASE_URL?: string;
  DEEPSEEK_MODEL: string;
};

type Gateway = ReturnType<typeof createGateway>;
type Runtime = {
  db: Db;
  gateway?: Gateway;
  app: ReturnType<typeof createApp>;
  cloud?: CloudServices;
  close?: () => Promise<void>;
};
type WorkerFetch = NonNullable<
  ExportedHandler<FindMeWorkerEnv, QueueTaskMessage | CloudQueueMessage>["fetch"]
>;
type WorkerResponse = Awaited<ReturnType<WorkerFetch>>;

const PUBLIC_HOST = "findme.example.com";

function createRuntime(env: FindMeWorkerEnv): Runtime {
  const connection = createDb(env.HYPERDRIVE.connectionString, {
    max: 3,
    idleTimeout: 30,
    prepare: false,
  });
  const { db } = connection;
  const gateway = env.DEEPSEEK_API_KEY
    ? createGateway({
        deepseekKey: env.DEEPSEEK_API_KEY,
        mx2BaseUrl: env.M_X2_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        deepseekModel: env.DEEPSEEK_MODEL,
      })
    : undefined;
  if (env.FINDME_ACCOUNT_MODE === "1") {
    if (!env.HYPERDRIVE_AUTH || !env.HYPERDRIVE_IDENTITY)
      throw new Error("ACCOUNT_DATABASE_BINDINGS_REQUIRED");
    const config = cloudOptions(env as unknown as Record<string, string | undefined>);
    const account = createAccountAuth({
      ...config.auth,
      databaseUrl: env.HYPERDRIVE_AUTH.connectionString,
    });
    const identity = createDb(env.HYPERDRIVE_IDENTITY.connectionString, { max: 2, prepare: false });
    const u2Archive =
      env.FINDME_AV_RUNTIME_HASH && env.FINDME_AV_SOURCE_HASH
        ? new ArchiveUnderstandingRuntime(
            new NeonArchiveReader(db, "av-understanding-runtime", env.FINDME_AV_RUNTIME_HASH, true),
            env.FINDME_AV_SOURCE_HASH,
            new NeonArchiveReader(db, "av-full-20261003", env.FINDME_AV_SOURCE_HASH, true),
          )
        : undefined;
    const cloud = createCloudServices({
      db,
      identityDb: identity.db,
      gateway,
      ...config,
      blobs: env.FINDME_BLOBS ? r2BlobStore(env.FINDME_BLOBS) : undefined,
      u2Archive,
      send: async (message) => {
        await env.FINDME_TASKS.send(message);
      },
    });
    return {
      db,
      gateway,
      cloud,
      app: createApp({
        db,
        cloud,
        gateway,
        coreModel: config.coreModel,
        archiveRuntime: env.FINDME_AV_READ_ONLY_ENABLED === "0" ? undefined : u2Archive,
        auth: {
          mode: "account",
          sessions: account.sessions,
          trustedOrigins: config.auth.trustedOrigins,
          handler: (request) => account.auth.handler(request),
        },
      }),
      close: async () => {
        await Promise.all([connection.sql.end(), identity.sql.end(), account.close()]);
      },
    };
  }
  return {
    db,
    gateway,
    app: createApp({
      db,
      gateway,
      auth: { mode: "static", accessToken: env.FINDME_ACCESS_TOKEN },
      archiveRuntime: env.FINDME_AV_RUNTIME_HASH
        ? new ArchiveUnderstandingRuntime(
            new NeonArchiveReader(db, "av-understanding-runtime", env.FINDME_AV_RUNTIME_HASH),
            env.FINDME_AV_SOURCE_HASH ?? "",
          )
        : undefined,
      enqueueTask: async (taskId) => {
        await env.FINDME_TASKS.send({ task_id: taskId });
      },
    }),
  };
}

function isAllowedHost(hostname: string, env: FindMeWorkerEnv) {
  if (
    env.FINDME_ACCOUNT_MODE === "1" &&
    env.ACCOUNT_BASE_URL &&
    hostname === new URL(env.ACCOUNT_BASE_URL).hostname
  )
    return true;
  return hostname === PUBLIC_HOST || hostname === "localhost" || hostname === "127.0.0.1";
}

function buildProcessDeps(runtime: Runtime, env: FindMeWorkerEnv): ProcessDeps {
  const gateway = runtime.gateway;
  if (!gateway) throw new Error("GATEWAY_UNAVAILABLE");
  return {
    lightExtract: (text) => runLightExtract(gateway, text),
    modelName: env.DEEPSEEK_MODEL,
    profileSnapshot: (taskId) => generateProfileSnapshot(runtime.db, gateway, taskId),
    deepDive: (taskId) => generateDeepDive(runtime.db, gateway, taskId),
  };
}

const worker: ExportedHandler<FindMeWorkerEnv, QueueTaskMessage | CloudQueueMessage> = {
  async fetch(request, env, ctx): Promise<WorkerResponse> {
    const url = new URL(request.url);
    if (!isAllowedHost(url.hostname, env)) {
      return new Response("Not Found", { status: 404 }) as unknown as WorkerResponse;
    }

    if (url.pathname === "/internal/cloud-diagnostics/enqueue") {
      if (
        env.FINDME_ACCOUNT_MODE !== "1" ||
        !env.CLOUD_QUEUE_DISPATCH_TOKEN ||
        request.method !== "POST"
      )
        return new Response(null, { status: 404 }) as unknown as WorkerResponse;
      const provided = request.headers.get("authorization") ?? "";
      const expected = `Bearer ${env.CLOUD_QUEUE_DISPATCH_TOKEN}`;
      const [left, right] = await Promise.all([
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
      ]);
      const a = new Uint8Array(left);
      const b = new Uint8Array(right);
      let mismatch = 0;
      for (let i = 0; i < a.length; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
      if (mismatch) return new Response(null, { status: 401 }) as unknown as WorkerResponse;
      const raw = await request.text();
      if (raw.length > 2000)
        return new Response(null, { status: 413 }) as unknown as WorkerResponse;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return new Response(null, { status: 400 }) as unknown as WorkerResponse;
      }
      const parsed = z
        .object({
          type: z.literal("cloud_diagnostic"),
          job_id: z.string().uuid(),
          tenant_id: z.string().uuid(),
          subject_id: z.string().uuid(),
        })
        .strict()
        .safeParse(json);
      if (!parsed.success) return new Response(null, { status: 400 }) as unknown as WorkerResponse;
      await env.FINDME_TASKS.send(parsed.data);
      return new Response(JSON.stringify({ queued: true }), {
        status: 202,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }) as unknown as WorkerResponse;
    }
    if (url.pathname === "/health" || url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const runtime = createRuntime(env);
      try {
        const response = await runtime.app.fetch(request as unknown as globalThis.Request);
        return response as unknown as WorkerResponse;
      } finally {
        if (runtime.close) ctx.waitUntil(runtime.close());
      }
    }
    // The browser client is deployed separately from apps/app; no legacy UI or database fallback.
    return new Response("Not Found", { status: 404 }) as unknown as WorkerResponse;
  },

  async queue(batch, env) {
    const runtime = createRuntime(env);
    try {
      for (const message of batch.messages) {
        if (
          message.body !== null &&
          typeof message.body === "object" &&
          "type" in message.body &&
          message.body.type === "cloud_diagnostic"
        ) {
          if (!runtime.cloud) {
            message.retry({ delaySeconds: 60 });
            continue;
          }
          try {
            await runtime.cloud.processing.consume(message.body);
            message.ack();
          } catch {
            message.retry({ delaySeconds: 60 });
          }
        } else if (!runtime.cloud) {
          await consumeTaskMessage({
            db: runtime.db,
            message: message as never,
            deps: buildProcessDeps(runtime, env),
            workerId: `cf-queue:${batch.queue}`,
          });
        } else message.retry({ delaySeconds: 600 });
      }
    } finally {
      await runtime.close?.();
    }
  },
  async scheduled(_controller, env) {
    // Stop before creating any runtime/database connection, even for stale cron deliveries.
    if (env.FINDME_SCHEDULED_ENABLED !== "1") return;
    // A schedule never starts paid cloud inference or revives a failed diagnostic job.
    if (env.FINDME_ACCOUNT_MODE === "1") return;
    const runtime = createRuntime(env);
    await dispatchDueTasks(runtime.db, async (taskId) => {
      await env.FINDME_TASKS.send({ task_id: taskId });
    });
  },
};

export default worker;
