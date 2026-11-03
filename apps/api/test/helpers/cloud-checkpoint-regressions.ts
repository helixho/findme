import { randomUUID } from "node:crypto";
import { UnderstandingAudit, UnderstandingReport } from "@findme/core";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CloudProcessingService } from "../../src/cloud-diagnostic/processing.js";
import {
  PipelineInput,
  cloudFacts,
  cloudQualificationInput,
  qualificationProof,
} from "../../src/cloud-diagnostic/provenance.js";
import type { CloudDiagnosticRepository } from "../../src/cloud-diagnostic/repository.js";
import { withProfileTransaction } from "../../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../../src/core/exploration-service.js";
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
export function cloudCheckpointRegressions(env: Environment) {
  async function fixture() {
    const db = env.db();
    const ctx = await env.context();
    const repository = env.repository();
    const run = await repository.create(
      ctx,
      { domain: "collaboration", question: "合成原话如何支持这次协作理解？" },
      randomUUID(),
    );
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
      expected_version: 1,
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
      task: "cloud_domain_understanding",
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
    const proof = () =>
      withProfileTransaction(db, ctx, (tx) => qualificationProof(tx, ctx, queued.id));
    const attempts = () =>
      withProfileTransaction(db, ctx, (tx) =>
        tx
          .select()
          .from(p.cloudAttempts)
          .where(eq(p.cloudAttempts.jobId, queued.id))
          .orderBy(p.cloudAttempts.phase),
      );
    const budgets = () => withProfileTransaction(db, ctx, (tx) => tx.select().from(p.cloudBudgets));
    async function mutateResult(phase: string, change: (value: any) => void) {
      await withProfileTransaction(db, ctx, async (tx) => {
        const [row] = await tx
          .select()
          .from(p.cloudAttempts)
          .where(and(eq(p.cloudAttempts.jobId, queued.id), eq(p.cloudAttempts.phase, phase)));
        const value = structuredClone(row!.result);
        change(value);
        await tx
          .update(p.cloudAttempts)
          .set({ result: value })
          .where(eq(p.cloudAttempts.id, row!.id));
      });
    }
    const consume = async () => {
      await processing.resume(ctx, queued.id, { provider_call_cap: 4 });
      await processing.consume({
        type: "cloud_diagnostic",
        job_id: queued.id,
        tenant_id: ctx.tenantId,
        subject_id: ctx.subjectId,
      });
      return processing.get(ctx, queued.id);
    };
    return {
      db,
      ctx,
      run,
      sourceId,
      jobId: queued.id,
      candidate,
      qualificationAudit,
      facts,
      report,
      repository,
      processing,
      extract,
      send,
      proof,
      attempts,
      budgets,
      mutateResult,
      consume,
    };
  }

  describe("persisted nonempty qualification + checkpoint reuse / zero model", () => {
    it("reconstructs an audited proof with nested JSONB key reordering and preserves proposition/check array order", async () => {
      const x = await fixture();
      const saved = await x.attempts();
      const generation = saved.find((a) => a.phase === "qualification")!;
      const review = saved.find((a) => a.phase === "qualification_audit")!;
      expect(generation.result).toEqual(x.candidate);
      expect(review.result).toEqual(x.qualificationAudit);
      expect(digest(generation.result)).not.toBe(digest(x.candidate));
      expect(digest(review.result)).not.toBe(digest(x.qualificationAudit));
      expect((await x.proof()).facts).toEqual(x.facts);
      expect(x.extract).not.toHaveBeenCalled();
    });
    it("resumes and reuses all four saved stages, publishes real synthetic references, and reads exact evidence with no extra calls or attempts", async () => {
      const x = await fixture();
      const beforeAttempts = await x.attempts();
      const beforeBudget = await x.budgets();
      expect(await x.consume()).toMatchObject({
        status: "completed",
        calls_used: 4,
        call_cap: 4,
        error: null,
      });
      expect(await x.attempts()).toEqual(beforeAttempts);
      expect(await x.budgets()).toEqual(beforeBudget);
      expect(x.extract).not.toHaveBeenCalled();
      expect(x.send).toHaveBeenCalledTimes(2);
      const read = await x.repository.read(x.ctx, x.run.id);
      expect(read).toMatchObject({ status: "ready", report_status: "accepted", report: x.report });
      const evidence = await x.repository.evidence(x.ctx, x.run.id, x.facts[1]!.id);
      expect(evidence).toMatchObject({
        source_id: x.sourceId,
        quote: x.facts[1]!.quote,
        content_author: "subject",
        about: "self",
        stance: "endorsed",
        eligibility: "eligible",
      });
      const refs = await withProfileTransaction(x.db, x.ctx, (tx) =>
        tx
          .select()
          .from(d.diagnosticReportSources)
          .where(eq(d.diagnosticReportSources.reportRevisionId, read.report_revision_id!)),
      );
      expect(refs).toHaveLength(x.facts.length);
      // Live original changes must still revoke reading; no model work is started.
      await withProfileTransaction(x.db, x.ctx, (tx) =>
        tx
          .update(c.sourceItems)
          .set({ content: "已改变的合成原话" })
          .where(eq(c.sourceItems.id, x.sourceId)),
      );
      expect(await x.repository.read(x.ctx, x.run.id)).toMatchObject({
        status: "needs_review",
        report: null,
      });
      expect(x.extract).not.toHaveBeenCalled();
      expect(await x.budgets()).toEqual(beforeBudget);
    });
    it.each(["qualification", "qualification_audit"])(
      "rejects actual saved %s content changes rather than normalizing them away",
      async (phase) => {
        const x = await fixture();
        await x.mutateResult(phase, (value) => {
          if (phase === "qualification") value.notes[0].propositions[0].scope = "已篡改的范围";
          else value.checks[0].rationale = "已篡改的审核理由";
        });
        await expect(x.proof()).rejects.toThrow("QUALIFICATION_PROOF_CHANGED");
      },
    );
    it.each(["propositions", "checks"])("keeps %s array order significant", async (array) => {
      const x = await fixture();
      await x.mutateResult(
        array === "propositions" ? "qualification" : "qualification_audit",
        (value) => {
          if (array === "propositions") value.notes[0].propositions.reverse();
          else value.checks.reverse();
        },
      );
      await expect(x.proof()).rejects.toThrow("QUALIFICATION_PROOF_CHANGED");
    });
    it.each([
      "unknown_generation_field",
      "wrong_generation_type",
      "unknown_audit_field",
      "wrong_audit_type",
    ])("strictly rejects %s in persisted nested projections", async (change) => {
      const x = await fixture();
      await x.mutateResult(
        change.includes("generation") ? "qualification" : "qualification_audit",
        (value) => {
          if (change === "unknown_generation_field")
            value.notes[0].propositions[0].unexpected = true;
          if (change === "wrong_generation_type") value.notes[0].propositions[0].start = "0";
          if (change === "unknown_audit_field") value.checks[0].unexpected = true;
          if (change === "wrong_audit_type") value.checks[0].checked = "true";
        },
      );
      await expect(x.proof()).rejects.toMatchObject({ name: "ZodError" });
    });
    it.each(["frozen_original", "generation_input_hash", "audit_input_hash"])(
      "retains %s binding checks",
      async (change) => {
        const x = await fixture();
        await withProfileTransaction(x.db, x.ctx, async (tx) => {
          if (change === "frozen_original") {
            const [job] = await tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, x.jobId));
            const input = structuredClone(job!.input) as any;
            input.sources[0].text = "已篡改的冻结原话";
            await tx.update(p.cloudJobs).set({ input }).where(eq(p.cloudJobs.id, x.jobId));
          } else
            await tx
              .update(p.cloudAttempts)
              .set({ inputHash: "0".repeat(64) })
              .where(
                and(
                  eq(p.cloudAttempts.jobId, x.jobId),
                  eq(
                    p.cloudAttempts.phase,
                    change === "generation_input_hash" ? "qualification" : "qualification_audit",
                  ),
                ),
              );
        });
        await expect(x.proof()).rejects.toThrow("QUALIFICATION_INPUT_VERSION_CHANGED");
      },
    );
    it.each(["qualification", "qualification_audit", "report", "report_audit"])(
      "rejects a changed %s checkpoint during actual resume without contacting the gateway",
      async (phase) => {
        const x = await fixture();
        await x.mutateResult(phase, (value) => {
          if (phase === "qualification") value.notes[0].propositions[0].scope = "已篡改";
          else if (phase === "report") value.alternatives.reverse();
          else value.checks[0].rationale = "已篡改";
        });
        const beforeAttempts = await x.attempts();
        const beforeBudget = await x.budgets();
        expect(await x.consume()).toMatchObject({
          status: "failed",
          error: "CHECKPOINT_CHANGED",
          calls_used: 4,
        });
        expect(x.extract).not.toHaveBeenCalled();
        expect(await x.attempts()).toEqual(beforeAttempts);
        expect(await x.budgets()).toEqual(beforeBudget);
        expect((await x.repository.read(x.ctx, x.run.id)).report).toBeNull();
      },
    );
  });
}
