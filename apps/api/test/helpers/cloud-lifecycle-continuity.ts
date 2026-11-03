import { randomUUID } from "node:crypto";
import { UnderstandingAudit, UnderstandingReport } from "@findme/core";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CloudLifecycleService } from "../../src/cloud-diagnostic/lifecycle.js";
import { CloudProcessingService } from "../../src/cloud-diagnostic/processing.js";
import {
  PipelineInput,
  cloudFacts,
  cloudQualificationInput,
} from "../../src/cloud-diagnostic/provenance.js";
import { CloudDiagnosticRepository } from "../../src/cloud-diagnostic/repository.js";
import { withProfileTransaction } from "../../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../../src/core/exploration-service.js";
import { requestHash } from "../../src/core/operations.js";
import { UnderstandingQualification } from "../../src/understanding-app/qualification-schema.js";
import { qualificationAssigned } from "../../src/understanding-app/qualification.js";
import { digest } from "../../src/understanding-baseline/io.js";
import { assignReport, normalizeReportTimes } from "../../src/understanding-baseline/policy.js";

type Environment = {
  db: () => Db;
  context: () => Promise<PersonalContext>;
  repository: () => CloudDiagnosticRepository;
};

// Registered inside the explicitly configured Postgres suite; no new connection,
// credentials, model, database setup or environment loading happens in this helper.
export function cloudLifecycleContinuity(env: Environment) {
  async function fixture(prior?: {
    ctx: PersonalContext;
    run: { id: string; version: number };
    topics?: string[];
  }) {
    const db = env.db();
    const ctx = prior?.ctx ?? (await env.context());
    const repository = env.repository();
    const run =
      prior?.run ??
      (await repository.create(
        ctx,
        { domain: "collaboration", question: "合成原话如何支持这次协作理解？" },
        randomUUID(),
      ));
    const parts = ["我偏好先核对依据。", "也偏好先确认问题。"];
    const sourceId = randomUUID();
    await withProfileTransaction(db, ctx, async (tx) => {
      await tx.insert(c.sourceItems).values({
        ...ctx,
        id: sourceId,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: parts.join(""),
        capturedAt: new Date("2026-01-02T03:04:05Z"),
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        sourceMeta: {
          about: "self",
          stance: "endorsed",
          target_context: { nested: { z: "上下文", a: "合成" }, choices: ["第一项", "第二项"] },
        },
      });
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: sourceId,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "complete",
        temporalPrecision: "exact",
        eligibility: "eligible",
        rationale: "合成测试原话",
      });
    });
    const extract = vi.fn(async () => {
      throw new Error("MODEL_MUST_NOT_RUN");
    });
    const send = vi.fn(async () => {});
    const processing = new CloudProcessingService(
      db,
      { extract, describe: () => ({ model: "zero-model-cache-fixture" }) } as any,
      {
        enabled: true,
        profileCallLimit: 0,
        maxCallsPerJob: 4,
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
      send,
    );
    const queued = await processing.enqueue(ctx, run.id, {
      expected_version: run.version,
      topic_run_ids: prior?.topics ?? [],
      source_ids: [sourceId],
      provider_call_cap: 4,
    });
    const [job] = await withProfileTransaction(db, ctx, (tx) =>
      tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, queued.id)),
    );
    const input = PipelineInput.parse(job!.input);
    const qinput = cloudQualificationInput(input);
    const candidate = UnderstandingQualification.parse({
      notes: [
        {
          note_id: sourceId,
          reason: "合成原话包含两个有范围的偏好",
          propositions: parts.map((quote, i) => ({
            quote,
            start: i === 0 ? 0 : parts[0]!.length,
            end: i === 0 ? parts[0]!.length : parts.join("").length,
            author: "subject",
            about: "self",
            kind: "evaluation",
            stance: "endorsed",
            type: "preference",
            purpose: "personal_expression",
            proposition: quote,
            scope: `这次合成协作条件${i + 1}`,
            reason: "仅对这次合成原话作局部解释",
          })),
        },
      ],
    });
    const facts = cloudFacts(input, candidate);
    const audit = (inputHash: string, assigned: { id: string }[]) =>
      UnderstandingAudit.parse({
        input_hash: inputHash,
        checks: assigned.map((a) => ({
          id: a.id,
          checked: true,
          rationale: `合成独立审核 ${a.id}`,
          same_context: false,
          concrete_incompatibility: false,
        })),
        issues: [],
      });
    const qualificationAuditInput = {
      analysis_input: qinput,
      analysis_input_hash: digest(qinput),
      candidate,
      assigned: qualificationAssigned(qinput, candidate),
    };
    const qualificationAudit = audit(digest(qinput), qualificationAuditInput.assigned);
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
      policy: input.policy,
    };
    const report = UnderstandingReport.parse({
      headline: "合成协作中的两个局部偏好",
      current_understanding: {
        key: "current",
        text: "在这次合成协作表述中，本人偏好核对依据并先确认问题。",
        scope: "仅限这次合成原话，不代表跨事件特征",
        time: input.sources[0]!.reported_at,
        status: "reported",
        evidence_ids: facts.filter((f) => f.use === "personal_expression").map((f) => f.id),
        counterevidence_ids: [],
        context_ids: [],
      },
      findings: [],
      resources_conditions_costs: [],
      alternatives: ["可能只适用于此次问题。", "其他协作条件尚未比较。"],
      unknowns: ["没有独立经历可供比较。"],
      question: null,
      next_step: null,
      nodes: [],
      links: [],
    });
    const normalized = normalizeReportTimes(report, selection);
    const reportAuditInput = {
      analysis_input: analysis,
      analysis_input_hash: digest(analysis),
      candidate: normalized,
      assigned: assignReport(normalized, digest(analysis)),
    };
    const reportAudit = audit(digest(analysis), reportAuditInput.assigned);
    const pairs = [
      { phase: "qualification", inputHash: digest(qinput), result: candidate },
      {
        phase: "qualification_audit",
        inputHash: digest(qualificationAuditInput),
        result: qualificationAudit,
      },
      { phase: "report", inputHash: digest(analysis), result: report },
      { phase: "report_audit", inputHash: digest(reportAuditInput), result: reportAudit },
    ];
    await withProfileTransaction(db, ctx, async (tx) => {
      for (const pair of pairs)
        await tx.insert(p.cloudAttempts).values({
          ...ctx,
          jobId: queued.id,
          execution: randomUUID(),
          phase: pair.phase,
          inputHash: pair.inputHash,
          model: "zero-model-cache-fixture",
          status: "ok",
          raw: JSON.stringify(pair.result),
          result: pair.result,
        });
      await tx
        .update(p.cloudJobs)
        .set({ status: "failed", error: "PROVIDER_TRANSPORT", callsUsed: 4, stage: "report_audit" })
        .where(eq(p.cloudJobs.id, queued.id));
      await tx
        .insert(p.cloudBudgets)
        .values({ ...ctx, callsUsed: 4 })
        .onConflictDoNothing();
    });
    return {
      db,
      ctx,
      run,
      sourceId,
      jobId: queued.id,
      processing,
      repository,
      extract,
      report,
      facts,
      consume: async () => {
        await processing.resume(ctx, queued.id, { provider_call_cap: 4 });
        await processing.consume({
          type: "cloud_diagnostic",
          job_id: queued.id,
          tenant_id: ctx.tenantId,
          subject_id: ctx.subjectId,
        });
        return processing.get(ctx, queued.id);
      },
    };
  }
  async function sourceAction(
    x: Awaited<ReturnType<typeof fixture>>,
    action: "exclude" | "restore" | "delete",
  ) {
    const state = await withProfileTransaction(x.db, x.ctx, async (tx) => {
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, x.sourceId));
      const [assessment] = await tx
        .select()
        .from(c.sourceAssessments)
        .where(
          and(
            eq(c.sourceAssessments.sourceItemId, x.sourceId),
            eq(c.sourceAssessments.isCurrent, true),
          ),
        );
      return { source: source!, assessment: assessment! };
    });
    const { cloudSourceHash } = await import("../../src/cloud-diagnostic/repository.js");
    return new CloudLifecycleService(x.db).act(
      x.ctx,
      x.sourceId,
      {
        action,
        expected_hash: await cloudSourceHash(state.source),
        expected_assessment_version: state.assessment.version,
        ...(action === "delete" ? { confirmation: x.sourceId } : {}),
      },
      randomUUID(),
    );
  }
  async function syntheticTopic(db: Db, ctx: PersonalContext) {
    const repository = env.repository();
    const run = await repository.create(
      ctx,
      { domain: "collaboration", question: "合成依赖专题" },
      randomUUID(),
    );
    const body = UnderstandingReport.parse({
      headline: "合成专题",
      current_understanding: null,
      findings: [],
      resources_conditions_costs: [],
      alternatives: [],
      unknowns: ["仅验证依赖"],
      question: null,
      next_step: null,
      nodes: [],
      links: [],
    });
    await withProfileTransaction(db, ctx, async (tx) => {
      await tx.insert(d.diagnosticReportRevisions).values({
        ...ctx,
        runId: run.id,
        version: 1,
        basisVersion: 1,
        status: "accepted",
        body,
        contentHash: await requestHash(body),
        inputHash: await requestHash(body),
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
      await tx
        .update(d.diagnosticRuns)
        .set({ status: "ready", version: 2, headVersion: 1 })
        .where(eq(d.diagnosticRuns.id, run.id));
    });
    return { ...run, version: 2 };
  }
  describe("continuous lifecycle and publication validity", () => {
    it("publishes A, excludes A, publishes independent B, then restores and deletes A without withdrawing B or reviving archived/terminal history", async () => {
      const a = await fixture();
      expect((await a.consume()).status).toBe("completed");
      const before = await a.repository.read(a.ctx, a.run.id);
      expect(before.report).toEqual(a.report);
      const archived = await a.repository.create(
        a.ctx,
        { domain: "collaboration", question: "合成归档" },
        randomUUID(),
      );
      const terminals: { id: string; status: string }[] = [];
      let activeId = "";
      await withProfileTransaction(a.db, a.ctx, async (tx) => {
        const [head] = await tx
          .select()
          .from(d.diagnosticReportRevisions)
          .where(eq(d.diagnosticReportRevisions.id, before.report_revision_id!));
        const [copy] = await tx
          .insert(d.diagnosticReportRevisions)
          .values({
            ...head!,
            id: randomUUID(),
            runId: archived.id,
            jobId: null,
          })
          .returning();
        const refs = await tx
          .select()
          .from(d.diagnosticReportSources)
          .where(eq(d.diagnosticReportSources.reportRevisionId, head!.id));
        for (const ref of refs)
          await tx.insert(d.diagnosticReportSources).values({
            ...ref,
            id: randomUUID(),
            reportRevisionId: copy!.id,
          });
        await tx
          .update(d.diagnosticRuns)
          .set({ status: "archived", version: 9, headVersion: 1 })
          .where(eq(d.diagnosticRuns.id, archived.id));
        const [original] = await tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, a.jobId));
        terminals.push({ id: a.jobId, status: "completed" });
        for (const status of ["failed", "cancelled", "rejected", "stale", "queued"]) {
          const id = randomUUID();
          await tx.insert(p.cloudJobs).values({
            ...original!,
            id,
            fingerprint: randomUUID(),
            status,
            reportId: null,
          });
          if (status === "queued") activeId = id;
          else terminals.push({ id, status });
        }
      });
      await sourceAction(a, "exclude");
      const excluded = await a.repository.read(a.ctx, a.run.id);
      expect(excluded).toMatchObject({
        status: "needs_review",
        version: before.version + 1,
        report: null,
      });
      expect(await a.processing.get(a.ctx, activeId)).toMatchObject({
        status: "stale",
        error: "SOURCE_CHANGED",
      });
      const b = await fixture({ ctx: a.ctx, run: excluded });
      expect((await b.consume()).status).toBe("completed");
      const independent = await b.repository.read(b.ctx, b.run.id);
      expect(independent.report).toEqual(b.report);
      await sourceAction(a, "restore");
      expect(await b.repository.read(b.ctx, b.run.id)).toMatchObject({
        status: "ready",
        version: independent.version,
        report: b.report,
      });
      for (const terminal of terminals)
        expect((await a.processing.get(a.ctx, terminal.id)).status).toBe(terminal.status);
      expect(await a.repository.read(a.ctx, archived.id)).toMatchObject({
        status: "archived",
        version: 9,
        report: null,
      });
      await sourceAction(a, "delete");
      expect(await b.repository.read(b.ctx, b.run.id)).toMatchObject({
        status: "ready",
        version: independent.version,
        report: b.report,
      });
      const hard = await withProfileTransaction(a.db, a.ctx, async (tx) => ({
        jobs: await tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, a.jobId)),
        attempts: await tx.select().from(p.cloudAttempts).where(eq(p.cloudAttempts.jobId, a.jobId)),
        history: await tx
          .select()
          .from(d.diagnosticReportRevisions)
          .where(eq(d.diagnosticReportRevisions.id, before.report_revision_id!)),
      }));
      expect(hard.jobs[0]).toMatchObject({ status: "completed", input: { redacted: true } });
      expect(
        hard.attempts.every((attempt) => attempt.raw === null && attempt.result === null),
      ).toBe(true);
      expect(hard.history[0]).toMatchObject({ status: "withdrawn", body: {} });
      expect(await a.repository.read(a.ctx, archived.id)).toMatchObject({
        status: "archived",
        version: 9,
      });
      expect(a.extract).not.toHaveBeenCalled();
      expect(b.extract).not.toHaveBeenCalled();
    });

    it.each(["supplement", "helpful"])(
      "serializes a %s response after publication freshness, and permits an explicit replacement of a now-invalid overall",
      async (kind) => {
        const ctx = await env.context();
        const topic = await syntheticTopic(env.db(), ctx);
        const topicRevisionId = (await env.repository().read(ctx, topic.id)).report_revision_id;
        const overall = await env
          .repository()
          .create(ctx, { domain: "overall", question: "合成并发整体" }, randomUUID());
        const x = await fixture({ ctx, run: overall, topics: [topic.id] });
        let markFresh!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((resolve) => {
          markFresh = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const accept = CloudDiagnosticRepository.prototype.acceptProcessed;
        const spy = vi
          .spyOn(CloudDiagnosticRepository.prototype, "acceptProcessed")
          .mockImplementation(function (
            this: CloudDiagnosticRepository,
            context,
            jobId,
            execution,
            reportId,
            fresh,
          ) {
            return accept.call(this, context, jobId, execution, reportId, async (tx) => {
              await fresh(tx);
              markFresh();
              await gate;
            });
          });
        let correction: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
        const publication = x.consume();
        try {
          await Promise.race([
            reached,
            publication.then((job) => {
              throw new Error(`PUBLICATION_ENDED_BEFORE_FRESH:${job.error}`);
            }),
          ]);
          let responseDone = false;
          correction = x.repository
            .respond(
              ctx,
              topic.id,
              {
                expected_version: 2,
                report_revision_id: topicRevisionId,
                kind,
                note: "合成纠正：条件已改变",
              },
              randomUUID(),
            )
            .then(
              () => {
                responseDone = true;
                return { ok: true as const };
              },
              (error: unknown) => {
                responseDone = true;
                return { ok: false as const, error };
              },
            );
          // The publication lock is held past freshness; a response cannot commit in this gap.
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(responseDone).toBe(false);
          release();
          expect((await publication).status).toBe("completed");
          const response = await correction;
          if (!response.ok) throw response.error;
        } finally {
          release();
          try {
            await Promise.allSettled([publication, correction]);
          } finally {
            spy.mockRestore();
          }
        }
        const current = await x.repository.read(ctx, overall.id);
        if (kind === "helpful") {
          expect(current).toMatchObject({ status: "ready", report: x.report });
          await expect(
            x.processing.enqueue(ctx, overall.id, {
              expected_version: current.version,
              source_ids: [x.sourceId],
              topic_run_ids: [topic.id],
              provider_call_cap: 4,
            }),
          ).rejects.toThrow("已有当前报告");
        } else {
          expect(current).toMatchObject({ status: "needs_review", report: null });
          const healthy = await syntheticTopic(x.db, ctx);
          const next = await x.processing.enqueue(ctx, overall.id, {
            expected_version: current.version,
            source_ids: [x.sourceId],
            topic_run_ids: [healthy.id],
            provider_call_cap: 4,
          });
          expect(next).toMatchObject({ status: "queued" });
          expect(next.id).not.toBe(x.jobId);
        }
        expect(x.extract).not.toHaveBeenCalled();
      },
    );
  });
}
