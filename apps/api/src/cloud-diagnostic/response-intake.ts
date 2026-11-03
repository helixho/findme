import { CloudDiagnosticResponse } from "@findme/core";
import { type Db, coreSchema as core, diagnosticSchema as tables } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import {
  currentVersion,
  key,
  publicationLock,
  required,
  runFor,
  sameRequest,
} from "./repository-state.js";
import { withProfileTransaction } from "./scope.js";
const runs = tables.diagnosticRuns;
const reports = tables.diagnosticReportRevisions;
const responses = tables.diagnosticResponses;
export async function recordResponse(
  db: Db,
  ctx: PersonalContext,
  runId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const input = CloudDiagnosticResponse.parse(raw);
  const idKey = key(idempotencyKey);
  const hash = await requestHash({ runId, ...input });
  return withProfileTransaction(db, ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([ctx.tenantId, ctx.subjectId, "diagnostic-response", idKey])}, 0))`);
    await publicationLock(tx, ctx);
    const run = await runFor(tx, ctx, runId);
    const [existing] = await tx
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.tenantId, ctx.tenantId),
          eq(responses.subjectId, ctx.subjectId),
          eq(responses.idempotencyKey, idKey),
        ),
      )
      .limit(1);
    if (existing) {
      sameRequest(existing.requestHash, hash);
      return {
        id: existing.id,
        version: existing.resultVersion,
        saved: true,
        analysis_status: existing.processingStatus,
        source_id: existing.sourceId,
      };
    }
    currentVersion(run, input.expected_version);
    if (input.report_revision_id) {
      const [target] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.id, input.report_revision_id),
            eq(reports.tenantId, ctx.tenantId),
            eq(reports.subjectId, ctx.subjectId),
            eq(reports.runId, runId),
            eq(reports.version, run.headVersion),
          ),
        )
        .limit(1);
      if (!target) throw new CoreError("STALE_REPORT_VERSION", 409, "目标报告已变化");
    }
    let targetContext: Record<string, unknown> | null = null;
    if (input.report_revision_id) {
      const [target] = await tx
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.id, input.report_revision_id),
            eq(reports.tenantId, ctx.tenantId),
            eq(reports.subjectId, ctx.subjectId),
            eq(reports.runId, runId),
          ),
        )
        .limit(1);
      if (target)
        targetContext = {
          report_id: target.id,
          version: target.version,
          content_hash: target.contentHash,
          body: target.body,
          role: "disputed_context_not_evidence",
        };
    }
    let sourceId: string | null = null;
    if (input.kind !== "helpful") {
      const [source] = await tx
        .insert(core.sourceItems)
        .values({
          ...ctx,
          sourceKind: "guided_response",
          authorKind: "unknown",
          content: input.note,
          sourceMeta: {
            entrypoint: "cloud-diagnostic-response@1",
            submitter: "subject",
            run_id: runId,
            response_kind: input.kind,
            target_context: targetContext,
          },
        })
        .returning();
      sourceId = required(source).id;
      await tx.insert(core.sourceAssessments).values({
        sourceItemId: sourceId,
        version: 1,
        attributionStatus: "ambiguous",
        contextCompleteness: "unknown",
        temporalPrecision: "unknown",
        eligibility: "needs_review",
        rationale: "原话已保存；作者、引语和命题用途尚未加工。",
      });
    }
    const nextVersion = input.kind === "helpful" ? run.version : run.version + 1;
    const [saved] = await tx
      .insert(responses)
      .values({
        ...ctx,
        runId,
        reportRevisionId: input.report_revision_id,
        sourceId,
        kind: input.kind,
        note: input.note,
        basisVersion: run.version,
        resultVersion: nextVersion,
        idempotencyKey: idKey,
        requestHash: hash,
      })
      .returning();
    await tx
      .update(runs)
      .set({
        version: nextVersion,
        updatedAt: new Date(),
        status:
          input.kind === "helpful" ? run.status : run.headVersion ? "needs_review" : "pending",
      })
      .where(
        and(eq(runs.id, runId), eq(runs.tenantId, ctx.tenantId), eq(runs.subjectId, ctx.subjectId)),
      );
    return {
      id: required(saved).id,
      version: nextVersion,
      saved: true,
      analysis_status: "recorded",
      source_id: sourceId,
    };
  });
}
