import { UnderstandingReport } from "@findme/core";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { digest } from "../shared/primitives.js";
import type { UnderstandingRuntimeSnapshot } from "../understanding-app/archive-runtime.js";
import type { ArchiveUnderstandingRuntime } from "../understanding-app/archive-runtime.js";
import { cloudSourceHash } from "./repository.js";
import { type ProfileTransaction, withProfileTransaction } from "./scope.js";

const IMPORT_KIND = "u2-approved-report-import@1";
const REPORTS = d.diagnosticReportRevisions;
const RUNS = d.diagnosticRuns;
const REFS = d.diagnosticReportSources;
const BATCHES = p.importBatches;
type ExactEvidence = UnderstandingRuntimeSnapshot["versions"][number]["evidence"][number];
type ImportPayload = {
  kind: typeof IMPORT_KIND;
  format: "u2-approved-report-import-payload@1";
  source_archive_hash: string;
  source_fingerprint: string;
  snapshot_hash: string;
  reports: {
    domain: string;
    version: string;
    report: unknown;
    report_hash: string;
    audit: unknown;
    audit_hash: string;
    audit_provenance: Record<string, unknown>;
    evidence: ExactEvidence[];
  }[];
  confirmed?: { at: string; hash: string };
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("U2_IMPORT_WRITE_FAILED");
  return value;
}
async function sourceIdentity(payload: ImportPayload, e: ExactEvidence) {
  return requestHash({
    source_archive_hash: payload.source_archive_hash,
    original_source_id: e.source_id,
    original_start: e.start,
    original_end: e.end,
    quote: e.quote,
    author: e.author,
  });
}
function sourceRef(ctx: PersonalContext, payload: ImportPayload, identity: string) {
  return `u2:${ctx.tenantId}:${ctx.subjectId}:${payload.source_archive_hash}:${identity}`;
}
function importRequestKey(payload: ImportPayload, report: ImportPayload["reports"][number]) {
  return `u2-approved:${payload.source_archive_hash}:${report.domain}:${report.version}`;
}
function safeDomain(domain: string) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(domain) && domain !== "overall";
}

/** One-shot importer for the pinned U2 runtime. It never accepts a client-supplied report. */
export class U2ApprovedImportService {
  constructor(
    private readonly db: Db,
    private readonly archive: ArchiveUnderstandingRuntime,
  ) {}

  private async frozenPayload(ctx: PersonalContext): Promise<ImportPayload> {
    const snapshot = await this.archive.snapshot(ctx);
    const accepted = snapshot.versions
      .filter((v) => v.domain !== "overall" && v.view.status === "accepted")
      .sort((a, b) => a.domain.localeCompare(b.domain));
    if (
      !accepted.length ||
      accepted.length !== snapshot.view.topics.filter((t) => t.status === "ready").length
    )
      throw new CoreError("U2_APPROVED_SET_MISMATCH", 409, "归档已审核专题集合不一致");
    const reports: ImportPayload["reports"] = [];
    for (const entry of accepted) {
      if (!safeDomain(entry.domain) || !entry.view.report)
        throw new CoreError("U2_TOPIC_INVALID", 409, "归档专题不可导入");
      const report = UnderstandingReport.parse(entry.view.report);
      const auditProvenance = await this.archive.approvedTopicProvenance(
        ctx,
        entry.domain,
        entry.view.version,
      );
      reports.push({
        domain: entry.domain,
        version: entry.view.version,
        report,
        report_hash: await requestHash(report),
        audit: auditProvenance.audit,
        audit_hash: auditProvenance.audit_hash,
        audit_provenance: { ...auditProvenance, report_hash: await requestHash(report) },
        evidence: entry.evidence,
      });
    }
    const payload: ImportPayload = {
      kind: IMPORT_KIND,
      format: "u2-approved-report-import-payload@1",
      source_archive_hash: snapshot.source_archive_hash,
      source_fingerprint: snapshot.view.scope.source_fingerprint,
      snapshot_hash: digest(snapshot),
      reports,
    };
    if (!/^[a-f0-9]{64}$/.test(payload.source_fingerprint))
      throw new CoreError("U2_SOURCE_FINGERPRINT_INVALID", 409, "归档来源指纹不可用");
    return payload;
  }

  async preview(ctx: PersonalContext) {
    const payload = await this.frozenPayload(ctx);
    const inputHash = await requestHash(payload);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const [created] = await tx
        .insert(BATCHES)
        .values({ ...ctx, inputHash, status: "preview", payload, result: null })
        .onConflictDoNothing()
        .returning();
      const row =
        created ??
        required(
          (
            await tx
              .select()
              .from(BATCHES)
              .where(
                and(
                  eq(BATCHES.tenantId, ctx.tenantId),
                  eq(BATCHES.subjectId, ctx.subjectId),
                  eq(BATCHES.inputHash, inputHash),
                ),
              )
              .limit(1)
          )[0],
        );
      const stored = row.payload as unknown as ImportPayload;
      if (
        stored.kind !== IMPORT_KIND ||
        stored.snapshot_hash !== payload.snapshot_hash ||
        row.status === "redacted"
      )
        throw new CoreError("U2_IMPORT_PREVIEW_CONFLICT", 409, "已有导入预览与固定归档不一致");
      return {
        id: row.id,
        input_hash: row.inputHash,
        status: row.status,
        source_archive_hash: payload.source_archive_hash,
        source_fingerprint: payload.source_fingerprint,
        reports: payload.reports.map((r) => ({
          domain: r.domain,
          version: r.version,
          report_hash: r.report_hash,
          audit_hash: r.audit_hash,
          evidence_count: r.evidence.length,
        })),
        overall_excluded: true,
        requires_confirmation: row.status === "preview",
      };
    });
  }

  async confirm(ctx: PersonalContext, id: string, inputHash: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const row = await this.batchFor(tx, ctx, id);
      await this.verifyBatch(row, inputHash);
      if (row.status === "committed") return { id, status: row.status, input_hash: row.inputHash };
      if (row.status === "confirmed") return { id, status: row.status, input_hash: row.inputHash };
      if (row.status !== "preview")
        throw new CoreError("U2_IMPORT_NOT_CONFIRMABLE", 409, "导入预览不可确认");
      const payload = row.payload as unknown as ImportPayload;
      await tx
        .update(BATCHES)
        .set({
          status: "confirmed",
          payload: { ...payload, confirmed: { at: new Date().toISOString(), hash: inputHash } },
        })
        .where(eq(BATCHES.id, id));
      return { id, status: "confirmed", input_hash: inputHash };
    });
  }

  async commit(ctx: PersonalContext, id: string, inputHash: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const batch = await this.batchFor(tx, ctx, id);
      await this.verifyBatch(batch, inputHash);
      if (batch.status === "committed") return batch.result;
      if (batch.status !== "confirmed")
        throw new CoreError("U2_IMPORT_CONFIRMATION_REQUIRED", 409, "请先确认本次固定导入");
      const payload = batch.payload as unknown as ImportPayload;
      if (payload.confirmed?.hash !== inputHash)
        throw new CoreError("U2_IMPORT_CONFIRMATION_STALE", 409, "导入确认与预览不一致");
      const imported = [];
      for (const report of payload.reports) {
        const runKey = importRequestKey(payload, report);
        const runHash = await requestHash({
          kind: IMPORT_KIND,
          input_hash: inputHash,
          domain: report.domain,
          version: report.version,
          report_hash: report.report_hash,
        });
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
          ${JSON.stringify([ctx.tenantId, ctx.subjectId, runKey])}, 0))`);
        let [run] = await tx
          .select()
          .from(RUNS)
          .where(
            and(
              eq(RUNS.tenantId, ctx.tenantId),
              eq(RUNS.subjectId, ctx.subjectId),
              eq(RUNS.idempotencyKey, runKey),
            ),
          )
          .limit(1)
          .for("update");
        if (run) {
          if (
            run.requestHash !== runHash ||
            run.domain !== report.domain ||
            run.status !== "ready" ||
            run.headVersion !== 1
          )
            throw new CoreError("U2_IMPORT_RUN_CONFLICT", 409, "专题已存在不同导入版本");
        } else {
          run = required(
            (
              await tx
                .insert(RUNS)
                .values({
                  ...ctx,
                  domain: report.domain,
                  question: `U2 已审核专题：${report.domain}`,
                  status: "ready",
                  version: 1,
                  headVersion: 1,
                  idempotencyKey: runKey,
                  requestHash: runHash,
                })
                .returning()
            )[0],
          );
        }
        let [revision] = await tx
          .select()
          .from(REPORTS)
          .where(
            and(
              eq(REPORTS.tenantId, ctx.tenantId),
              eq(REPORTS.subjectId, ctx.subjectId),
              eq(REPORTS.runId, run.id),
              eq(REPORTS.version, 1),
            ),
          )
          .limit(1)
          .for("update");
        if (revision) {
          if (revision.contentHash !== report.report_hash || revision.status !== "accepted")
            throw new CoreError("U2_IMPORT_REPORT_CONFLICT", 409, "已存在报告与导入内容不一致");
        } else {
          revision = required(
            (
              await tx
                .insert(REPORTS)
                .values({
                  ...ctx,
                  runId: run.id,
                  version: 1,
                  basisVersion: 1,
                  jobId: null,
                  status: "accepted",
                  format: "understanding-report@1",
                  body: report.report as Record<string, unknown>,
                  contentHash: report.report_hash,
                  inputHash: report.audit_provenance.input_hash as string,
                  policyVersion: `u2-import:${String(report.audit_provenance.policy)}`,
                  promptVersion: `u2-prompt-hash:${String(report.audit_provenance.policy_hash)}`,
                  model: String(report.audit_provenance.model),
                })
                .returning()
            )[0],
          );
        }
        const refs = [];
        const body = report.report as {
          current_understanding: {
            evidence_ids: string[];
            counterevidence_ids: string[];
            context_ids: string[];
          } | null;
          findings: {
            evidence_ids: string[];
            counterevidence_ids: string[];
            context_ids: string[];
          }[];
          resources_conditions_costs: {
            evidence_ids: string[];
            counterevidence_ids: string[];
            context_ids: string[];
          }[];
          nodes: { evidence_ids: string[] }[];
          links: { evidence_ids: string[] }[];
        };
        const referenced = new Set([
          ...(body.current_understanding
            ? [
                ...body.current_understanding.evidence_ids,
                ...body.current_understanding.counterevidence_ids,
                ...body.current_understanding.context_ids,
              ]
            : []),
          ...body.findings.flatMap((x) => [
            ...x.evidence_ids,
            ...x.counterevidence_ids,
            ...x.context_ids,
          ]),
          ...body.resources_conditions_costs.flatMap((x) => [
            ...x.evidence_ids,
            ...x.counterevidence_ids,
            ...x.context_ids,
          ]),
          ...body.nodes.flatMap((x) => x.evidence_ids),
          ...body.links.flatMap((x) => x.evidence_ids),
        ]);
        for (const evidence of report.evidence) {
          if (!referenced.has(evidence.id)) continue;
          if (
            evidence.end - evidence.start !== evidence.quote.length ||
            evidence.offset_unit !== "utf16"
          )
            throw new CoreError("U2_IMPORT_EVIDENCE_INVALID", 409, "归档证据原始定位无效");
          const identity = await sourceIdentity(payload, evidence);
          const externalRef = sourceRef(ctx, payload, identity);
          const sourceHash = await requestHash({
            quote: evidence.quote,
            source_id: evidence.source_id,
            source_ids: evidence.source_ids,
            session_id: evidence.session_id,
            message_id: evidence.message_id,
            start: evidence.start,
            end: evidence.end,
            author: evidence.author,
          });
          const evidenceHash = await requestHash({
            source_identity: identity,
            evidence_id: evidence.id,
            author: evidence.author,
            about: evidence.about,
            stance: evidence.stance,
            qualifier: evidence.qualifier,
            scope: evidence.scope,
            report_time: evidence.report_time,
            source_ids: evidence.source_ids,
            session_id: evidence.session_id,
            message_id: evidence.message_id,
          });
          let [source] = await tx
            .select()
            .from(c.sourceItems)
            .where(
              and(
                eq(c.sourceItems.tenantId, ctx.tenantId),
                eq(c.sourceItems.subjectId, ctx.subjectId),
                eq(c.sourceItems.externalRef, externalRef),
              ),
            )
            .limit(1)
            .for("update");
          if (source) {
            if (
              source.sourceMeta?.u2_import_hash !== sourceHash ||
              source.usageStatus === "deleted"
            )
              throw new CoreError("U2_IMPORT_SOURCE_CONFLICT", 409, "已有来源与固定证据不一致");
          } else {
            source = required(
              (
                await tx
                  .insert(c.sourceItems)
                  .values({
                    ...ctx,
                    sourceKind: "u2_quote_excerpt",
                    authorKind: evidence.author,
                    content: evidence.quote,
                    occurredAt: null,
                    externalRef,
                    sourceMeta: {
                      import_kind: IMPORT_KIND,
                      import_hash: sourceHash,
                      u2_import_hash: sourceHash,
                      u2_evidence_identity: identity,
                      import_batch: batch.id,
                      source_archive_hash: payload.source_archive_hash,
                      source_fingerprint: payload.source_fingerprint,
                      content_scope: "quote_excerpt",
                      original_source_id: evidence.source_id,
                      original_source_ids: evidence.source_ids,
                      original_session_id: evidence.session_id,
                      original_message_id: evidence.message_id,
                      original_author: evidence.author,
                    },
                    usageStatus: "active",
                  })
                  .returning()
              )[0],
            );
            const [assessment] = await tx
              .insert(c.sourceAssessments)
              .values({
                sourceItemId: source.id,
                version: 1,
                attributionStatus: "ambiguous",
                contextCompleteness: "unknown",
                temporalPrecision: "unknown",
                eligibility: "context_only",
                rationale:
                  "仅保留 U2 审核报告引用的 quote 摘录；原始全文未归档，不可作为完整原文复评。",
              })
              .returning();
            if (!assessment) throw new Error("U2_IMPORT_ASSESSMENT_WRITE_FAILED");
          }
          const spans = await tx
            .select()
            .from(c.evidenceSpans)
            .where(eq(c.evidenceSpans.sourceItemId, source.id));
          let span = spans.find((item) => item.locator?.u2_evidence_hash === evidenceHash);
          if (!span) {
            span = required(
              (
                await tx
                  .insert(c.evidenceSpans)
                  .values({
                    sourceItemId: source.id,
                    quote: evidence.quote,
                    locator: {
                      u2_evidence_hash: evidenceHash,
                      content_scope: "quote_excerpt",
                      stored_start: 0,
                      stored_end: evidence.quote.length,
                      original_start: evidence.start,
                      original_end: evidence.end,
                      offset_unit: "utf16",
                      original_source_id: evidence.source_id,
                      original_source_ids: evidence.source_ids,
                      original_session_id: evidence.session_id,
                      original_message_id: evidence.message_id,
                      qualifier: evidence.qualifier,
                      original_author: evidence.author,
                      original_about: evidence.about,
                      original_stance: evidence.stance,
                      original_report_time: evidence.report_time,
                      original_scope: evidence.scope,
                      source_archive_hash: payload.source_archive_hash,
                    },
                    authorKind: evidence.author,
                    aboutSubject: evidence.about === "self" || evidence.about === "subject",
                  })
                  .returning()
              )[0],
            );
          }
          const [assessment] = await tx
            .select()
            .from(c.sourceAssessments)
            .where(
              and(
                eq(c.sourceAssessments.sourceItemId, source.id),
                eq(c.sourceAssessments.isCurrent, true),
              ),
            )
            .limit(1);
          if (!span || !assessment) throw new Error("U2_IMPORT_SOURCE_INTEGRITY");
          refs.push({ evidence, source, span, assessment });
        }
        for (const { evidence, source, span, assessment } of refs) {
          const [existingRef] = await tx
            .select()
            .from(REFS)
            .where(and(eq(REFS.reportRevisionId, revision.id), eq(REFS.evidenceId, evidence.id)))
            .limit(1);
          if (existingRef) {
            if (existingRef.sourceId !== source.id || existingRef.spanId !== span.id)
              throw new CoreError(
                "U2_IMPORT_REFERENCE_CONFLICT",
                409,
                "已存在报告依据与导入不一致",
              );
          } else {
            await tx.insert(REFS).values({
              ...ctx,
              reportRevisionId: revision.id,
              evidenceId: evidence.id,
              sourceId: source.id,
              spanId: span.id,
              assessmentVersion: assessment.version,
              sourceHash: await cloudSourceHash(source),
            });
          }
        }
        imported.push({
          domain: report.domain,
          run_id: run.id,
          report_revision_id: revision.id,
          version: report.version,
          evidences: refs.length,
        });
      }
      const result = {
        id: batch.id,
        status: "committed",
        input_hash: batch.inputHash,
        source_archive_hash: payload.source_archive_hash,
        source_fingerprint: payload.source_fingerprint,
        imported,
        overall_excluded: true,
        model_calls: 0,
      };
      await tx
        .update(BATCHES)
        .set({ status: "committed", result, committedAt: new Date() })
        .where(eq(BATCHES.id, id));
      return result;
    });
  }

  private async batchFor(tx: ProfileTransaction, ctx: PersonalContext, id: string) {
    const [row] = await tx
      .select()
      .from(BATCHES)
      .where(
        and(
          eq(BATCHES.id, id),
          eq(BATCHES.tenantId, ctx.tenantId),
          eq(BATCHES.subjectId, ctx.subjectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row || (row.payload as Record<string, unknown>).kind !== IMPORT_KIND)
      throw new CoreError("U2_IMPORT_NOT_FOUND", 404, "导入预览不存在");
    return row;
  }

  private async verifyBatch(row: typeof BATCHES.$inferSelect, expectedHash: string) {
    const { confirmed: _confirmation, ...frozen } = row.payload as unknown as ImportPayload;
    if (row.inputHash !== expectedHash || (await requestHash(frozen)) !== row.inputHash)
      throw new CoreError("U2_IMPORT_PREVIEW_STALE", 409, "导入预览已变化");
  }
}
