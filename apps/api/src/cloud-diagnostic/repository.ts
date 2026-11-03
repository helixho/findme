import { CloudDiagnosticCreate, CloudReportCandidate } from "@findme/core";
import { type Db, diagnosticSchema as tables } from "@findme/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { evidenceFor } from "./evidence.js";
import { acceptProcessedReport } from "./publication.js";
import {
  readEvidence,
  readHistory,
  readReport,
  readResponses,
  readVersion,
  runView,
} from "./report-reading.js";
import { currentVersion, key, required, runFor, sameRequest } from "./repository-state.js";
import { recordResponse } from "./response-intake.js";
import { type ProfileTransaction, withProfileTransaction } from "./scope.js";
export { cloudSourceHash } from "./evidence.js";
export { cloudReportCurrent, cloudRunCurrent } from "./report-reading.js";
const runs = tables.diagnosticRuns;
const reports = tables.diagnosticReportRevisions;
const dependencies = tables.diagnosticReportSources;
/** Postgres facade. Each operation owns the same transaction boundary as before. */
export class CloudDiagnosticRepository {
  constructor(private readonly db: Db) {}
  async list(ctx: PersonalContext, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("INVALID_LIMIT");
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.tenantId, ctx.tenantId), eq(runs.subjectId, ctx.subjectId)))
        .orderBy(desc(runs.updatedAt), desc(runs.id))
        .limit(limit);
      return rows.map(runView);
    });
  }
  async create(ctx: PersonalContext, raw: unknown, idempotencyKey: string) {
    const input = CloudDiagnosticCreate.parse(raw);
    const idKey = key(idempotencyKey);
    const hash = await requestHash(input);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([ctx.tenantId, ctx.subjectId, "diagnostic-create", idKey])}, 0))`);
      const [existing] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.tenantId, ctx.tenantId),
            eq(runs.subjectId, ctx.subjectId),
            eq(runs.idempotencyKey, idKey),
          ),
        )
        .limit(1);
      if (existing) {
        sameRequest(existing.requestHash, hash);
        return runView(existing);
      }
      const [run] = await tx
        .insert(runs)
        .values({ ...ctx, ...input, idempotencyKey: idKey, requestHash: hash })
        .returning();
      return runView(required(run));
    });
  }
  async read(ctx: PersonalContext, id: string) {
    return readReport(this.db, ctx, id);
  }
  async evidence(ctx: PersonalContext, runId: string, evidenceId: string) {
    return readEvidence(this.db, ctx, runId, evidenceId);
  }
  async respond(ctx: PersonalContext, runId: string, raw: unknown, idempotencyKey: string) {
    return recordResponse(this.db, ctx, runId, raw, idempotencyKey);
  }
  /** Internal candidate landing point; does not accept a report or advance the head. */
  async stageReport(ctx: PersonalContext, runId: string, raw: unknown, jobId?: string) {
    const input = CloudReportCandidate.parse(raw);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const run = await runFor(tx, ctx, runId);
      currentVersion(run, input.expected_version);
      if (jobId) {
        const [existing] = await tx
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.tenantId, ctx.tenantId),
              eq(reports.subjectId, ctx.subjectId),
              eq(reports.runId, runId),
              eq(reports.jobId, jobId),
            ),
          )
          .limit(1);
        if (existing) {
          if (
            existing.contentHash !== (await requestHash(input.report)) ||
            existing.inputHash !== input.input_hash
          )
            throw new Error("CANDIDATE_IDEMPOTENCY_CONFLICT");
          return {
            id: existing.id,
            version: existing.version,
            status: existing.status,
            published: existing.status === "accepted",
          };
        }
      }
      const refs = new Map<string, Awaited<ReturnType<typeof evidenceFor>>>();
      for (const ref of input.evidence) refs.set(ref.evidence_id, await evidenceFor(tx, ctx, ref));
      const objects = [
        input.report.current_understanding,
        ...input.report.findings,
        ...input.report.resources_conditions_costs,
        ...input.report.nodes,
        ...input.report.links,
      ].filter((item) => item !== null);
      if (new Set(objects.map((o) => o.key)).size !== objects.length)
        throw new Error("REPORT_KEY_DUPLICATE");
      for (const object of objects) {
        const basis = [
          ...object.evidence_ids,
          ...("counterevidence_ids" in object ? object.counterevidence_ids : []),
        ];
        const all = [...basis, ...("context_ids" in object ? object.context_ids : [])];
        if (new Set(all).size !== all.length || all.some((e) => !refs.has(e)))
          throw new Error("REPORT_REFERENCE_INVALID");
        if (!("type" in object) && basis.some((e) => refs.get(e)?.eligibility !== "eligible"))
          throw new Error("REPORT_CONTEXT_NOT_SUPPORT");
      }
      const [latest] = await tx
        .select({ version: reports.version })
        .from(reports)
        .where(
          and(
            eq(reports.tenantId, ctx.tenantId),
            eq(reports.subjectId, ctx.subjectId),
            eq(reports.runId, runId),
          ),
        )
        .orderBy(desc(reports.version))
        .limit(1);
      const [candidate] = await tx
        .insert(reports)
        .values({
          ...ctx,
          runId,
          version: (latest?.version ?? 0) + 1,
          basisVersion: run.version,
          jobId,
          body: input.report,
          contentHash: await requestHash(input.report),
          inputHash: input.input_hash,
          policyVersion: input.policy_version,
          promptVersion: input.prompt_version,
          model: input.model,
        })
        .returning();
      const row = required(candidate);
      for (const ref of input.evidence)
        await tx.insert(dependencies).values({
          ...ctx,
          reportRevisionId: row.id,
          evidenceId: ref.evidence_id,
          sourceId: ref.source_id,
          spanId: ref.span_id,
          assessmentVersion: ref.assessment_version,
          sourceHash: ref.source_hash,
        });
      // Candidate staging never advances the accepted head.
      return { id: row.id, version: row.version, status: "candidate", published: false };
    });
  }
  async history(ctx: PersonalContext, runId: string) {
    return readHistory(this.db, ctx, runId);
  }
  async version(ctx: PersonalContext, runId: string, version: number) {
    return readVersion(this.db, ctx, runId, version);
  }
  async responses(ctx: PersonalContext, runId: string) {
    return readResponses(this.db, ctx, runId);
  }
  /** Internal audited publication; no HTTP route exposes this operation. */
  async acceptProcessed(
    ctx: PersonalContext,
    jobId: string,
    execution: string,
    reportId: string,
    fresh: (tx: ProfileTransaction) => Promise<void>,
  ) {
    return acceptProcessedReport(this.db, ctx, jobId, execution, reportId, fresh);
  }
}
