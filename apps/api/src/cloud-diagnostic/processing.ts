import { randomUUID } from "node:crypto";
import {
  type CloudEvidenceBinding,
  CloudProcessRequest,
  UnderstandingAudit,
  UnderstandingReport,
} from "@findme/core";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import {
  PROMPTS,
  assignReport,
  normalizeReportTimes,
  reportObjects,
  validateAudit,
  validateReport,
} from "../domain/understanding/policy.js";
import type { Fact } from "../domain/understanding/types.js";
import { GatewayRequestError, type createGateway } from "../llm/gateway.js";
import { digest } from "../shared/primitives.js";
import { UnderstandingQualification } from "../understanding-app/qualification-schema.js";
import { qualificationAssigned } from "../understanding-app/qualification.js";
import { CLOUD_PIPELINE_ID } from "./policy-identity.js";
import {
  claimQueuedJob,
  invalidatesQueuedJob,
  jobReservationBlocked,
  processingFailureStatus,
  profileCapExhausted,
  recoveryDecision,
  reuseProcessingJob,
} from "./processing-policy.js";
import {
  CLOUD_QUALIFICATION_AUDIT_PROMPT,
  CLOUD_QUALIFICATION_PROMPT,
  PipelineInput,
  QUALIFICATION_HASH,
  SnapshotSource,
  cloudFacts,
  cloudQualificationInput,
  qualificationProof,
} from "./provenance.js";
import {
  CloudDiagnosticRepository,
  cloudReportCurrent,
  cloudRunCurrent,
  cloudSourceHash,
} from "./repository.js";
import { type ProfileTransaction, withProfileTransaction } from "./scope.js";

export type CloudQueueMessage = {
  type: "cloud_diagnostic";
  job_id: string;
  tenant_id: string;
  subject_id: string;
};
export type CloudProcessingOptions = {
  enabled: boolean;
  profileCallLimit: number;
  maxCallsPerJob: number;
  maxOutputTokens: number;
  timeoutMs: number;
};
type Gateway = Pick<ReturnType<typeof createGateway>, "extract" | "describe">;
type Job = typeof p.cloudJobs.$inferSelect;
const PIPELINE = CLOUD_PIPELINE_ID;
const ownedJob = (ctx: PersonalContext, id: string) =>
  and(
    eq(p.cloudJobs.id, id),
    eq(p.cloudJobs.tenantId, ctx.tenantId),
    eq(p.cloudJobs.subjectId, ctx.subjectId),
  );
const required = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("CLOUD_STATE_MISSING");
  return x;
};
function errorCode(error: unknown) {
  return error instanceof GatewayRequestError
    ? `PROVIDER_${error.kind.toUpperCase()}`
    : error instanceof CoreError
      ? error.code
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "PROCESSING_FAILED";
}
const safeJob = (job: Job) => ({
  id: job.id,
  run_id: job.runId,
  status: job.status,
  stage: job.stage,
  calls_used: job.callsUsed,
  call_cap: job.callCap,
  error: job.error,
  created_at: job.createdAt.toISOString(),
  updated_at: job.updatedAt.toISOString(),
});

/** Durable server-side pipeline. Construction, reads, response saves and enqueue do not call a model. */
export class CloudProcessingService {
  private repository: CloudDiagnosticRepository;
  constructor(
    private db: Db,
    private gateway: Gateway | undefined,
    private options: CloudProcessingOptions,
    private send?: (message: CloudQueueMessage) => Promise<void>,
  ) {
    this.repository = new CloudDiagnosticRepository(db);
    for (const n of [
      options.profileCallLimit,
      options.maxCallsPerJob,
      options.maxOutputTokens,
      options.timeoutMs,
    ])
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("INVALID_CLOUD_BUDGET");
    if (
      options.maxCallsPerJob > 20 ||
      options.timeoutMs > 120000 ||
      options.maxOutputTokens > 16000
    )
      throw new Error("INVALID_CLOUD_LIMITS");
    if (gateway?.describe("extraction_model").model.startsWith("codex-cli:"))
      throw new Error("CLOUD_REQUIRES_SERVER_PROVIDER");
  }
  capabilities() {
    return {
      inference_enabled: !!this.gateway && !!this.send && this.options.enabled,
      accepted_publication: true,
      max_calls_per_job: this.options.maxCallsPerJob,
      storage: "postgres",
      enqueue_only: true,
    };
  }
  private ensureEnabled() {
    if (!this.options.enabled || !this.gateway || !this.send)
      throw new CoreError("LLM_UNAVAILABLE", 503, "云端处理未启用或队列未配置");
    return this.gateway;
  }
  private queue() {
    if (!this.send) throw new CoreError("LLM_UNAVAILABLE", 503, "云端处理未启用或队列未配置");
    return this.send;
  }
  private model() {
    if (!this.gateway) throw new CoreError("LLM_UNAVAILABLE", 503, "云端处理未启用或队列未配置");
    return this.gateway.describe("extraction_model").model;
  }
  async jobs(ctx: PersonalContext, runId: string) {
    return withProfileTransaction(this.db, ctx, async (tx) =>
      (
        await tx
          .select()
          .from(p.cloudJobs)
          .where(
            and(
              eq(p.cloudJobs.tenantId, ctx.tenantId),
              eq(p.cloudJobs.subjectId, ctx.subjectId),
              eq(p.cloudJobs.runId, runId),
            ),
          )
          .orderBy(desc(p.cloudJobs.createdAt))
          .limit(50)
      ).map(safeJob),
    );
  }
  async get(ctx: PersonalContext, id: string) {
    return withProfileTransaction(this.db, ctx, async (tx) =>
      safeJob(required((await tx.select().from(p.cloudJobs).where(ownedJob(ctx, id)).limit(1))[0])),
    );
  }

  private async snapshot(
    tx: ProfileTransaction,
    ctx: PersonalContext,
    runId: string,
    raw: z.infer<typeof CloudProcessRequest>,
  ): Promise<PipelineInput> {
    const [run] = await tx
      .select()
      .from(d.diagnosticRuns)
      .where(
        and(
          eq(d.diagnosticRuns.id, runId),
          eq(d.diagnosticRuns.tenantId, ctx.tenantId),
          eq(d.diagnosticRuns.subjectId, ctx.subjectId),
        ),
      )
      .limit(1);
    if (!run) throw new CoreError("DIAGNOSTIC_NOT_FOUND", 404, "诊断不存在");
    if (run.version !== raw.expected_version || run.status === "archived")
      throw new CoreError("STALE_VERSION", 409, "诊断依据已变化");
    const current = await cloudRunCurrent(tx, ctx, run);
    if (current) throw new CoreError("STALE_VERSION", 409, "已有当前报告；先补充或更正资料");
    const ids = new Set(raw.source_ids);
    const dependencies: PipelineInput["dependencies"] = [];
    const pending = await tx
      .select()
      .from(d.diagnosticResponses)
      .where(
        and(
          eq(d.diagnosticResponses.runId, runId),
          eq(d.diagnosticResponses.tenantId, ctx.tenantId),
          eq(d.diagnosticResponses.subjectId, ctx.subjectId),
        ),
      );
    // Explicit selection can narrow history, but never silently skip unprocessed new responses.
    for (const response of pending)
      if (response.sourceId && response.processingStatus === "recorded") ids.add(response.sourceId);
    if (run.headVersion > 0) {
      const [head] = await tx
        .select()
        .from(d.diagnosticReportRevisions)
        .where(
          and(
            eq(d.diagnosticReportRevisions.runId, runId),
            eq(d.diagnosticReportRevisions.tenantId, ctx.tenantId),
            eq(d.diagnosticReportRevisions.subjectId, ctx.subjectId),
            eq(d.diagnosticReportRevisions.version, run.headVersion),
          ),
        )
        .limit(1);
      if (head && (await cloudReportCurrent(tx, ctx, run, head))) {
        const refs = await tx
          .select()
          .from(d.diagnosticReportSources)
          .where(eq(d.diagnosticReportSources.reportRevisionId, head.id));
        for (const ref of refs) ids.add(ref.sourceId);
      }
    }
    if (run.domain === "overall") {
      if (!raw.topic_run_ids.length) throw new Error("OVERALL_TOPIC_SELECTION_REQUIRED");
      for (const topicId of raw.topic_run_ids) {
        const [topic] = await tx
          .select()
          .from(d.diagnosticRuns)
          .where(
            and(
              eq(d.diagnosticRuns.id, topicId),
              eq(d.diagnosticRuns.tenantId, ctx.tenantId),
              eq(d.diagnosticRuns.subjectId, ctx.subjectId),
            ),
          )
          .limit(1);
        if (!topic || topic.domain === "overall" || !(await cloudRunCurrent(tx, ctx, topic)))
          throw new Error("TOPICS_NOT_CURRENT");
        dependencies.push({
          id: topic.id,
          version: topic.version,
          head_version: topic.headVersion,
        });
        const [report] = await tx
          .select()
          .from(d.diagnosticReportRevisions)
          .where(
            and(
              eq(d.diagnosticReportRevisions.runId, topic.id),
              eq(d.diagnosticReportRevisions.version, topic.headVersion),
              eq(d.diagnosticReportRevisions.status, "accepted"),
            ),
          )
          .limit(1);
        if (!report) throw new Error("TOPICS_NOT_CURRENT");
        const refs = await tx
          .select()
          .from(d.diagnosticReportSources)
          .where(eq(d.diagnosticReportSources.reportRevisionId, report.id));
        for (const ref of refs) ids.add(ref.sourceId);
      }
    }
    if (!ids.size) throw new Error("SOURCE_INPUT_REQUIRED");
    const omitted_source_ids: string[] = [];
    const sources: PipelineInput["sources"] = [];
    const qualification_jobs: Record<string, string> = {};
    for (const id of [...ids].sort()) {
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(
            eq(c.sourceItems.id, id),
            eq(c.sourceItems.tenantId, ctx.tenantId),
            eq(c.sourceItems.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!source || source.usageStatus !== "active" || source.sourceMeta?.split === "holdout") {
        if (raw.source_ids.includes(id)) throw new Error("SOURCE_UNAVAILABLE");
        omitted_source_ids.push(id);
        continue;
      }
      if (source.sourceMeta?.content_scope === "quote_excerpt") {
        if (raw.source_ids.includes(id)) throw new Error("SOURCE_EXCERPT_NOT_FULL_TEXT");
        omitted_source_ids.push(id);
        continue;
      }
      const [assessment] = await tx
        .select()
        .from(c.sourceAssessments)
        .where(
          and(eq(c.sourceAssessments.sourceItemId, id), eq(c.sourceAssessments.isCurrent, true)),
        )
        .limit(1);
      if (!assessment || assessment.eligibility === "excluded") {
        if (raw.source_ids.includes(id)) throw new Error("SOURCE_UNAVAILABLE");
        omitted_source_ids.push(id);
        continue;
      }
      const hash = await cloudSourceHash(source);
      sources.push({
        id,
        hash,
        assessment_version: assessment.version,
        text: source.content,
        reported_at: source.capturedAt.toISOString(),
        occurred_at: source.occurredAt?.toISOString() ?? null,
        root_id: typeof source.sourceMeta?.root_id === "string" ? source.sourceMeta.root_id : id,
        kind: source.sourceKind,
        author: SnapshotSource.shape.author.parse(source.authorKind),
        about: SnapshotSource.shape.about.parse(source.sourceMeta?.about),
        stance: SnapshotSource.shape.stance.parse(source.sourceMeta?.stance),
        target_context:
          source.sourceMeta?.target_context && typeof source.sourceMeta.target_context === "object"
            ? (source.sourceMeta.target_context as Record<string, unknown>)
            : null,
        response_kind:
          typeof source.sourceMeta?.response_kind === "string"
            ? source.sourceMeta.response_kind
            : "supplement",
      });
      const qualifications = await tx
        .select()
        .from(p.sourceQualifications)
        .where(
          and(
            eq(p.sourceQualifications.tenantId, ctx.tenantId),
            eq(p.sourceQualifications.subjectId, ctx.subjectId),
            eq(p.sourceQualifications.sourceId, id),
            eq(p.sourceQualifications.sourceHash, hash),
            eq(p.sourceQualifications.assessmentVersion, assessment.version),
            eq(p.sourceQualifications.rulesHash, QUALIFICATION_HASH),
          ),
        )
        .orderBy(desc(p.sourceQualifications.createdAt));
      for (const qualified of qualifications) {
        try {
          const proof = await qualificationProof(tx, ctx, qualified.jobId);
          if (
            proof.input.policy === PIPELINE &&
            proof.input.domain === run.domain &&
            proof.input.question === run.question &&
            (await requestHash(proof.input.sources.find((s) => s.id === id))) ===
              (await requestHash(sources[sources.length - 1]))
          ) {
            qualification_jobs[id] = qualified.jobId;
            break;
          }
        } catch {
          /* An unavailable old checkpoint is not reused or silently approved. */
        }
      }
    }
    if (!sources.length || sources.length > 8)
      throw new Error(sources.length ? "SOURCE_SELECTION_BOUND_EXCEEDED" : "SOURCE_INPUT_REQUIRED");
    const input: PipelineInput = {
      run_id: run.id,
      run_version: run.version,
      domain: run.domain,
      question: run.question,
      sources,
      omitted_source_ids,
      policy: PIPELINE,
      qualification_jobs:
        Object.keys(qualification_jobs).length === sources.length ? qualification_jobs : {},
      dependencies,
    };
    // Construct once before reserving any paid request; an oversized input is not truncated.
    cloudQualificationInput(input);
    return PipelineInput.parse(input);
  }
  async plan(ctx: PersonalContext, runId: string, raw: unknown) {
    const request = CloudProcessRequest.parse(raw);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const input = await this.snapshot(tx, ctx, runId, request);
      const [budget] = await tx
        .select()
        .from(p.cloudBudgets)
        .where(
          and(
            eq(p.cloudBudgets.tenantId, ctx.tenantId),
            eq(p.cloudBudgets.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      return {
        provider: "deepseek",
        model: this.gateway?.describe("extraction_model").model ?? null,
        enabled: this.capabilities().inference_enabled,
        required_calls: Object.keys(input.qualification_jobs).length ? 2 : 4,
        source_ids: input.sources.map((s) => s.id),
        estimated_input_bytes: new TextEncoder().encode(JSON.stringify(input)).length,
        remaining_profile_calls: Math.max(
          0,
          this.options.profileCallLimit - (budget?.callsUsed ?? 0),
        ),
        fees_estimate: null,
      };
    });
  }
  async enqueue(ctx: PersonalContext, runId: string, raw: unknown) {
    const request = CloudProcessRequest.parse(raw);
    const gateway = this.ensureEnabled();
    if (request.provider_call_cap > this.options.maxCallsPerJob)
      throw new Error("JOB_BUDGET_EXCEEDS_SERVER_LIMIT");
    const result = await withProfileTransaction(this.db, ctx, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ctx, runId, "cloud-enqueue"])},0))`,
      );
      const [active] = await tx
        .select()
        .from(p.cloudJobs)
        .where(
          and(
            eq(p.cloudJobs.tenantId, ctx.tenantId),
            eq(p.cloudJobs.subjectId, ctx.subjectId),
            eq(p.cloudJobs.runId, runId),
            sql`${p.cloudJobs.status} in ('queued','running')`,
          ),
        )
        .limit(1);
      if (active) {
        try {
          const previous = PipelineInput.parse(active.input);
          await this.assertFresh(tx, ctx, previous);
          if (previous.policy !== PIPELINE || active.model !== this.model())
            throw new Error("PROCESSING_VERSION_CHANGED");
          return { job: active, created: false };
        } catch (error) {
          if (!invalidatesQueuedJob(errorCode(error))) throw error;
          await tx
            .update(p.cloudJobs)
            .set({
              status: "stale",
              error: errorCode(error),
              execution: null,
              leaseUntil: null,
              updatedAt: new Date(),
            })
            .where(ownedJob(ctx, active.id));
        }
      }

      const input = await this.snapshot(tx, ctx, runId, request);
      const model = gateway.describe("extraction_model").model;
      const baseFingerprint = await requestHash([ctx, input, model]);
      // Cache availability can change after dispatch; it is not a new user basis.
      const basisHash = await requestHash([ctx, { ...input, qualification_jobs: {} }, model]);
      const previousJobs = await tx
        .select()
        .from(p.cloudJobs)
        .where(
          and(
            eq(p.cloudJobs.tenantId, ctx.tenantId),
            eq(p.cloudJobs.subjectId, ctx.subjectId),
            eq(p.cloudJobs.runId, runId),
            eq(p.cloudJobs.model, model),
          ),
        )
        .orderBy(desc(p.cloudJobs.createdAt), desc(p.cloudJobs.id));
      let previous: Job | undefined;
      for (const candidate of previousJobs)
        if (
          (await requestHash([
            ctx,
            { ...candidate.input, qualification_jobs: {} },
            candidate.model,
          ])) === basisHash
        ) {
          previous = candidate;
          break;
        }
      // A new explicit process replaces a cancelled/stale task. Its queued/failed
      // replacement remains the stable response when the original HTTP response is lost.
      if (previous && reuseProcessingJob(previous.status)) return { job: previous, created: false };
      const fingerprint = previous
        ? await requestHash([baseFingerprint, "replacement", previous.id])
        : baseFingerprint;
      const needed = Object.keys(input.qualification_jobs).length ? 2 : 4;
      if (request.provider_call_cap < needed) throw new Error("JOB_BUDGET_INSUFFICIENT");
      const [created] = await tx
        .insert(p.cloudJobs)
        .values({
          ...ctx,
          runId,
          basisVersion: input.run_version,
          input,
          fingerprint,
          model,
          callCap: request.provider_call_cap,
        })
        .onConflictDoNothing()
        .returning();
      const job =
        created ??
        required(
          (
            await tx
              .select()
              .from(p.cloudJobs)
              .where(
                and(
                  eq(p.cloudJobs.tenantId, ctx.tenantId),
                  eq(p.cloudJobs.subjectId, ctx.subjectId),
                  eq(p.cloudJobs.fingerprint, fingerprint),
                ),
              )
              .limit(1)
          )[0],
        );
      return { job, created: !!created };
    });
    if (result.job.status !== "queued") return { ...safeJob(result.job), dispatched: false };
    try {
      await this.queue()({
        type: "cloud_diagnostic",
        job_id: result.job.id,
        tenant_id: ctx.tenantId,
        subject_id: ctx.subjectId,
      });
      return { ...safeJob(result.job), dispatched: true };
    } catch {
      return { ...safeJob(result.job), dispatched: false };
    }
  }
  async resume(ctx: PersonalContext, id: string, raw: unknown) {
    this.ensureEnabled();
    const request = z
      .object({ provider_call_cap: z.number().int().min(0).max(20) })
      .strict()
      .parse(raw);
    const job = await withProfileTransaction(this.db, ctx, async (tx) => {
      const row = required(
        (await tx.select().from(p.cloudJobs).where(ownedJob(ctx, id)).limit(1).for("update"))[0],
      );
      const recovery = recoveryDecision(
        row,
        request.provider_call_cap,
        this.options.maxCallsPerJob,
        new Date(),
      );
      if (recovery.error) throw new Error(recovery.error);
      if (recovery.checkProfileBudget) {
        const [budget] = await tx
          .select()
          .from(p.cloudBudgets)
          .where(
            and(
              eq(p.cloudBudgets.tenantId, ctx.tenantId),
              eq(p.cloudBudgets.subjectId, ctx.subjectId),
            ),
          )
          .limit(1);
        if (profileCapExhausted(budget?.callsUsed ?? 0, this.options.profileCallLimit))
          throw new Error("PROFILE_CALL_CAP_EXHAUSTED");
      }
      await this.assertFresh(tx, ctx, PipelineInput.parse(row.input));
      await tx
        .update(p.cloudAttempts)
        .set({ status: "interrupted", completedAt: new Date() })
        .where(and(eq(p.cloudAttempts.jobId, id), eq(p.cloudAttempts.status, "reserved")));
      const [updated] = await tx
        .update(p.cloudJobs)
        .set({
          status: "queued",
          error: null,
          execution: null,
          leaseUntil: null,
          callCap: request.provider_call_cap,
          updatedAt: new Date(),
        })
        .where(ownedJob(ctx, id))
        .returning();
      return required(updated);
    });
    try {
      await this.queue()({
        type: "cloud_diagnostic",
        job_id: id,
        tenant_id: ctx.tenantId,
        subject_id: ctx.subjectId,
      });
      return { ...safeJob(job), dispatched: true };
    } catch {
      return { ...safeJob(job), dispatched: false };
    }
  }
  async cancel(ctx: PersonalContext, id: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const [row] = await tx
        .update(p.cloudJobs)
        .set({
          status: "cancelled",
          execution: null,
          leaseUntil: null,
          error: "USER_CANCELLED",
          updatedAt: new Date(),
        })
        .where(and(ownedJob(ctx, id), sql`${p.cloudJobs.status} in ('queued','running','failed')`))
        .returning();
      return { id, status: row?.status ?? "unchanged", in_flight_request_may_finish: true };
    });
  }
  private async assertFresh(tx: ProfileTransaction, ctx: PersonalContext, input: PipelineInput) {
    const [run] = await tx
      .select()
      .from(d.diagnosticRuns)
      .where(
        and(
          eq(d.diagnosticRuns.id, input.run_id),
          eq(d.diagnosticRuns.tenantId, ctx.tenantId),
          eq(d.diagnosticRuns.subjectId, ctx.subjectId),
        ),
      )
      .limit(1);
    if (!run || run.version !== input.run_version || run.status === "archived")
      throw new Error("SOURCE_CHANGED");
    for (const s of input.sources) {
      const [now] = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(
            eq(c.sourceItems.id, s.id),
            eq(c.sourceItems.tenantId, ctx.tenantId),
            eq(c.sourceItems.subjectId, ctx.subjectId),
          ),
        )
        .limit(1)
        .for("share");
      const [assessment] = await tx
        .select()
        .from(c.sourceAssessments)
        .where(
          and(eq(c.sourceAssessments.sourceItemId, s.id), eq(c.sourceAssessments.isCurrent, true)),
        )
        .limit(1)
        .for("share");
      if (
        !now ||
        now.usageStatus !== "active" ||
        (await cloudSourceHash(now)) !== s.hash ||
        assessment?.version !== s.assessment_version ||
        assessment.eligibility === "excluded"
      )
        throw new Error("SOURCE_CHANGED");
    }
    for (const dependency of input.dependencies) {
      const [run] = await tx
        .select()
        .from(d.diagnosticRuns)
        .where(
          and(
            eq(d.diagnosticRuns.id, dependency.id),
            eq(d.diagnosticRuns.tenantId, ctx.tenantId),
            eq(d.diagnosticRuns.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (
        !run ||
        run.version !== dependency.version ||
        run.headVersion !== dependency.head_version ||
        !(await cloudRunCurrent(tx, ctx, run))
      )
        throw new Error("TOPIC_CHANGED");
    }
  }
  private async checkpoint<T>(
    ctx: PersonalContext,
    job: Job,
    execution: string,
    phase: string,
    system: string,
    input: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    validate: (result: T) => void,
  ): Promise<T> {
    const inputHash = digest(input);
    const parsedInput = PipelineInput.parse(job.input);
    const existing = await withProfileTransaction(this.db, ctx, async (tx) => {
      await this.assertFresh(tx, ctx, parsedInput);
      const rows = await tx
        .select()
        .from(p.cloudAttempts)
        .where(
          and(
            eq(p.cloudAttempts.jobId, job.id),
            eq(p.cloudAttempts.tenantId, ctx.tenantId),
            eq(p.cloudAttempts.subjectId, ctx.subjectId),
            eq(p.cloudAttempts.phase, phase),
            eq(p.cloudAttempts.inputHash, inputHash),
            eq(p.cloudAttempts.status, "ok"),
          ),
        )
        .orderBy(desc(p.cloudAttempts.createdAt))
        .limit(1);
      return rows[0];
    });
    if (existing?.raw) {
      const result = schema.parse(JSON.parse(existing.raw));
      if (digest(result) !== digest(schema.parse(existing.result)))
        throw new Error("CHECKPOINT_CHANGED");
      validate(result);
      return result;
    }
    const id = randomUUID();
    let reserved = false;
    const update = (values: Partial<typeof p.cloudAttempts.$inferInsert>) =>
      withProfileTransaction(this.db, ctx, async (tx) => {
        const [active] = await tx
          .select()
          .from(p.cloudJobs)
          .where(
            and(
              ownedJob(ctx, job.id),
              eq(p.cloudJobs.execution, execution),
              eq(p.cloudJobs.status, "running"),
            ),
          )
          .limit(1);
        if (!active) return;
        await tx
          .update(p.cloudAttempts)
          .set(values)
          .where(and(eq(p.cloudAttempts.id, id), eq(p.cloudAttempts.execution, execution)));
      });
    try {
      const result = await this.ensureEnabled().extract({
        route: "extraction_model",
        strategy: "json_mode",
        text: JSON.stringify(input),
        schema,
        system: `${system}\nRequired JSON schema:\n${JSON.stringify(zodResponseFormat(schema, "result").json_schema.schema)}`,
        controls: {
          retries: 0,
          thinkingMode: "disabled",
          maxOutputTokens: this.options.maxOutputTokens,
          timeoutMs: this.options.timeoutMs,
          observer: {
            beforeAttempt: async (info) => {
              if (reserved || info.attempt !== 1 || info.model !== job.model)
                throw new Error("EXTRA_PROVIDER_CALL_BLOCKED");
              await withProfileTransaction(this.db, ctx, async (tx) => {
                await this.assertFresh(tx, ctx, parsedInput);
                const active = required(
                  (
                    await tx
                      .select()
                      .from(p.cloudJobs)
                      .where(ownedJob(ctx, job.id))
                      .limit(1)
                      .for("update")
                  )[0],
                );
                if (jobReservationBlocked(active, execution))
                  throw new Error("JOB_CALL_CAP_EXHAUSTED");
                await tx
                  .insert(p.cloudBudgets)
                  .values({ ...ctx })
                  .onConflictDoNothing();
                const [budget] = await tx
                  .select()
                  .from(p.cloudBudgets)
                  .where(
                    and(
                      eq(p.cloudBudgets.tenantId, ctx.tenantId),
                      eq(p.cloudBudgets.subjectId, ctx.subjectId),
                    ),
                  )
                  .limit(1)
                  .for("update");
                if (!budget || profileCapExhausted(budget.callsUsed, this.options.profileCallLimit))
                  throw new Error("PROFILE_CALL_CAP_EXHAUSTED");
                await tx
                  .update(p.cloudBudgets)
                  .set({ callsUsed: budget.callsUsed + 1 })
                  .where(
                    and(
                      eq(p.cloudBudgets.tenantId, ctx.tenantId),
                      eq(p.cloudBudgets.subjectId, ctx.subjectId),
                    ),
                  );
                await tx
                  .update(p.cloudJobs)
                  .set({ callsUsed: active.callsUsed + 1, stage: phase, updatedAt: new Date() })
                  .where(ownedJob(ctx, job.id));
                await tx.insert(p.cloudAttempts).values({
                  id,
                  ...ctx,
                  jobId: job.id,
                  phase,
                  execution,
                  inputHash,
                  model: info.model,
                  estimate: { ...info.estimate },
                });
              });
              reserved = true;
            },
            afterAttempt: async (info) => {
              await update({
                usage: info.usage ? { ...info.usage } : null,
                latencyMs: info.latencyMs,
                error: info.errorKind ? `PROVIDER_${info.errorKind.toUpperCase()}` : null,
              });
            },
          },
          captureRawOutput: async (raw) => {
            await update({ raw });
          },
        },
      });
      validate(result);
      await update({
        result: result as Record<string, unknown>,
        status: "ok",
        completedAt: new Date(),
      });
      return result;
    } catch (error) {
      if (reserved)
        await update({ status: "error", error: errorCode(error), completedAt: new Date() }).catch(
          () => undefined,
        );
      throw error;
    }
  }

  /** Invoked only by the authenticated queue consumer, never a public HTTP callback. */
  async consume(message: CloudQueueMessage) {
    this.ensureEnabled();
    const ctx = {
      tenantId: z.string().uuid().parse(message.tenant_id),
      subjectId: z.string().uuid().parse(message.subject_id),
    };
    const execution = randomUUID();
    const job = await withProfileTransaction(this.db, ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(p.cloudJobs)
        .where(ownedJob(ctx, z.string().uuid().parse(message.job_id)))
        .limit(1)
        .for("update");
      if (!row || !claimQueuedJob(row.status)) return null;
      try {
        const input = PipelineInput.parse(row.input);
        await this.assertFresh(tx, ctx, input);
        if (input.policy !== PIPELINE || row.model !== this.model())
          throw new Error("PROCESSING_VERSION_CHANGED");
      } catch (error) {
        const code = errorCode(error);
        if (!invalidatesQueuedJob(code)) throw error;
        // Return normally so the stale transition commits in this same transaction.
        // No claim, attempt reservation, budget update or automatic resend occurs.
        await tx
          .update(p.cloudJobs)
          .set({
            status: "stale",
            error: code,
            execution: null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(ownedJob(ctx, row.id));
        return null;
      }
      const [claimed] = await tx
        .update(p.cloudJobs)
        .set({
          status: "running",
          execution,
          leaseUntil: new Date(Date.now() + 600000),
          updatedAt: new Date(),
        })
        .where(ownedJob(ctx, row.id))
        .returning();
      return required(claimed);
    });
    if (!job) return;
    const input = PipelineInput.parse(job.input);
    try {
      if (input.policy !== PIPELINE || job.model !== this.model())
        throw new Error("PROCESSING_VERSION_CHANGED");
      let facts: Fact[];
      if (Object.keys(input.qualification_jobs).length === input.sources.length) {
        facts = await withProfileTransaction(this.db, ctx, async (tx) => {
          const facts: Fact[] = [];
          for (const source of input.sources) {
            const proof = await qualificationProof(
              tx,
              ctx,
              required(input.qualification_jobs[source.id]),
            );
            const original = proof.input.sources.find((s) => s.id === source.id);
            if (
              !original ||
              proof.input.policy !== input.policy ||
              proof.input.domain !== input.domain ||
              proof.input.question !== input.question ||
              (await requestHash(original)) !== (await requestHash(source))
            )
              throw new Error("SOURCE_CHANGED");
            facts.push(...proof.facts.filter((f) => f.source_id === source.id));
          }
          return facts;
        });
      } else {
        const qinput = cloudQualificationInput(input);
        const qualified = await this.checkpoint(
          ctx,
          job,
          execution,
          "qualification",
          CLOUD_QUALIFICATION_PROMPT,
          qinput,
          UnderstandingQualification,
          (q) => {
            cloudFacts(input, q);
          },
        );
        const qassigned = qualificationAssigned(qinput, qualified);
        await this.checkpoint(
          ctx,
          job,
          execution,
          "qualification_audit",
          CLOUD_QUALIFICATION_AUDIT_PROMPT,
          {
            analysis_input: qinput,
            analysis_input_hash: digest(qinput),
            candidate: qualified,
            assigned: qassigned,
          },
          UnderstandingAudit,
          (a) =>
            validateAudit(
              a,
              digest(qinput),
              qassigned,
              input.sources.map((s) => s.id),
            ),
        );
        facts = cloudFacts(input, qualified);
        await withProfileTransaction(this.db, ctx, async (tx) => {
          await this.assertFresh(tx, ctx, input);
          for (const source of input.sources)
            await tx
              .insert(p.sourceQualifications)
              .values({
                ...ctx,
                sourceId: source.id,
                sourceHash: source.hash,
                assessmentVersion: source.assessment_version,
                rulesHash: QUALIFICATION_HASH,
                jobId: job.id,
                facts: facts.filter((f) => f.source_id === source.id) as unknown as Record<
                  string,
                  unknown
                >[],
              })
              .onConflictDoNothing();
        });
      }
      if (new TextEncoder().encode(JSON.stringify(facts)).length > 128000)
        throw new Error("QUALIFIED_CONTEXT_BOUND_EXCEEDED");
      const selection = {
        domain: input.domain,
        evidence: facts,
        scope: "本次明确选定的来源；不是穷尽的个人画像",
        selected_original_atoms: facts.length,
        canonical_count: new Set(facts.map((f) => f.canonical_id)).size,
      };
      const analysis = {
        task:
          input.domain === "overall" ? "cloud_overall_understanding" : "cloud_domain_understanding",
        question: input.question,
        selection,
        dependencies: input.dependencies,
        explicitly_unavailable_sources: input.omitted_source_ids,
        policy: PIPELINE,
      };
      const report = await this.checkpoint(
        ctx,
        job,
        execution,
        "report",
        input.domain === "overall" ? PROMPTS.overall : PROMPTS.topic,
        analysis,
        UnderstandingReport,
        (r) => validateReport(normalizeReportTimes(r, selection), selection),
      );
      const normalized = normalizeReportTimes(report, selection);
      const assigned = assignReport(normalized, digest(analysis));
      await this.checkpoint(
        ctx,
        job,
        execution,
        "report_audit",
        PROMPTS.audit,
        {
          analysis_input: analysis,
          analysis_input_hash: digest(analysis),
          candidate: normalized,
          assigned,
        },
        UnderstandingAudit,
        (a) =>
          validateAudit(
            a,
            digest(analysis),
            assigned,
            facts.map((f) => f.id),
          ),
      );
      const evidence: CloudEvidenceBinding[] = await withProfileTransaction(
        this.db,
        ctx,
        async (tx) => {
          await this.assertFresh(tx, ctx, input);
          const refs: CloudEvidenceBinding[] = [];
          for (const fact of facts) {
            const source = required(input.sources.find((s) => s.id === fact.source_id));
            const qjob = input.qualification_jobs[source.id] ?? job.id;
            const locator = {
              start: fact.start,
              end: fact.end,
              qualification_job: qjob,
              fact_id: fact.id,
            };
            let [span] = await tx
              .select()
              .from(c.evidenceSpans)
              .where(
                and(
                  eq(c.evidenceSpans.sourceItemId, source.id),
                  sql`${c.evidenceSpans.locator}->>'fact_id' = ${fact.id}`,
                  sql`${c.evidenceSpans.locator}->>'qualification_job' = ${qjob}`,
                ),
              )
              .limit(1);
            if (!span) {
              [span] = await tx
                .insert(c.evidenceSpans)
                .values({
                  sourceItemId: source.id,
                  quote: fact.quote,
                  authorKind: fact.content_author,
                  aboutSubject: fact.about === "self",
                  locator,
                })
                .returning();
            }
            refs.push({
              evidence_id: fact.id,
              source_id: source.id,
              span_id: required(span).id,
              assessment_version: source.assessment_version,
              source_hash: source.hash,
            });
          }
          return refs;
        },
      );
      const candidate = await this.repository.stageReport(
        ctx,
        job.runId,
        {
          expected_version: input.run_version,
          report: normalized,
          evidence,
          input_hash: digest(analysis),
          policy_version: PIPELINE,
          prompt_version: digest(PROMPTS),
          model: job.model,
        },
        job.id,
      );
      await this.repository.acceptProcessed(ctx, job.id, execution, candidate.id, async (tx) => {
        await this.assertFresh(tx, ctx, input);
      });
    } catch (error) {
      const code = errorCode(error);
      const status = processingFailureStatus(code);
      await withProfileTransaction(this.db, ctx, (tx) =>
        tx
          .update(p.cloudJobs)
          .set({ status, error: code, execution: null, leaseUntil: null, updatedAt: new Date() })
          .where(
            and(
              ownedJob(ctx, job.id),
              eq(p.cloudJobs.execution, execution),
              eq(p.cloudJobs.status, "running"),
            ),
          ),
      ).catch(() => undefined);
    }
  }
}
