import {
  AmendSourceInput,
  CompleteExplorationInput,
  ContinueExplorationInput,
  CoreReportTransferInput,
  CorrectUnderstandingInput,
  RespondToExplorationInput,
  StartExplorationInput,
  UnderstandingSourceRebind,
  UpdateSourceAssessmentInput,
} from "@findme/core";
import type { Db } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { CoreError } from "../core/errors.js";
import {
  amendExplorationSource,
  completeExploration,
  continueExploration,
  correctUnderstanding,
  getCurrentUnderstanding,
  getExplorationView,
  listExplorations,
  respondToExploration,
  startExploration,
} from "../core/exploration-service.js";
import { type Principal, resolvePersonalContext } from "../core/identity.js";
import type { CoreGateway } from "../core/llm.js";
import {
  beginCoreOperation,
  getCoreOperation,
  markCoreOperationFailed,
} from "../core/operations.js";
import {
  type CoreReportBackend,
  type NativeReportService,
  rebindCoreReportSource,
  requireReportBridge,
  transferCoreReportSource,
} from "../core/report-bridge.js";
import { createCoreReportBackend } from "../core/report-source-service.js";
import { updateSourceAssessment } from "../core/source-service.js";

export type PrincipalResolver = (c: Context) => Principal | Promise<Principal>;

const RespondBody = z
  .object({
    expected_version: z.number().int().positive(),
    question_id: z.string().uuid(),
    answer: z.string().max(5000).default(""),
    selected_options: z.array(z.string().min(1).max(120)).max(4).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.answer.trim() && value.selected_options.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer or selected_options required" });
    }
  });

const CorrectBody = z.object({
  expected_version: z.number().int().positive(),
  claim_revision_ids: z.array(z.string().uuid()).min(1),
  correction: CorrectUnderstandingInput.shape.correction,
});

const VersionBody = z.object({
  expected_version: z.number().int().positive(),
});

const ContinueBody = VersionBody.extend({
  force_deeper: z.boolean().optional(),
});

const AmendBody = z.object({
  expected_version: z.number().int().positive(),
  target_source_id: z.string().uuid(),
  type: AmendSourceInput.shape.type,
  note: z.string().min(1).max(5000),
});

const ExplorationListQuery = z.object({
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const SourceAssessmentBody = z.object({
  expected_assessment_version: z.number().int().positive(),
  assessment: UpdateSourceAssessmentInput.shape.assessment,
});

function requireIdempotencyKey(c: Context) {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 200) {
    throw new CoreError("IDEMPOTENCY_KEY_REQUIRED", 400, "这个操作需要 Idempotency-Key");
  }
  return key;
}

function replayJson(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export function coreRoutes(
  db: Db,
  gateway: CoreGateway | undefined,
  resolvePrincipal: PrincipalResolver,
  reports?: NativeReportService,
  seams?: {
    contextFor: (c: Context) => Promise<Awaited<ReturnType<typeof resolvePersonalContext>>>;
    backend: CoreReportBackend;
  },
) {
  const r = new Hono();

  async function contextFor(c: Context) {
    if (seams) return seams.contextFor(c);
    const principal = await resolvePrincipal(c);
    return resolvePersonalContext(db, principal);
  }
  const reportBackend = seams?.backend ?? createCoreReportBackend(db);
  r.get("/capabilities", async (c) => {
    const ctx = await contextFor(c);
    // Calling read also enforces the adapter's owner scope before advertising access.
    if (reports) await requireReportBridge(reports).read(ctx);
    return c.json({ native_core: true, report_bridge: !!reports });
  });

  // Stable source/version/target key in the bridge is the operation identity across
  // downstream acknowledgements. No Core event mutation or model invocation here.
  r.post(
    "/explorations/:id/report-feedback",
    zValidator("json", CoreReportTransferInput),
    async (c) => {
      const ctx = await contextFor(c);
      return c.json(
        await transferCoreReportSource(
          reportBackend,
          reports,
          ctx,
          c.req.param("id"),
          c.req.valid("json"),
        ),
        201,
      );
    },
  );

  r.post("/report-sources/rebind", zValidator("json", UnderstandingSourceRebind), async (c) => {
    const ctx = await contextFor(c);
    return c.json(await rebindCoreReportSource(reportBackend, reports, ctx, c.req.valid("json")));
  });

  async function runMutation<T extends Record<string, unknown>>(
    c: Context,
    args: {
      ctx: Awaited<ReturnType<typeof contextFor>>;
      operationType: string;
      request: Record<string, unknown>;
      explorationId?: string;
      basisVersion?: number;
      successStatus?: 200 | 201;
      execute: (operationId: string) => Promise<T>;
    },
  ) {
    const idempotencyKey = requireIdempotencyKey(c);
    const operation = await beginCoreOperation(db, args.ctx, {
      idempotencyKey,
      operationType: args.operationType,
      request: args.request,
      explorationId: args.explorationId,
      basisVersion: args.basisVersion,
    });

    if (operation.kind === "replay") {
      return replayJson(operation.status, operation.body);
    }
    if (operation.kind === "processing") {
      return c.json(
        {
          operation_id: operation.operationId,
          status: "processing",
        },
        202,
      );
    }

    try {
      const result = await args.execute(operation.operationId);
      return c.json(result, args.successStatus ?? 201);
    } catch (error) {
      await markCoreOperationFailed(
        db,
        operation.operationId,
        error instanceof CoreError &&
          (error.code === "STALE_VERSION" || error.code === "STALE_CLAIM_REVISION")
          ? "stale"
          : "failed",
      ).catch(() => undefined);
      throw error;
    }
  }

  r.get("/me", async (c) => {
    const ctx = await contextFor(c);
    return c.json({
      tenant_id: ctx.tenantId,
      subject_id: ctx.subjectId,
    });
  });

  r.get("/operations/:id", async (c) => {
    const ctx = await contextFor(c);
    const operation = await getCoreOperation(db, ctx, c.req.param("id"));
    if (!operation) return c.json({ error: { code: "NOT_FOUND" } }, 404);

    return c.json({
      id: operation.id,
      status: operation.status,
      response_status: operation.responseStatus,
      response_body: operation.status === "completed" ? operation.responseBody : null,
      completed_at: operation.completedAt,
    });
  });

  r.post("/explorations", zValidator("json", StartExplorationInput), async (c) => {
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const target = body.report_target
      ? await requireReportBridge(reports).validateTarget(ctx, body.report_target)
      : undefined;
    return runMutation(c, {
      ctx,
      operationType: "exploration_start",
      request: body,
      execute: (operationId) => startExploration(db, gateway, ctx, body, operationId, target),
    });
  });

  r.post("/explorations/:id/respond", zValidator("json", RespondBody), async (c) => {
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = RespondToExplorationInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
      question_id: body.question_id,
      answer: body.answer,
      selected_options: body.selected_options,
    });
    return runMutation(c, {
      ctx,
      operationType: "exploration_respond",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (operationId) => respondToExploration(db, gateway, ctx, input, operationId),
    });
  });

  r.post("/explorations/:id/amend", zValidator("json", AmendBody), async (c) => {
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = AmendSourceInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
      target_source_id: body.target_source_id,
      type: body.type,
      note: body.note,
    });
    return runMutation(c, {
      ctx,
      operationType: "exploration_amend",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (operationId) => amendExplorationSource(db, ctx, input, operationId),
    });
  });

  r.post("/explorations/:id/correct", zValidator("json", CorrectBody), async (c) => {
    if (!gateway) throw new CoreError("LLM_UNAVAILABLE", 503, "模型服务暂不可用");
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = CorrectUnderstandingInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
      claim_revision_ids: body.claim_revision_ids,
      correction: body.correction,
    });
    return runMutation(c, {
      ctx,
      operationType: "exploration_correct",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (operationId) => correctUnderstanding(db, gateway, ctx, input, operationId),
    });
  });

  r.get("/explorations", zValidator("query", ExplorationListQuery), async (c) => {
    const ctx = await contextFor(c);
    return c.json(await listExplorations(db, ctx, c.req.valid("query")));
  });

  r.post("/explorations/:id/continue", zValidator("json", ContinueBody), async (c) => {
    if (!gateway) throw new CoreError("LLM_UNAVAILABLE", 503, "模型服务暂不可用");
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = ContinueExplorationInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
      force_deeper: body.force_deeper ?? false,
    });
    return runMutation(c, {
      ctx,
      operationType: "exploration_continue",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      execute: (operationId) => continueExploration(db, gateway, ctx, input, operationId),
    });
  });

  r.post("/explorations/:id/complete", zValidator("json", VersionBody), async (c) => {
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = CompleteExplorationInput.parse({
      exploration_id: c.req.param("id"),
      expected_version: body.expected_version,
    });
    return runMutation(c, {
      ctx,
      operationType: "exploration_complete",
      request: input,
      explorationId: input.exploration_id,
      basisVersion: input.expected_version,
      successStatus: 200,
      execute: (operationId) => completeExploration(db, ctx, input, operationId),
    });
  });

  r.get("/explorations/:id", async (c) => {
    const ctx = await contextFor(c);
    const result = await getExplorationView(db, ctx, c.req.param("id"));
    const sources =
      reports && result.report_target
        ? await Promise.all(
            result.turns
              .flatMap((t) => (t.role === "user" && t.sourceItemId ? [t.sourceItemId] : []))
              .map(async (sourceItemId) => {
                try {
                  return await reportBackend.source(ctx, result.id, sourceItemId);
                } catch (e) {
                  if (e instanceof CoreError && e.code === "REPORT_SOURCE_INELIGIBLE") return null;
                  throw e;
                }
              }),
          )
        : [];
    return c.json({ ...result, report_sources: sources.filter((s) => s !== null) });
  });

  r.post("/sources/:id/assessment", zValidator("json", SourceAssessmentBody), async (c) => {
    const ctx = await contextFor(c);
    const body = c.req.valid("json");
    const input = UpdateSourceAssessmentInput.parse({
      source_id: c.req.param("id"),
      expected_assessment_version: body.expected_assessment_version,
      assessment: body.assessment,
    });
    return runMutation(c, {
      ctx,
      operationType: "source_assessment_update",
      request: input,
      basisVersion: input.expected_assessment_version,
      successStatus: 200,
      execute: (operationId) => updateSourceAssessment(db, ctx, input, operationId),
    });
  });

  r.get("/understanding", async (c) => {
    const ctx = await contextFor(c);
    return c.json(await getCurrentUnderstanding(db, ctx));
  });

  return r;
}
