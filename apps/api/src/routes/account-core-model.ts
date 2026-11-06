import { ContinueExplorationInput, CorrectUnderstandingInput } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { invalidateCloudSources } from "../cloud-diagnostic/effects.js";
import { lockPiProfileState, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import { replyToMessageWith } from "../core/conversation.js";
import { CoreError } from "../core/errors.js";
import { continueExplorationWith } from "../core/exploration-planning.js";
import { loadExploration } from "../core/exploration-reading.js";
import { correctUnderstandingWith } from "../core/exploration-revision.js";
import type { CoreStore, PersonalContext } from "../core/exploration-types.js";
import type { CoreGateway } from "../core/llm.js";
import {
  beginCoreOperation,
  completeCoreOperation,
  getCoreOperation,
  markCoreOperationFailed,
} from "../core/operations.js";
import { PI_REPLY_LIMITS, type PiReplyHandler } from "../personal-understanding/pi-conversation.js";

/**
 * Account-mode Core operations that call the model. Owner decision (2026-10-31):
 * ordinary conversation processing runs automatically, bounded by the existing
 * per-stage attempt limits and a rolling 24-hour operation limit per Profile.
 * Every database step is its own short RLS transaction; the model call runs
 * between them, never inside one.
 */
export const CORE_MODEL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CORE_MODEL_OPERATION_TYPES = [
  "exploration_continue",
  "exploration_correct",
  "exploration_reply",
] as const;
/** A re-execution of a failed operation spends model requests again, so it is charged. */
const RETRY_CHARGE_TYPE = "core_model_retry_charge";
/** Upper bound of model requests one operation may make (2 planner + 2 synthesis attempts). */
export const CORE_MODEL_MAX_CALLS_PER_OPERATION = 4;

export type AccountCoreModelOptions = {
  db: Db;
  gateway?: CoreGateway;
  piReply?: PiReplyHandler;
  /** Bound HTTP waiting; background execution retains the same reserved operation. */
  piSynchronousWaitMs?: number;
  contextFor: (c: Context) => Promise<PersonalContext>;
  dailyOperationLimit: number;
};

const ContinueBody = z.object({
  expected_version: z.number().int().positive(),
  force_deeper: z.boolean().optional(),
});
const CorrectBody = z.union([
  z.object({
    expected_version: z.number().int().positive(),
    correction_source_id: z.string().uuid(),
  }),
  z.object({
    expected_version: z.number().int().positive(),
    claim_revision_ids: z.array(z.string().uuid()).min(1),
    correction: CorrectUnderstandingInput.shape.correction,
  }),
]);
const CancelBody = z.object({ execution_id: z.string().uuid() }).strict();
const ReplyBody = z.object({
  expected_version: z.number().int().positive(),
  message_source_id: z.string().uuid(),
});

/**
 * Disables the gateway's own per-extraction retry so the limit counts provider
 * requests: Core validators already make at most two extractions per stage.
 */
export function singleAttemptGateway(gateway: CoreGateway): CoreGateway {
  return {
    describe: (route) => gateway.describe(route),
    extract: ((input: Parameters<CoreGateway["extract"]>[0]) =>
      gateway.extract({
        ...input,
        controls: { ...input.controls, retries: 0 },
      })) as CoreGateway["extract"],
  };
}

export function profileCoreStore(db: Db, ctx: PersonalContext): CoreStore {
  const run = <T>(work: (db: Db) => Promise<T>) =>
    withProfileTransaction(db, ctx, async (tx) => {
      await lockPiProfileState(tx, ctx);
      return work(tx as unknown as Db);
    });
  return { read: run, write: run };
}

async function usedOperations(db: Db, ctx: PersonalContext, excludeId?: string) {
  const since = new Date(Date.now() - CORE_MODEL_WINDOW_MS);
  const [row] = await db
    .select({ value: count() })
    .from(coreSchema.coreOperations)
    .where(
      and(
        eq(coreSchema.coreOperations.tenantId, ctx.tenantId),
        eq(coreSchema.coreOperations.subjectId, ctx.subjectId),
        inArray(coreSchema.coreOperations.operationType, [
          ...CORE_MODEL_OPERATION_TYPES,
          RETRY_CHARGE_TYPE,
        ]),
        gt(coreSchema.coreOperations.createdAt, since),
        ...(excludeId ? [ne(coreSchema.coreOperations.id, excludeId)] : []),
      ),
    );
  return Number(row?.value ?? 0);
}

function idempotencyKey(c: Context) {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 200)
    throw new CoreError("IDEMPOTENCY_KEY_REQUIRED", 400, "这个操作需要 Idempotency-Key");
  return key;
}

export function accountCoreModelRoutes(options: AccountCoreModelOptions) {
  const { db } = options;
  const gateway = options.gateway ? singleAttemptGateway(options.gateway) : undefined;
  const dailyOperationLimit = gateway ? Math.max(0, Math.floor(options.dailyOperationLimit)) : 0;
  const r = new Hono();
  // The durable operation owns publication; this process-local handle only aborts
  // its current transport. A new retry always gets a different execution token.
  const activeReplies = new Map<
    string,
    { executionId: string; explorationId: string; controller: AbortController }
  >();
  const processingBody = (operationId: string) => {
    const active = activeReplies.get(operationId);
    return {
      operation_id: operationId,
      status: "processing" as const,
      ...(active && !active.controller.signal.aborted
        ? { execution_id: active.executionId, can_cancel: true }
        : { can_cancel: false }),
    };
  };
  const requireGateway = () => {
    if (!gateway || dailyOperationLimit <= 0)
      throw new CoreError("LLM_UNAVAILABLE", 503, "自动处理尚未启用");
    return gateway;
  };

  r.get("/model-status", async (c) => {
    const ctx = await options.contextFor(c);
    const used = await withProfileTransaction(db, ctx, (tx) =>
      usedOperations(tx as unknown as Db, ctx),
    );
    return c.json({
      enabled: dailyOperationLimit > 0,
      window_hours: CORE_MODEL_WINDOW_MS / 3_600_000,
      operation_limit: dailyOperationLimit,
      operations_used: used,
      max_calls_per_operation: options.piReply
        ? PI_REPLY_LIMITS.maxRequests
        : CORE_MODEL_MAX_CALLS_PER_OPERATION,
    });
  });

  r.get("/model-operations/:id", async (c) => {
    const ctx = await options.contextFor(c);
    const id = z.string().uuid().parse(c.req.param("id"));
    const operation = await withProfileTransaction(db, ctx, (tx) =>
      getCoreOperation(tx as unknown as Db, ctx, id),
    );
    if (!operation) throw new CoreError("NOT_FOUND", 404, "处理记录不存在");
    const expired =
      operation.status === "processing" &&
      (!operation.leaseExpiresAt || operation.leaseExpiresAt.getTime() <= Date.now());
    return c.json({
      stopping: activeReplies.get(id)?.controller.signal.aborted === true,
      ...(operation.status === "processing" && !expired
        ? processingBody(id)
        : { can_cancel: false }),
      status: expired ? "stale" : operation.status,
      ...(operation.status === "completed" ? { response: operation.responseBody } : {}),
      ...(operation.status === "failed" && operation.responseBody?.error
        ? { error: operation.responseBody.error }
        : {}),
    });
  });

  r.post("/model-operations/:id/cancel", zValidator("json", CancelBody), async (c) => {
    const ctx = await options.contextFor(c);
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = c.req.valid("json");
    const key = idempotencyKey(c);
    let abort: AbortController | undefined;
    const response = await withProfileTransaction(db, ctx, async (tx) => {
      await lockPiProfileState(tx, ctx);
      const scoped = tx as unknown as Db;
      const target = await getCoreOperation(scoped, ctx, id);
      if (!target || target.operationType !== "exploration_reply" || !options.piReply)
        throw new CoreError("NOT_FOUND", 404, "可停止的回应不存在");
      const cancellation = await beginCoreOperation(scoped, ctx, {
        idempotencyKey: key,
        operationType: "exploration_reply_cancel",
        request: { operation_id: id, execution_id: body.execution_id },
        explorationId: target.explorationId ?? undefined,
      });
      if (cancellation.kind === "replay") return cancellation.body;
      if (cancellation.kind === "processing")
        throw new CoreError("OPERATION_IN_PROGRESS", 409, "停止请求仍在处理");
      const [locked] = await scoped
        .select()
        .from(coreSchema.coreOperations)
        .where(
          and(
            eq(coreSchema.coreOperations.id, id),
            eq(coreSchema.coreOperations.subjectId, ctx.subjectId),
          ),
        )
        .for("update");
      if (!locked) throw new CoreError("NOT_FOUND", 404, "可停止的回应不存在");
      const active = activeReplies.get(id);
      if (locked.status === "processing" && active && active.executionId !== body.execution_id)
        throw new CoreError("STALE_VERSION", 409, "这次生成已变化，请重新读取当前状态");
      let status = locked.status;
      if (locked.status === "processing") {
        await scoped
          .update(coreSchema.coreOperations)
          .set({
            status: "failed",
            leaseExpiresAt: null,
            completedAt: new Date(),
            responseStatus: 409,
            responseBody: { error: { code: "PI_USER_ABORTED", message: "本轮已停止，输入已保存" } },
          })
          .where(eq(coreSchema.coreOperations.id, id));
        abort = active?.controller;
        status = "stopped";
      } else if (
        (locked.responseBody?.error as { code?: string } | undefined)?.code === "PI_USER_ABORTED"
      ) {
        status = "stopped";
      }
      const result = { operation_id: id, status };
      await completeCoreOperation(scoped, cancellation.operationId, 200, result);
      return result;
    });
    // Do not bind cancellation to the browser connection: HTTP 202 work survives
    // navigation/disconnect. Only this explicit, scoped action aborts transport.
    abort?.abort();
    return c.json(response);
  });

  async function run(
    c: Context,
    args: {
      ctx: PersonalContext;
      operationType: (typeof CORE_MODEL_OPERATION_TYPES)[number];
      request: Record<string, unknown>;
      explorationId: string;
      basisVersion: number;
      execute: (
        store: CoreStore,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<Record<string, unknown>>;
    },
  ) {
    const key = idempotencyKey(c);
    const operation = await withProfileTransaction(db, args.ctx, async (tx) => {
      await lockPiProfileState(tx, args.ctx);
      const scoped = tx as unknown as Db;
      // Resolve ownership first: an operation row naming another Profile's
      // exploration is rejected by RLS and would abort this transaction.
      await loadExploration(scoped, args.ctx, args.explorationId);
      const [previous] = await scoped
        .select({
          id: coreSchema.coreOperations.id,
          createdAt: coreSchema.coreOperations.createdAt,
        })
        .from(coreSchema.coreOperations)
        .where(
          and(
            eq(coreSchema.coreOperations.tenantId, args.ctx.tenantId),
            eq(coreSchema.coreOperations.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (
        [...activeReplies.values()].some(
          (active) =>
            active.explorationId === args.explorationId && active.controller.signal.aborted,
        )
      )
        throw new CoreError("OPERATION_IN_PROGRESS", 409, "上一轮正在停止，请稍后重试");
      const started = await beginCoreOperation(scoped, args.ctx, {
        idempotencyKey: key,
        operationType: args.operationType,
        request: args.request,
        explorationId: args.explorationId,
        basisVersion: args.basisVersion,
      });
      if (started.kind !== "execute") return started;
      // Serialise reservations per Profile so concurrent new keys cannot all
      // count the same committed total and exceed the limit together.
      await scoped.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`core-model:${args.ctx.tenantId}:${args.ctx.subjectId}`}, 0))`,
      );
      // Throwing here rolls back the reservation: nothing is recorded or called.
      // An existing row being executed again (failed, stale or expired lease)
      // already counted once; this run is charged as an additional use.
      const retry = previous?.id === started.operationId;
      // The original reservation counts only while it is inside the window.
      const originalInWindow =
        retry && previous.createdAt.getTime() > Date.now() - CORE_MODEL_WINDOW_MS;
      if (
        (await usedOperations(scoped, args.ctx, started.operationId)) +
          (originalInWindow ? 1 : 0) >=
        dailyOperationLimit
      )
        throw new CoreError(
          "CORE_MODEL_LIMIT_REACHED",
          503,
          "最近 24 小时的自动处理次数已用完；输入已保存，可以稍后继续",
          { operation_limit: dailyOperationLimit, window_hours: CORE_MODEL_WINDOW_MS / 3_600_000 },
        );
      if (retry)
        await scoped.insert(coreSchema.coreOperations).values({
          tenantId: args.ctx.tenantId,
          subjectId: args.ctx.subjectId,
          explorationId: args.explorationId,
          idempotencyKey: `${key}#retry-charge:${crypto.randomUUID()}`,
          operationType: RETRY_CHARGE_TYPE,
          requestHash: "retry-charge",
          status: "completed",
          completedAt: new Date(),
        });
      return started;
    });
    if (operation.kind === "replay")
      return new Response(JSON.stringify(operation.body), {
        status: operation.status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    if (operation.kind === "processing") return c.json(processingBody(operation.operationId), 202);

    const active =
      options.piReply && args.operationType === "exploration_reply"
        ? {
            executionId: crypto.randomUUID(),
            explorationId: args.explorationId,
            controller: new AbortController(),
          }
        : undefined;
    if (active) activeReplies.set(operation.operationId, active);
    const store = profileCoreStore(db, args.ctx);
    const execute = async () => {
      try {
        const result = await args.execute(store, operation.operationId, active?.controller.signal);
        const source = typeof result.source_id === "string" ? result.source_id : undefined;
        if (source)
          await withProfileTransaction(db, args.ctx, (tx) =>
            invalidateCloudSources(tx, args.ctx, [source]),
          );
        return c.json(result, 201);
      } catch (error) {
        const stale =
          error instanceof CoreError &&
          (error.code === "STALE_VERSION" || error.code === "STALE_CLAIM_REVISION");
        await withProfileTransaction(db, args.ctx, async (tx) => {
          await lockPiProfileState(tx, args.ctx);
          await markCoreOperationFailed(
            tx as unknown as Db,
            operation.operationId,
            stale ? "stale" : "failed",
          );
          if (
            options.piReply &&
            args.operationType === "exploration_reply" &&
            error instanceof CoreError
          )
            await tx
              .update(coreSchema.coreOperations)
              .set({ responseBody: { error: { code: error.code, message: error.message } } })
              .where(
                and(
                  eq(coreSchema.coreOperations.id, operation.operationId),
                  eq(coreSchema.coreOperations.status, "failed"),
                  sql`coalesce(${coreSchema.coreOperations.responseBody}->'error'->>'code','') <> 'PI_USER_ABORTED'`,
                ),
              );
        }).catch(() => undefined);
        throw error;
      } finally {
        if (activeReplies.get(operation.operationId) === active)
          activeReplies.delete(operation.operationId);
      }
    };
    if (!options.piReply || args.operationType !== "exploration_reply") return execute();
    const task = execute();
    // The same durable reservation continues after HTTP 202; polling is read-only.
    // Catch a late rejection because its failed status is already persisted above.
    void task.catch(() => undefined);
    // App callers opt into immediate acknowledgement so a real execution token
    // is available for stop; default API callers retain synchronous compatibility.
    if (c.req.query("async") === "1") return c.json(processingBody(operation.operationId), 202);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<Response>((resolve) => {
          timer = setTimeout(
            () => resolve(c.json(processingBody(operation.operationId), 202)),
            options.piSynchronousWaitMs ?? 8000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  r.post("/explorations/:id/continue", zValidator("json", ContinueBody), async (c) => {
    const model = requireGateway();
    const ctx = await options.contextFor(c);
    const body = c.req.valid("json");
    const input = ContinueExplorationInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
      force_deeper: body.force_deeper ?? false,
    });
    return run(c, {
      ctx,
      operationType: "exploration_continue",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (store, operationId) =>
        continueExplorationWith(store, model, ctx, input, operationId),
    });
  });

  r.post("/explorations/:id/correct", zValidator("json", CorrectBody), async (c) => {
    const model = requireGateway();
    const ctx = await options.contextFor(c);
    const body = c.req.valid("json");
    const input = { exploration_id: c.req.param("id"), ...body };
    return run(c, {
      ctx,
      operationType: "exploration_correct",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (store, operationId) =>
        correctUnderstandingWith(store, model, ctx, input, operationId),
    });
  });

  r.post("/explorations/:id/reply", zValidator("json", ReplyBody), async (c) => {
    const model = requireGateway();
    const ctx = await options.contextFor(c);
    const input = { exploration_id: c.req.param("id"), ...c.req.valid("json") };
    return run(c, {
      ctx,
      operationType: "exploration_reply",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (store, operationId, signal) =>
        options.piReply
          ? options.piReply(ctx, input, operationId, signal)
          : replyToMessageWith(store, model, ctx, input, operationId),
    });
  });

  return r;
}
