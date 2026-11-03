import {
  type CoreReportSourceBinding,
  CoreReportTarget,
  type CoreReportTransferInput,
  type UnderstandingAppView,
  type UnderstandingExactEvidence,
  type UnderstandingFeedbackInput,
  type UnderstandingFeedbackReceipt,
  type UnderstandingReportHistory,
  UnderstandingSourceRebind,
  type UnderstandingVersionView,
} from "@findme/core";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-service.js";
import { requestHash } from "./operations.js";

/** Backend-neutral seam. Implementations must scope every call to the authenticated context. */
export interface NativeReportService {
  /** True only when adapter reads, processing and publication verify current Core sources. */
  sourceLifecycle: true;
  validateTarget(ctx: PersonalContext, target: CoreReportTarget): Promise<CoreReportTarget>;
  read(ctx: PersonalContext): Promise<UnderstandingAppView>;
  history(
    ctx: PersonalContext,
    domain: string,
    limit?: number,
  ): Promise<UnderstandingReportHistory>;
  version(ctx: PersonalContext, domain: string, version: string): Promise<UnderstandingVersionView>;
  retireSource(ctx: PersonalContext, input: unknown): Promise<UnderstandingAppView>;
  rebindSource(
    ctx: PersonalContext,
    input: unknown,
    binding: CoreReportSourceBinding,
    note: string,
  ): Promise<UnderstandingAppView>;
  recoverTopic(
    ctx: PersonalContext,
    domain: string,
    version: string,
    recovery?: unknown,
  ): Promise<UnderstandingAppView>;
  evidences(
    ctx: PersonalContext,
    domain: string,
    version: string,
    ids: string[],
  ): Promise<UnderstandingExactEvidence[]>;
  save(ctx: PersonalContext, input: unknown, key: string): Promise<UnderstandingFeedbackReceipt>;
  process(
    ctx: PersonalContext,
    id: string,
    recovery: unknown,
  ): Promise<UnderstandingFeedbackReceipt>;
  processOverall(
    ctx: PersonalContext,
    request: unknown,
    recovery: unknown,
  ): Promise<UnderstandingAppView>;
  saveCore(
    ctx: PersonalContext,
    input: UnderstandingFeedbackInput,
    key: string,
    binding: CoreReportSourceBinding,
  ): Promise<UnderstandingFeedbackReceipt>;
}
export type ReportSource = {
  source_id: string;
  assessment_version: number;
  content_hash: string;
  content: string;
  occurred_at: string | null;
  disclosed_at: string;
  attribution_basis: string;
};
export interface CoreReportBackend {
  target(ctx: PersonalContext, explorationId: string): Promise<CoreReportTarget | null>;
  source(ctx: PersonalContext, explorationId: string, sourceId: string): Promise<ReportSource>;
}
export function requireReportBridge(service?: NativeReportService): NativeReportService {
  if (!service || service.sourceLifecycle !== true)
    throw new CoreError("REPORT_BRIDGE_UNAVAILABLE", 403, "当前服务未启用原生报告探索");
  return service;
}
export function validateReportTarget(
  view: {
    baseline_version: string;
    input_hash: string;
    overall: Pick<UnderstandingAppView["overall"], "version" | "report">;
    topics: Pick<UnderstandingAppView["topics"][number], "domain" | "version" | "report">[];
  },
  raw: unknown,
): CoreReportTarget {
  const target = CoreReportTarget.parse(raw);
  const report =
    target.domain === "overall"
      ? view.overall
      : view.topics.find((t) => t.domain === target.domain);
  if (
    view.baseline_version !== target.baseline_version ||
    view.input_hash !== target.input_hash ||
    !report?.report ||
    report.version !== target.report_version
  )
    throw new CoreError("STALE_REPORT_VERSION", 409, "报告目标已变化，请返回原报告重新选择");
  const objects = [
    report.report.current_understanding,
    ...report.report.findings,
    ...report.report.resources_conditions_costs,
  ].filter((f) => f !== null);
  const finding = target.finding_key
    ? objects.find((f) => f?.key === target.finding_key)
    : undefined;
  if (target.finding_key && !finding)
    throw new CoreError("FINDING_NOT_FOUND", 400, "目标判断不属于这份报告");
  if (
    target.question !== undefined &&
    target.question !== (finding?.text ?? report.report.question?.text)
  )
    throw new CoreError("STALE_EXPLORATION_CONTEXT", 409, "报告问题或判断已经变化");
  return target;
}
/** Stable downstream key survives a lost acknowledgement, different HTTP keys and restarts. */
export async function transferCoreReportSource(
  backend: CoreReportBackend,
  service: NativeReportService | undefined,
  ctx: PersonalContext,
  explorationId: string,
  selected: CoreReportTransferInput,
) {
  const reports = requireReportBridge(service);
  const target = await backend.target(ctx, explorationId);
  if (!target) throw new CoreError("REPORT_TARGET_REQUIRED", 400, "这次探索没有绑定报告目标");
  await reports.validateTarget(ctx, target);
  const source = await backend.source(ctx, explorationId, selected.source_id);
  if (
    source.assessment_version !== selected.assessment_version ||
    source.content_hash !== selected.content_hash
  )
    throw new CoreError("STALE_REPORT_SOURCE", 409, "原始输入已变化，请重新读取");
  if (!source.content.trim() || source.content.length > 2400)
    throw new CoreError(
      "FEEDBACK_INPUT_BOUND_EXCEEDED",
      422,
      "所选原话超过报告回应上限，不能截断回传",
    );
  const binding: CoreReportSourceBinding = {
    tenant_id: ctx.tenantId,
    subject_id: ctx.subjectId,
    exploration_id: explorationId,
    source_id: source.source_id,
    assessment_version: source.assessment_version,
    content_hash: source.content_hash,
    occurred_at: source.occurred_at,
    disclosed_at: source.disclosed_at,
    attribution_basis: source.attribution_basis,
  };
  const key = `core-report:${await requestHash([ctx, target, binding])}`;
  return reports.saveCore(
    ctx,
    {
      baseline_version: target.baseline_version,
      input_hash: target.input_hash,
      domain: target.domain,
      report_version: target.report_version,
      ...(target.finding_key ? { finding_key: target.finding_key } : {}),
      ...(target.question ? { context: { question: target.question } } : {}),
      type: "supplement",
      note: source.content,
    },
    key,
    binding,
  );
}

/** Fetch immutable replacement and check owner/report server-side; no client text or binding. */
export async function rebindCoreReportSource(
  backend: CoreReportBackend,
  service: NativeReportService | undefined,
  ctx: PersonalContext,
  raw: unknown,
) {
  const request = UnderstandingSourceRebind.parse(raw);
  const reports = requireReportBridge(service);
  // The adapter also checks the latest exact report target under its state lock.
  const source = await backend.source(ctx, request.exploration_id, request.new_source_id);
  return reports.rebindSource(
    ctx,
    request,
    {
      tenant_id: ctx.tenantId,
      subject_id: ctx.subjectId,
      exploration_id: request.exploration_id,
      source_id: source.source_id,
      assessment_version: source.assessment_version,
      content_hash: source.content_hash,
      occurred_at: source.occurred_at,
      disclosed_at: source.disclosed_at,
      attribution_basis: source.attribution_basis,
    },
    source.content,
  );
}
