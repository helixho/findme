import { coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ProfileTransaction } from "./scope.js";
/** Scope-limited invalidation; no model calls and no unrelated report regeneration. */
export async function invalidateCloudSources(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  ids: string[],
  hard = false,
) {
  if (!ids.length) return { reports: 0, jobs: 0 };
  const links = await tx
    .select()
    .from(d.diagnosticReportSources)
    .where(
      and(
        eq(d.diagnosticReportSources.tenantId, ctx.tenantId),
        eq(d.diagnosticReportSources.subjectId, ctx.subjectId),
        inArray(d.diagnosticReportSources.sourceId, ids),
      ),
    );
  const reportIds = [...new Set(links.map((l) => l.reportRevisionId))];
  // History may be invalidated independently of the current accepted head.
  // Resolve and lock the current head before changing revision statuses.
  const current = reportIds.length
    ? await tx
        .select()
        .from(d.diagnosticRuns)
        .where(
          and(
            eq(d.diagnosticRuns.tenantId, ctx.tenantId),
            eq(d.diagnosticRuns.subjectId, ctx.subjectId),
            ne(d.diagnosticRuns.status, "archived"),
            sql`exists (select 1 from ${d.diagnosticReportRevisions}
              where ${d.diagnosticReportRevisions.runId} = ${d.diagnosticRuns.id}
                and ${d.diagnosticReportRevisions.version} = ${d.diagnosticRuns.headVersion}
                and ${inArray(d.diagnosticReportRevisions.id, reportIds)})`,
          ),
        )
        .orderBy(d.diagnosticRuns.id)
        .for("update")
    : [];
  if (reportIds.length)
    await tx
      .update(d.diagnosticReportRevisions)
      .set({ status: hard ? "withdrawn" : "needs_review", ...(hard ? { body: {} } : {}) })
      .where(
        and(
          eq(d.diagnosticReportRevisions.tenantId, ctx.tenantId),
          eq(d.diagnosticReportRevisions.subjectId, ctx.subjectId),
          inArray(d.diagnosticReportRevisions.id, reportIds),
          ...(hard ? [] : [ne(d.diagnosticReportRevisions.status, "withdrawn")]),
        ),
      );
  const runIds = current.map((run) => run.id);
  if (runIds.length)
    await tx
      .update(d.diagnosticRuns)
      .set({
        status: "needs_review",
        version: sql`${d.diagnosticRuns.version}+1`,
        updatedAt: new Date(),
      })
      .where(inArray(d.diagnosticRuns.id, runIds));
  const jobs = await tx
    .select()
    .from(p.cloudJobs)
    .where(and(eq(p.cloudJobs.tenantId, ctx.tenantId), eq(p.cloudJobs.subjectId, ctx.subjectId)));
  const matching = jobs.filter(
    (j) =>
      Array.isArray(j.input.sources) &&
      (j.input.sources as { id: string }[]).some((s) => ids.includes(s.id)),
  );
  const active = matching.filter((j) => ["queued", "running"].includes(j.status)).map((j) => j.id);
  if (active.length)
    await tx
      .update(p.cloudJobs)
      .set({
        status: "stale",
        execution: null,
        leaseUntil: null,
        error: hard ? "SOURCE_DELETED" : "SOURCE_CHANGED",
      })
      .where(
        and(inArray(p.cloudJobs.id, active), inArray(p.cloudJobs.status, ["queued", "running"])),
      );
  const hit = matching.map((j) => j.id);
  if (hard && hit.length) {
    // Delete quotation-bearing payloads even in terminal jobs, while retaining
    // their historical outcome and never making them executable again.
    await tx
      .update(p.cloudJobs)
      .set({ input: { redacted: true }, error: "SOURCE_DELETED" })
      .where(inArray(p.cloudJobs.id, hit));
    await tx
      .update(p.cloudAttempts)
      .set({ raw: null, result: null, error: "SOURCE_DELETED" })
      .where(inArray(p.cloudAttempts.jobId, hit));
  }
  if (hard) {
    const scopedSources = await tx
      .select()
      .from(c.sourceItems)
      .where(
        and(eq(c.sourceItems.tenantId, ctx.tenantId), eq(c.sourceItems.subjectId, ctx.subjectId)),
      );
    for (const saved of scopedSources) {
      const context = saved.sourceMeta?.target_context as { report_id?: string } | null;
      if (context?.report_id && reportIds.includes(context.report_id))
        await tx
          .update(c.sourceItems)
          .set({ sourceMeta: { ...saved.sourceMeta, target_context: { redacted: true } } })
          .where(eq(c.sourceItems.id, saved.id));
    }
    // Old Core operation responses can embed quotations; clear scoped response caches.
    await tx
      .update(c.coreOperations)
      .set({ responseBody: null, responseStatus: null, status: "stale" })
      .where(
        and(
          eq(c.coreOperations.tenantId, ctx.tenantId),
          eq(c.coreOperations.subjectId, ctx.subjectId),
        ),
      );

    await tx
      .delete(p.sourceQualifications)
      .where(
        and(
          eq(p.sourceQualifications.tenantId, ctx.tenantId),
          eq(p.sourceQualifications.subjectId, ctx.subjectId),
          inArray(p.sourceQualifications.sourceId, ids),
        ),
      );
    const spans = await tx
      .select({ id: c.evidenceSpans.id })
      .from(c.evidenceSpans)
      .where(inArray(c.evidenceSpans.sourceItemId, ids));
    const spanIds = spans.map((s) => s.id);
    if (spanIds.length) {
      const uses = await tx
        .select({ id: c.claimEvidence.claimRevisionId })
        .from(c.claimEvidence)
        .where(inArray(c.claimEvidence.evidenceSpanId, spanIds));
      if (uses.length)
        await tx
          .update(c.claimRevisions)
          .set({
            text: "",
            scope: "",
            details: {},
            confidenceBasis: "",
            revisionReason: "source_deleted",
            status: "withdrawn",
            evidenceStatus: "invalid",
            invalidationReason: "source_deleted",
            invalidatedAt: new Date(),
          })
          .where(
            inArray(
              c.claimRevisions.id,
              uses.map((u) => u.id),
            ),
          );
      if (uses.length)
        await redactPriorUsers(
          tx,
          ctx,
          uses.map((u) => u.id),
        );
      const episodes = await tx
        .select({ id: c.experienceEvidence.experienceId })
        .from(c.experienceEvidence)
        .where(inArray(c.experienceEvidence.evidenceSpanId, spanIds));
      if (episodes.length) {
        const eids = episodes.map((e) => e.id);
        await tx
          .update(c.experiences)
          .set({ summary: "", context: { redacted: true }, status: "needs_review" })
          .where(inArray(c.experiences.id, eids));
        const es = await tx
          .select({ id: c.explorations.id })
          .from(c.explorations)
          .where(inArray(c.explorations.experienceId, eids));
        if (es.length) {
          const xs = es.map((e) => e.id);
          await tx
            .update(c.explorations)
            .set({ ext: { redacted: true }, version: sql`${c.explorations.version}+1` })
            .where(inArray(c.explorations.id, xs));
          await tx
            .update(c.coreOperations)
            .set({ responseBody: null, responseStatus: null, status: "stale" })
            .where(inArray(c.coreOperations.explorationId, xs));
          await tx
            .update(c.explorationSteps)
            .set({
              currentReading: "",
              keyUncertainty: null,
              intent: "",
              stopReason: "source_deleted",
              modelMeta: { redacted: true },
            })
            .where(inArray(c.explorationSteps.explorationId, xs));
          await tx
            .update(c.explorationQuestions)
            .set({
              question: "",
              intent: "",
              quickOptions: [],
              modelMeta: { redacted: true },
              status: "closed",
            })
            .where(inArray(c.explorationQuestions.explorationId, xs));
          await tx
            .update(c.knowledgeGaps)
            .set({ question: "", whyItMatters: "", status: "closed" })
            .where(inArray(c.knowledgeGaps.explorationId, xs));
          await tx
            .update(c.explorationTurns)
            .set({ content: "" })
            .where(
              and(
                inArray(c.explorationTurns.explorationId, xs),
                eq(c.explorationTurns.role, "assistant"),
              ),
            );
        }
      }
      await tx
        .update(c.claimEvidence)
        .set({ rationale: "source_deleted", scopeMatch: "" })
        .where(inArray(c.claimEvidence.evidenceSpanId, spanIds));
    }
    await tx
      .update(c.evidenceSpans)
      .set({ quote: "", locator: { redacted: true } })
      .where(inArray(c.evidenceSpans.sourceItemId, ids));
    await tx
      .update(c.sourceAssessments)
      .set({ rationale: "source_deleted" })
      .where(inArray(c.sourceAssessments.sourceItemId, ids));
    await tx
      .update(c.explorationTurns)
      .set({ content: "" })
      .where(inArray(c.explorationTurns.sourceItemId, ids));
    await tx
      .update(c.feedbackEvents)
      .set({ note: "" })
      .where(inArray(c.feedbackEvents.sourceItemId, ids));
    await tx
      .update(d.diagnosticResponses)
      .set({ note: "" })
      .where(
        and(
          eq(d.diagnosticResponses.tenantId, ctx.tenantId),
          eq(d.diagnosticResponses.subjectId, ctx.subjectId),
          inArray(d.diagnosticResponses.sourceId, ids),
        ),
      );
  }
  return { reports: reportIds.length, jobs: hit.length };
}

/**
 * Steps and questions of other explorations may hold copies of a deleted claim
 * (prior-understanding lineage and displayed effects) and readings derived with
 * it as context. Redact them like the source's own exploration steps.
 */
async function redactPriorUsers(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  revisionIds: string[],
) {
  const claims = await tx
    .selectDistinct({ id: c.claimRevisions.claimId })
    .from(c.claimRevisions)
    .where(inArray(c.claimRevisions.id, revisionIds));
  if (!claims.length) return;
  // A withdrawal copies the claim text into a revision without evidence links;
  // redact those copies of affected claims too.
  await tx
    .update(c.claimRevisions)
    .set({
      text: "",
      scope: "",
      details: {},
      confidenceBasis: "",
      revisionReason: "source_deleted",
      evidenceStatus: "invalid",
      invalidationReason: "source_deleted",
      invalidatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          c.claimRevisions.claimId,
          claims.map((claim) => claim.id),
        ),
        eq(c.claimRevisions.status, "withdrawn"),
      ),
    );
  const scoped = await tx
    .select({ id: c.explorations.id })
    .from(c.explorations)
    .where(
      and(eq(c.explorations.tenantId, ctx.tenantId), eq(c.explorations.subjectId, ctx.subjectId)),
    );
  if (!scoped.length) return;
  const xs = scoped.map((row) => row.id);
  // Claim ids are UUIDs; they appear in lineage as claim_id.
  const mentions = (
    column: typeof c.explorationSteps.modelMeta | typeof c.explorationQuestions.modelMeta,
  ) => or(...claims.map((claim) => sql`${column}::text like ${`%${claim.id}%`}`));
  const steps = await tx
    .update(c.explorationSteps)
    .set({
      currentReading: "",
      keyUncertainty: null,
      intent: "",
      stopReason: "source_deleted",
      modelMeta: { redacted: true },
    })
    .where(
      and(inArray(c.explorationSteps.explorationId, xs), mentions(c.explorationSteps.modelMeta)),
    )
    .returning({ explorationId: c.explorationSteps.explorationId });
  // Gaps of those explorations were synthesized with the deleted claim as context.
  const derived = [...new Set(steps.map((step) => step.explorationId))];
  if (derived.length)
    await tx
      .update(c.knowledgeGaps)
      .set({ question: "", whyItMatters: "", status: "closed" })
      .where(inArray(c.knowledgeGaps.explorationId, derived));
  const questions = await tx
    .update(c.explorationQuestions)
    .set({
      question: "",
      intent: "",
      quickOptions: [],
      modelMeta: { redacted: true },
      status: "closed",
    })
    .where(
      and(
        inArray(c.explorationQuestions.explorationId, xs),
        mentions(c.explorationQuestions.modelMeta),
      ),
    )
    .returning({ id: c.explorationQuestions.id });
  // The planner question is also stored as an assistant turn.
  if (questions.length)
    await tx
      .update(c.explorationTurns)
      .set({ content: "" })
      .where(
        and(
          eq(c.explorationTurns.role, "assistant"),
          inArray(
            c.explorationTurns.questionId,
            questions.map((q) => q.id),
          ),
        ),
      );
}
