import { randomUUID } from "node:crypto";
import { UnderstandingAudit, UnderstandingReport } from "@findme/core";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CloudProcessingService } from "../../src/cloud-diagnostic/processing.js";
import { PipelineInput, cloudFacts } from "../../src/cloud-diagnostic/provenance.js";
import type { CloudDiagnosticRepository } from "../../src/cloud-diagnostic/repository.js";
import { withProfileTransaction } from "../../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../../src/core/exploration-service.js";
import { UnderstandingQualification } from "../../src/understanding-app/qualification-schema.js";
import { qualificationAssigned } from "../../src/understanding-app/qualification.js";
import { digest } from "../../src/understanding-baseline/io.js";
import { assignReport } from "../../src/understanding-baseline/policy.js";

type Environment = {
  db: () => Db;
  context: () => Promise<PersonalContext>;
  repository: () => CloudDiagnosticRepository;
};

// The parent suite owns the isolated database. Every extraction below is a local
// synthetic observer invocation; it never constructs a provider or network client.
export function cloudProcessingContinuity(env: Environment) {
  async function fixture() {
    const db = env.db();
    const ctx = await env.context();
    const repository = env.repository();
    const question = "合成协作如何先确认依据？";
    const run = await repository.create(ctx, { domain: "collaboration", question }, randomUUID());
    const sourceId = randomUUID();
    const text = "我偏好先核对依据。";
    await withProfileTransaction(db, ctx, async (tx) => {
      await tx.insert(c.sourceItems).values({
        ...ctx,
        id: sourceId,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: text,
        capturedAt: new Date("2026-01-02T03:04:05Z"),
        sourceMeta: { about: "self", stance: "endorsed" },
      });
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: sourceId,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "complete",
        temporalPrecision: "exact",
        eligibility: "eligible",
        rationale: "合成原话",
      });
    });
    const budget = async () => {
      const [row] = await withProfileTransaction(db, ctx, (tx) =>
        tx
          .select()
          .from(p.cloudBudgets)
          .where(
            and(
              eq(p.cloudBudgets.tenantId, ctx.tenantId),
              eq(p.cloudBudgets.subjectId, ctx.subjectId),
            ),
          ),
      );
      return row?.callsUsed ?? 0;
    };
    const startBudget = await budget();
    const model = "local-synthetic-continuity";
    const send = vi.fn(async () => {});
    const extracted: string[] = [];
    let afterReservation: ((input: any) => Promise<void>) | undefined;
    const extract = vi.fn(async (request: any) => {
      // This call is the actual reservation hook, including the failure path before
      // a provider could be contacted. Responses are deterministic fixture objects.
      await request.controls.observer.beforeAttempt({ attempt: 1, model, estimate: {} });
      const input = JSON.parse(request.text);
      await afterReservation?.(input);
      let result: any;
      if (
        input.task === "cloud_domain_understanding" ||
        input.task === "cloud_overall_understanding"
      ) {
        extracted.push("report");
        const facts = input.selection.evidence;
        result = UnderstandingReport.parse({
          headline: "合成协作中的局部偏好",
          current_understanding: {
            key: "current",
            text: "本次原话表达先核对依据的偏好。",
            scope: "仅限本次合成表述",
            time: facts[0].time,
            status: "reported",
            evidence_ids: facts
              .filter((f: any) => f.use === "personal_expression")
              .map((f: any) => f.id),
            counterevidence_ids: [],
            context_ids: [],
          },
          findings: [],
          resources_conditions_costs: [],
          alternatives: ["可能只限此次问题。", "其他条件尚未比较。"],
          unknowns: ["缺少独立经历。"],
          question: null,
          next_step: null,
          nodes: [],
          links: [],
        });
      } else if (input.candidate) {
        extracted.push(input.candidate.notes ? "qualification_audit" : "report_audit");
        result = UnderstandingAudit.parse({
          input_hash: input.analysis_input_hash,
          checks: input.assigned.map((a: any) => ({
            id: a.id,
            checked: true,
            rationale: "合成审核逐项保留依据和范围。",
            same_context: false,
            concrete_incompatibility: false,
          })),
          issues: [],
        });
      } else {
        extracted.push("qualification");
        result = UnderstandingQualification.parse({
          notes: input.notes.map((note: any) => ({
            note_id: note.source_id,
            reason: "合成原话中的局部偏好",
            propositions: [
              {
                quote: note.note,
                start: 0,
                end: note.note.length,
                author: "subject",
                about: "self",
                kind: "evaluation",
                stance: "endorsed",
                type: "preference",
                purpose: "personal_expression",
                proposition: note.note,
                scope: "仅限这次合成协作",
                reason: "原话明确表达的局部偏好",
              },
            ],
          })),
        });
      }
      await request.controls.captureRawOutput(JSON.stringify(result));
      return request.schema.parse(result);
    });
    const service = (profileLimit = startBudget + 100, maxCalls = 12) =>
      new CloudProcessingService(
        db,
        { extract, describe: () => ({ model }) } as any,
        {
          enabled: true,
          profileCallLimit: profileLimit,
          maxCallsPerJob: maxCalls,
          maxOutputTokens: 1000,
          timeoutMs: 10000,
        },
        send,
      );
    const processing = service();
    const request = { expected_version: 1, source_ids: [sourceId], provider_call_cap: 4 };
    const consume = async (id: string, processor = processing) => {
      await processor.consume({
        type: "cloud_diagnostic",
        job_id: id,
        tenant_id: ctx.tenantId,
        subject_id: ctx.subjectId,
      });
      return processor.get(ctx, id);
    };
    const job = async (id: string) => {
      const [row] = await withProfileTransaction(db, ctx, (tx) =>
        tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, id)),
      );
      return row!;
    };
    const complete = async (runId = run.id) => {
      const queued = await processing.enqueue(ctx, runId, request);
      expect(await consume(queued.id)).toMatchObject({ status: "completed", error: null });
      return queued;
    };
    const attempts = async (id: string) =>
      withProfileTransaction(db, ctx, (tx) =>
        tx
          .select()
          .from(p.cloudAttempts)
          .where(eq(p.cloudAttempts.jobId, id))
          .orderBy(p.cloudAttempts.phase),
      );
    return {
      db,
      ctx,
      repository,
      run,
      question,
      sourceId,
      processing,
      service,
      request,
      consume,
      complete,
      job,
      attempts,
      budget,
      startBudget,
      send,
      extract,
      extracted,
      intercept: (hook: (input: any) => Promise<void>) => {
        afterReservation = hook;
      },
    };
  }

  describe("explicit processing continuity / isolated Postgres / synthetic gateway only", () => {
    it("gives repeated explicit cancel/restart a new stable task and never auto-restarts a cancelled delivery", async () => {
      const x = await fixture();
      let previous = await x.processing.enqueue(x.ctx, x.run.id, x.request);
      for (let i = 0; i < 3; i++) {
        const before = await x.budget();
        await x.processing.cancel(x.ctx, previous.id);
        const sends = x.send.mock.calls.length;
        expect(await x.consume(previous.id)).toMatchObject({ status: "cancelled", calls_used: 0 });
        expect(x.send).toHaveBeenCalledTimes(sends);
        expect(await x.budget()).toBe(before);
        const next = await x.processing.enqueue(x.ctx, x.run.id, x.request);
        expect(next.id).not.toBe(previous.id);
        expect(next.status).toBe("queued");
        // Lost response / repeat process resolves to the same replacement.
        expect((await x.processing.enqueue(x.ctx, x.run.id, x.request)).id).toBe(next.id);
        previous = next;
      }
      expect(x.extract).not.toHaveBeenCalled();
      expect(await x.consume(previous.id)).toMatchObject({ status: "completed", calls_used: 4 });
      expect(await x.budget()).toBe(x.startBudget + 4);
      expect(await x.repository.read(x.ctx, x.run.id)).toMatchObject({ status: "ready" });
    });

    it("preserves already-reserved profile calls after cancellation and reuses only the audited qualification", async () => {
      const x = await fixture();
      const first = await x.processing.enqueue(x.ctx, x.run.id, x.request);
      x.intercept(async (input) => {
        if (input.task === "cloud_domain_understanding") await x.processing.cancel(x.ctx, first.id);
      });
      expect(await x.consume(first.id)).toMatchObject({ status: "cancelled", calls_used: 3 });
      expect(await x.budget()).toBe(x.startBudget + 3);
      x.intercept(async () => {});
      const next = await x.processing.enqueue(x.ctx, x.run.id, {
        ...x.request,
        provider_call_cap: 2,
      });
      expect(next.id).not.toBe(first.id);
      expect(next.calls_used).toBe(0);
      expect((await x.processing.enqueue(x.ctx, x.run.id, x.request)).id).toBe(next.id);
      expect(await x.consume(next.id)).toMatchObject({ status: "completed", calls_used: 2 });
      expect(await x.budget()).toBe(x.startBudget + 5);
    });

    it.each(["JOB_CALL_CAP_EXHAUSTED", "PROFILE_CALL_CAP_EXHAUSTED"])(
      "recovers %s only after explicit higher cap and available cumulative profile budget",
      async (reason) => {
        const x = await fixture();
        const processor = x.service(
          reason.startsWith("PROFILE") ? x.startBudget + 4 : x.startBudget + 10,
          8,
        );
        const queued = await processor.enqueue(x.ctx, x.run.id, {
          ...x.request,
          provider_call_cap: reason.startsWith("PROFILE") ? 6 : 4,
        });
        await withProfileTransaction(x.db, x.ctx, async (tx) => {
          await tx.update(p.cloudJobs).set({ callsUsed: 2 }).where(eq(p.cloudJobs.id, queued.id));
          await tx
            .insert(p.cloudBudgets)
            .values({ ...x.ctx, callsUsed: x.startBudget + 2 })
            .onConflictDoUpdate({
              target: [p.cloudBudgets.tenantId, p.cloudBudgets.subjectId],
              set: { callsUsed: x.startBudget + 2 },
            });
        });
        expect(await x.consume(queued.id, processor)).toMatchObject({
          status: "failed",
          error: reason,
          calls_used: 4,
        });
        // The qualification cache appeared while the task was running. A response
        // retry must still identify this failed task rather than create another one.
        expect((await processor.enqueue(x.ctx, x.run.id, x.request)).id).toBe(queued.id);
        const saved = await x.attempts(queued.id);
        expect(saved).toHaveLength(2);
        expect(x.extracted).toEqual(["qualification", "qualification_audit"]);
        const used = await x.budget();
        expect(used).toBe(x.startBudget + 4);
        const higher = reason.startsWith("PROFILE") ? 8 : 6;
        await expect(
          processor.resume(x.ctx, queued.id, { provider_call_cap: queued.call_cap }),
        ).rejects.toThrow("JOB_BUDGET_INVALID");
        if (reason.startsWith("PROFILE"))
          await expect(
            processor.resume(x.ctx, queued.id, { provider_call_cap: higher }),
          ).rejects.toThrow("PROFILE_CALL_CAP_EXHAUSTED");
        const recovery = x.service(x.startBudget + 10, 8);
        await recovery.resume(x.ctx, queued.id, { provider_call_cap: higher });
        expect(await x.consume(queued.id, recovery)).toMatchObject({
          status: "completed",
          calls_used: 6,
          call_cap: higher,
        });
        expect(x.extracted).toEqual([
          "qualification",
          "qualification_audit",
          "report",
          "report_audit",
        ]);
        expect(await x.budget()).toBe(used + 2);
        const after = await x.attempts(queued.id);
        expect(after).toHaveLength(4);
        for (const old of saved) expect(after.find((a) => a.id === old.id)).toEqual(old);
        expect(await x.repository.read(x.ctx, x.run.id)).toMatchObject({ status: "ready" });
      },
    );

    it.each([
      "QUALIFICATION_PROOF_CHANGED",
      "REPORT_REFERENCE_INVALID",
      "CHECKPOINT_CHANGED",
      "AUDIT_FAILED",
    ])("does not reinterpret %s as budget-recoverable", async (reason) => {
      const x = await fixture();
      const queued = await x.processing.enqueue(x.ctx, x.run.id, x.request);
      await withProfileTransaction(x.db, x.ctx, (tx) =>
        tx
          .update(p.cloudJobs)
          .set({ status: "failed", error: reason })
          .where(eq(p.cloudJobs.id, queued.id)),
      );
      await expect(x.processing.resume(x.ctx, queued.id, { provider_call_cap: 8 })).rejects.toThrow(
        "NEW_INPUT_REQUIRED",
      );
      expect(x.extract).not.toHaveBeenCalled();
    });

    it.each(["different_question", "bad_latest_proof"])(
      "finds the older still-valid qualification when the latest has %s",
      async (change) => {
        const x = await fixture();
        const valid = await x.complete();
        const newer = await x.repository.create(
          x.ctx,
          {
            domain: "collaboration",
            question: change === "different_question" ? "另一个合成问题？" : x.question,
          },
          randomUUID(),
        );
        // Force a fresh qualification for the newer proof, preserving the older row.
        const [oldQualification] = await withProfileTransaction(x.db, x.ctx, (tx) =>
          tx
            .select()
            .from(p.sourceQualifications)
            .where(eq(p.sourceQualifications.jobId, valid.id)),
        );
        await withProfileTransaction(x.db, x.ctx, (tx) =>
          tx
            .update(p.sourceQualifications)
            .set({ rulesHash: "temporarily-unavailable" })
            .where(eq(p.sourceQualifications.id, oldQualification!.id)),
        );
        const latest = await x.complete(newer.id);
        await withProfileTransaction(x.db, x.ctx, async (tx) => {
          await tx
            .update(p.sourceQualifications)
            .set({ rulesHash: oldQualification!.rulesHash })
            .where(eq(p.sourceQualifications.id, oldQualification!.id));
          if (change === "bad_latest_proof")
            await tx
              .update(p.cloudAttempts)
              .set({ raw: "{}" })
              .where(
                and(
                  eq(p.cloudAttempts.jobId, latest.id),
                  eq(p.cloudAttempts.phase, "qualification"),
                ),
              );
        });
        const target = await x.repository.create(
          x.ctx,
          { domain: "collaboration", question: x.question },
          randomUUID(),
        );
        const before = await x.budget();
        expect(await x.processing.plan(x.ctx, target.id, x.request)).toMatchObject({
          required_calls: 2,
        });
        const queued = await x.processing.enqueue(x.ctx, target.id, {
          ...x.request,
          provider_call_cap: 2,
        });
        expect(
          PipelineInput.parse((await x.job(queued.id)).input).qualification_jobs[x.sourceId],
        ).toBe(valid.id);
        expect(await x.consume(queued.id)).toMatchObject({ status: "completed", calls_used: 2 });
        expect(await x.budget()).toBe(before + 2);
      },
    );

    it.each(["question", "rules", "original", "domain"])(
      "does not reuse qualification across changed %s",
      async (change) => {
        const x = await fixture();
        const valid = await x.complete();
        await withProfileTransaction(x.db, x.ctx, async (tx) => {
          if (change === "rules")
            await tx
              .update(p.sourceQualifications)
              .set({ rulesHash: "old-rules" })
              .where(eq(p.sourceQualifications.jobId, valid.id));
          if (change === "original")
            await tx
              .update(c.sourceItems)
              .set({ content: "新的合成原话。" })
              .where(eq(c.sourceItems.id, x.sourceId));
        });
        const target = await x.repository.create(
          x.ctx,
          {
            domain: change === "domain" ? "daily_conditions" : "collaboration",
            question: change === "question" ? "不同的合成问题？" : x.question,
          },
          randomUUID(),
        );
        expect(await x.processing.plan(x.ctx, target.id, x.request)).toMatchObject({
          required_calls: 4,
        });
      },
    );

    it("retains a valid previous report's source when explicitly processing an ordinary new supplement", async () => {
      const x = await fixture();
      await x.complete();
      const read = await x.repository.read(x.ctx, x.run.id);
      await expect(
        x.processing.enqueue(x.ctx, x.run.id, { ...x.request, expected_version: read.version }),
      ).rejects.toMatchObject({
        code: "STALE_VERSION",
      });
      const response = await x.repository.respond(
        x.ctx,
        x.run.id,
        {
          expected_version: read.version,
          report_revision_id: read.report_revision_id,
          kind: "supplement",
          note: "我也偏好先确认问题。",
        },
        randomUUID(),
      );
      const plan = await x.processing.plan(x.ctx, x.run.id, {
        expected_version: response.version,
        source_ids: [],
        provider_call_cap: 4,
      });
      expect(plan.source_ids.sort()).toEqual([x.sourceId, response.source_id].sort());
      const queued = await x.processing.enqueue(x.ctx, x.run.id, {
        expected_version: response.version,
        source_ids: [],
        provider_call_cap: 4,
      });
      expect(await x.consume(queued.id)).toMatchObject({ status: "completed" });
      expect(await x.repository.read(x.ctx, x.run.id)).toMatchObject({ status: "ready" });
    });
  });
}
