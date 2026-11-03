import { UnderstandingReport } from "@findme/core";
import { type Db, platformSchema as platform, diagnosticSchema as tables } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { evidenceFor, reference } from "./evidence.js";
import { PipelineInput } from "./provenance.js";
import { runFor } from "./repository-state.js";
import { type ProfileTransaction, withProfileTransaction } from "./scope.js";
const runs = tables.diagnosticRuns;
const reports = tables.diagnosticReportRevisions;
const dependencies = tables.diagnosticReportSources;
const responses = tables.diagnosticResponses;
const importBatches = platform.importBatches;
/** Read-only invalidation: a topic correction blocks its dependent overall immediately,
 * without generating work or waiting for a replacement topic to be published. */
async function reportTopicsCurrent(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  run: typeof runs.$inferSelect,
  report: typeof reports.$inferSelect,
): Promise<boolean> {
  if (run.domain !== "overall" || !report.jobId) return true;
  const [job] = await tx
    .select()
    .from(platform.cloudJobs)
    .where(
      and(
        eq(platform.cloudJobs.id, report.jobId),
        eq(platform.cloudJobs.tenantId, ctx.tenantId),
        eq(platform.cloudJobs.subjectId, ctx.subjectId),
        eq(platform.cloudJobs.runId, run.id),
      ),
    )
    .limit(1);
  const snapshot = PipelineInput.safeParse(job?.input);
  if (!snapshot.success || !snapshot.data.dependencies.length) return false;
  for (const dependency of snapshot.data.dependencies) {
    const [topic] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, dependency.id),
          eq(runs.tenantId, ctx.tenantId),
          eq(runs.subjectId, ctx.subjectId),
        ),
      )
      .limit(1);
    if (
      !topic ||
      topic.domain === "overall" ||
      topic.status !== "ready" ||
      topic.version !== dependency.version ||
      topic.headVersion !== dependency.head_version ||
      !(await cloudRunCurrent(tx, ctx, topic))
    )
      return false;
  }
  return true;
}
/** The same effective-current predicate is used by reading and explicit processing.
 * It only observes validity; callers keep ownership of status transitions. */
export async function cloudReportCurrent(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  run: typeof runs.$inferSelect,
  report: typeof reports.$inferSelect,
): Promise<boolean> {
  if (report.status !== "accepted") return false;
  if (!(await reportTopicsCurrent(tx, ctx, run, report))) return false;
  const refs = await tx
    .select()
    .from(dependencies)
    .where(
      and(
        eq(dependencies.reportRevisionId, report.id),
        eq(dependencies.tenantId, ctx.tenantId),
        eq(dependencies.subjectId, ctx.subjectId),
      ),
    );
  try {
    for (const ref of refs) await evidenceFor(tx, ctx, reference(ref));
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "DIAGNOSTIC_SOURCE_STALE") throw error;
    return false;
  }
  return true;
}
export async function cloudRunCurrent(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  run: typeof runs.$inferSelect,
): Promise<boolean> {
  if (run.status !== "ready") return false;
  const [head] = await tx
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.runId, run.id),
        eq(reports.tenantId, ctx.tenantId),
        eq(reports.subjectId, ctx.subjectId),
        eq(reports.version, run.headVersion),
      ),
    )
    .limit(1);
  return !!head && cloudReportCurrent(tx, ctx, run, head);
}
export function runView(run: typeof runs.$inferSelect) {
  return {
    id: run.id,
    domain: run.domain,
    question: run.question,
    status: run.status,
    version: run.version,
    head_version: run.headVersion,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  };
}
async function importedReportOrigin(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  run: typeof runs.$inferSelect,
  revision: typeof reports.$inferSelect | undefined,
) {
  if (!revision || revision.version !== 1 || revision.jobId !== null) return null;
  const match = /^u2-approved:([a-f0-9]{64}):([a-z][a-z0-9_]{0,63}):([^:]+)$/.exec(
    run.idempotencyKey,
  );
  const [, archiveHash, domain, version] = match ?? [];
  if (!archiveHash || !domain || !version) return null;
  const batches = await tx
    .select()
    .from(importBatches)
    .where(
      and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.subjectId, ctx.subjectId)),
    );
  const batch = batches.find((candidate) => {
    const payload = candidate.payload as Record<string, unknown>;
    if (
      candidate.status !== "committed" ||
      payload.kind !== "u2-approved-report-import@1" ||
      payload.redacted === true
    )
      return false;
    if (payload.source_archive_hash !== archiveHash) return false;
    const items = Array.isArray(payload.reports)
      ? (payload.reports as Record<string, unknown>[])
      : [];
    const result = candidate.result as Record<string, unknown> | null;
    return (
      items.some((item) => item.domain === domain && item.version === version) &&
      Array.isArray(result?.imported) &&
      (result.imported as Record<string, unknown>[]).some(
        (item) => item.run_id === run.id && item.report_revision_id === revision.id,
      )
    );
  });
  if (!batch) {
    const redacted = batches.find((candidate) => {
      const payload = candidate.payload as Record<string, unknown>;
      const result = candidate.result as Record<string, unknown> | null;
      if (
        candidate.status !== "redacted" ||
        payload.kind !== "u2-approved-report-import@1" ||
        !Array.isArray(result?.imported)
      )
        return false;
      return (result.imported as Record<string, unknown>[]).some(
        (item) =>
          item.run_id === run.id &&
          item.report_revision_id === revision.id &&
          item.domain === domain &&
          item.version === version,
      );
    });
    return {
      kind: "u2_approved_import",
      source_archive_hash: archiveHash,
      report_version: version,
      provenance_available: false,
      ...(redacted ? { redacted: true } : {}),
    };
  }
  const payload = batch.payload as Record<string, unknown>;
  const items = Array.isArray(payload.reports)
    ? (payload.reports as Record<string, unknown>[])
    : [];
  const item = items.find((x) => x.domain === domain && x.version === version);
  if (!item) return { kind: "u2_approved_import", provenance_available: false };
  const source = item.audit_provenance as Record<string, unknown> | undefined;
  const auditProvenance = source
    ? Object.fromEntries(
        [
          "baseline_version",
          "baseline_hash",
          "topic_hash",
          "input_hash",
          "policy",
          "policy_hash",
          "model",
          "topic_version",
          "report_hash",
          "audit_hash",
          "audit_raw_replay",
        ]
          .filter((key) => key in source)
          .map((key) => [key, source[key]]),
      )
    : null;
  return {
    kind: "u2_approved_import",
    source_archive_hash: payload.source_archive_hash,
    source_fingerprint: payload.source_fingerprint,
    report_version: item.version,
    report_hash: item.report_hash,
    audit_hash: item.audit_hash,
    audit: item.audit,
    audit_provenance: auditProvenance,
    audit_raw_replay: false,
    provenance_available: true,
  };
}

export async function readReport(db: Db, ctx: PersonalContext, id: string) {
  return withProfileTransaction(db, ctx, async (tx) => {
    const run = await runFor(tx, ctx, id);
    const [head] = await tx
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.tenantId, ctx.tenantId),
          eq(reports.subjectId, ctx.subjectId),
          eq(reports.runId, id),
          eq(reports.version, run.headVersion),
        ),
      )
      .limit(1);
    const visible = {
      ...runView(run),
      report: null as UnderstandingReport | null,
      report_revision_id: head?.id ?? null,
      report_status: head?.status ?? "unavailable",
      report_origin: await importedReportOrigin(tx, ctx, run, head),
    };
    if (!head || head.status !== "accepted" || run.status !== "ready") return visible;
    if (!(await cloudReportCurrent(tx, ctx, run, head)))
      return { ...visible, status: "needs_review", report_status: "needs_review" };
    if ((await requestHash(head.body)) !== head.contentHash)
      throw new Error("REPORT_CONTENT_CHANGED");
    return { ...visible, report: UnderstandingReport.parse(head.body) };
  });
}
export async function readEvidence(
  db: Db,
  ctx: PersonalContext,
  runId: string,
  evidenceId: string,
) {
  return withProfileTransaction(db, ctx, async (tx) => {
    const run = await runFor(tx, ctx, runId);
    const [head] = await tx
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.tenantId, ctx.tenantId),
          eq(reports.subjectId, ctx.subjectId),
          eq(reports.runId, runId),
          eq(reports.version, run.headVersion),
          eq(reports.status, "accepted"),
        ),
      )
      .limit(1);
    if (!head || run.status !== "ready")
      throw new CoreError("DIAGNOSTIC_NOT_FOUND", 404, "当前没有可读报告依据");
    if (!(await reportTopicsCurrent(tx, ctx, run, head)))
      throw new CoreError("DIAGNOSTIC_SOURCE_STALE", 409, "专题依据待复核");
    const refs = await tx
      .select()
      .from(dependencies)
      .where(
        and(
          eq(dependencies.reportRevisionId, head.id),
          eq(dependencies.tenantId, ctx.tenantId),
          eq(dependencies.subjectId, ctx.subjectId),
        ),
      );
    const resolved = [];
    for (const ref of refs) resolved.push(await evidenceFor(tx, ctx, reference(ref)));
    const result = resolved.find((item) => item.evidence_id === evidenceId);
    if (!result) throw new CoreError("NOT_FOUND", 404, "依据不属于这份报告");
    return result;
  });
}
export async function readHistory(db: Db, ctx: PersonalContext, runId: string) {
  return withProfileTransaction(db, ctx, async (tx) => {
    await runFor(tx, ctx, runId);
    const versions = await tx
      .select({
        id: reports.id,
        version: reports.version,
        status: reports.status,
        created_at: reports.createdAt,
        model: reports.model,
      })
      .from(reports)
      .where(
        and(
          eq(reports.tenantId, ctx.tenantId),
          eq(reports.subjectId, ctx.subjectId),
          eq(reports.runId, runId),
        ),
      )
      .orderBy(desc(reports.version))
      .limit(100);
    return versions;
  });
}
export async function readVersion(db: Db, ctx: PersonalContext, runId: string, version: number) {
  return withProfileTransaction(db, ctx, async (tx) => {
    const run = await runFor(tx, ctx, runId);
    const [row] = await tx
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.tenantId, ctx.tenantId),
          eq(reports.subjectId, ctx.subjectId),
          eq(reports.runId, runId),
          eq(reports.version, version),
        ),
      )
      .limit(1);
    if (!row) throw new CoreError("NOT_FOUND", 404, "报告版本不存在");
    if (row.status !== "accepted") return { id: row.id, version, status: row.status, report: null };
    const refs = await tx
      .select()
      .from(dependencies)
      .where(eq(dependencies.reportRevisionId, row.id));
    try {
      for (const ref of refs) await evidenceFor(tx, ctx, reference(ref));
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== "DIAGNOSTIC_SOURCE_STALE") throw error;
      return { id: row.id, version, status: "needs_review", report: null };
    }
    if ((await requestHash(row.body)) !== row.contentHash)
      throw new Error("REPORT_CONTENT_CHANGED");
    return {
      id: row.id,
      version,
      status: row.status,
      current: run.headVersion === version,
      report: UnderstandingReport.parse(row.body),
      report_origin: await importedReportOrigin(tx, ctx, run, row),
    };
  });
}
export async function readResponses(db: Db, ctx: PersonalContext, runId: string) {
  return withProfileTransaction(db, ctx, async (tx) => {
    await runFor(tx, ctx, runId);
    return tx
      .select({
        id: responses.id,
        kind: responses.kind,
        note: responses.note,
        processing_status: responses.processingStatus,
        source_id: responses.sourceId,
        created_at: responses.createdAt,
      })
      .from(responses)
      .where(
        and(
          eq(responses.tenantId, ctx.tenantId),
          eq(responses.subjectId, ctx.subjectId),
          eq(responses.runId, runId),
        ),
      )
      .orderBy(desc(responses.createdAt))
      .limit(100);
  });
}
