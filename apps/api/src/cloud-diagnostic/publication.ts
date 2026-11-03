import { UnderstandingAudit, UnderstandingReport } from "@findme/core";
import { type Db, platformSchema as platform, diagnosticSchema as tables } from "@findme/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import {
  assignReport,
  normalizeReportTimes,
  validateAudit,
} from "../domain/understanding/policy.js";
import { digest } from "../shared/primitives.js";
import { evidenceFor, reference } from "./evidence.js";
import { PipelineInput } from "./provenance.js";
import { currentVersion, publicationLock, runFor } from "./repository-state.js";
import { type ProfileTransaction, withProfileTransaction } from "./scope.js";
const runs = tables.diagnosticRuns;
const reports = tables.diagnosticReportRevisions;
const dependencies = tables.diagnosticReportSources;
const responses = tables.diagnosticResponses;
export async function acceptProcessedReport(
  db: Db,
  ctx: PersonalContext,
  jobId: string,
  execution: string,
  reportId: string,
  fresh: (tx: ProfileTransaction) => Promise<void>,
) {
  return withProfileTransaction(db, ctx, async (tx) => {
    await publicationLock(tx, ctx);
    await fresh(tx);
    const [job] = await tx
      .select()
      .from(platform.cloudJobs)
      .where(
        and(
          eq(platform.cloudJobs.id, jobId),
          eq(platform.cloudJobs.tenantId, ctx.tenantId),
          eq(platform.cloudJobs.subjectId, ctx.subjectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!job || job.status !== "running" || job.execution !== execution)
      throw new Error("PUBLICATION_CANCELLED");
    const run = await runFor(tx, ctx, job.runId);
    currentVersion(run, job.basisVersion);
    const [candidate] = await tx
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.id, reportId),
          eq(reports.tenantId, ctx.tenantId),
          eq(reports.subjectId, ctx.subjectId),
          eq(reports.runId, job.runId),
          eq(reports.jobId, jobId),
        ),
      )
      .limit(1);
    if (!candidate || candidate.status !== "candidate" || candidate.basisVersion !== run.version)
      throw new Error("PUBLICATION_BASIS_CHANGED");
    const attempts = await tx
      .select()
      .from(platform.cloudAttempts)
      .where(and(eq(platform.cloudAttempts.jobId, jobId), eq(platform.cloudAttempts.status, "ok")))
      .orderBy(desc(platform.cloudAttempts.createdAt));
    const generated = attempts.find((a) => a.phase === "report");
    const reviewed = attempts.find((a) => a.phase === "report_audit");
    if (!generated?.raw || !reviewed?.raw || generated.inputHash !== candidate.inputHash)
      throw new Error("PUBLICATION_AUDIT_REQUIRED");
    const body = UnderstandingReport.parse(candidate.body);
    const audit = UnderstandingAudit.parse(JSON.parse(reviewed.raw));
    if (
      digest(audit) !== digest(UnderstandingAudit.parse(reviewed.result)) ||
      (await requestHash(body)) !== candidate.contentHash
    )
      throw new Error("PUBLICATION_INTEGRITY");
    const refs = await tx
      .select()
      .from(dependencies)
      .where(
        and(
          eq(dependencies.reportRevisionId, candidate.id),
          eq(dependencies.tenantId, ctx.tenantId),
          eq(dependencies.subjectId, ctx.subjectId),
        ),
      );
    const evidence = [];
    for (const ref of refs) {
      const resolved = await evidenceFor(tx, ctx, reference(ref));
      if (!resolved.qualified_fact) throw new Error("REPORT_QUALIFICATION_REQUIRED");
      evidence.push(resolved.qualified_fact);
    }
    const raw = UnderstandingReport.parse(JSON.parse(generated.raw));
    if (
      digest(raw) !== digest(UnderstandingReport.parse(generated.result)) ||
      digest(normalizeReportTimes(raw, { evidence })) !== digest(body)
    )
      throw new Error("PUBLICATION_GENERATION_CHANGED");
    validateAudit(
      audit,
      candidate.inputHash,
      assignReport(body, candidate.inputHash),
      refs.map((ref) => ref.evidenceId),
    );
    await tx.update(reports).set({ status: "accepted" }).where(eq(reports.id, candidate.id));
    await tx
      .update(runs)
      .set({
        status: "ready",
        headVersion: candidate.version,
        version: run.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.tenantId, ctx.tenantId),
          eq(runs.subjectId, ctx.subjectId),
        ),
      );
    const snapshot = PipelineInput.parse(job.input);
    await tx
      .update(responses)
      .set({ processingStatus: "processed" })
      .where(
        and(
          eq(responses.runId, run.id),
          eq(responses.tenantId, ctx.tenantId),
          eq(responses.subjectId, ctx.subjectId),
          inArray(
            responses.sourceId,
            snapshot.sources.map((s) => s.id),
          ),
        ),
      );
    await tx
      .update(platform.cloudJobs)
      .set({
        status: "completed",
        reportId: candidate.id,
        execution: null,
        leaseUntil: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(platform.cloudJobs.id, job.id));
    if (run.domain !== "overall") {
      const publishedVersion = run.version + 1;
      const dependsOnPreviousTopic = (raw: unknown) => {
        const input = PipelineInput.safeParse(raw);
        return (
          input.success &&
          input.data.dependencies.some(
            (dependency) =>
              dependency.id === run.id &&
              (dependency.version < publishedVersion ||
                dependency.head_version < candidate.version),
          )
        );
      };
      // In-flight work and the currently visible head are separate objects. Never
      // rewrite a completed/failed/cancelled historical job to invalidate a report.
      const active = await tx
        .select({ job: platform.cloudJobs })
        .from(platform.cloudJobs)
        .innerJoin(runs, eq(runs.id, platform.cloudJobs.runId))
        .where(
          and(
            eq(platform.cloudJobs.tenantId, ctx.tenantId),
            eq(platform.cloudJobs.subjectId, ctx.subjectId),
            eq(runs.tenantId, ctx.tenantId),
            eq(runs.subjectId, ctx.subjectId),
            eq(runs.domain, "overall"),
            inArray(platform.cloudJobs.status, ["queued", "running"]),
          ),
        )
        .orderBy(platform.cloudJobs.id);
      for (const { job: item } of active) {
        if (!dependsOnPreviousTopic(item.input)) continue;
        await tx
          .update(platform.cloudJobs)
          .set({
            status: "stale",
            execution: null,
            leaseUntil: null,
            error: "TOPIC_CHANGED",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(platform.cloudJobs.id, item.id),
              eq(platform.cloudJobs.tenantId, ctx.tenantId),
              eq(platform.cloudJobs.subjectId, ctx.subjectId),
              inArray(platform.cloudJobs.status, ["queued", "running"]),
            ),
          );
      }
      // Lock before resolving the head: a concurrent overall publication may have
      // installed a different, independent head while this transaction was waiting.
      const current = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.tenantId, ctx.tenantId),
            eq(runs.subjectId, ctx.subjectId),
            eq(runs.domain, "overall"),
            eq(runs.status, "ready"),
          ),
        )
        .orderBy(runs.id)
        .for("update");
      for (const overall of current) {
        const [head] = await tx
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.tenantId, ctx.tenantId),
              eq(reports.subjectId, ctx.subjectId),
              eq(reports.runId, overall.id),
              eq(reports.version, overall.headVersion),
              eq(reports.status, "accepted"),
            ),
          )
          .limit(1);
        if (!head?.jobId) continue;
        const [headJob] = await tx
          .select()
          .from(platform.cloudJobs)
          .where(
            and(
              eq(platform.cloudJobs.id, head.jobId),
              eq(platform.cloudJobs.runId, overall.id),
              eq(platform.cloudJobs.tenantId, ctx.tenantId),
              eq(platform.cloudJobs.subjectId, ctx.subjectId),
            ),
          )
          .limit(1);
        if (!headJob || !dependsOnPreviousTopic(headJob.input)) continue;
        await tx
          .update(runs)
          .set({
            status: "needs_review",
            version: overall.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runs.id, overall.id),
              eq(runs.tenantId, ctx.tenantId),
              eq(runs.subjectId, ctx.subjectId),
              eq(runs.status, "ready"),
              eq(runs.version, overall.version),
              eq(runs.headVersion, overall.headVersion),
            ),
          );
      }
    }
    return { id: candidate.id, version: candidate.version, status: "accepted" };
  });
}
