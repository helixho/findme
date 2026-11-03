import { randomUUID } from "node:crypto";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CloudExportService } from "../../src/cloud-diagnostic/export.js";
import { prepareExportRestore } from "../../src/cloud-diagnostic/ingest-adapter.js";
import { CoreIngestService } from "../../src/cloud-diagnostic/ingest.js";
import { CloudProcessingService } from "../../src/cloud-diagnostic/processing.js";
import { PipelineInput, cloudFacts } from "../../src/cloud-diagnostic/provenance.js";
import type { CloudDiagnosticRepository } from "../../src/cloud-diagnostic/repository.js";
import { withProfileTransaction } from "../../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../../src/core/exploration-service.js";
import { UnderstandingQualification } from "../../src/understanding-app/qualification-schema.js";

type Environment = {
  db: () => Db;
  context: () => Promise<PersonalContext>;
  repository: () => CloudDiagnosticRepository;
};

// Register in the explicit isolated Postgres suite. This helper neither opens a
// connection nor loads credentials, starts services, clears tables or calls a model.
export function cloudRestoreContinuity(env: Environment) {
  describe("personal export → restore → ingest continuity / zero model", () => {
    it("keeps shared roots and known attribution through real export and pipeline selection, without inheriting old authority", async () => {
      const db = env.db();
      const ctx = await env.context();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const text = "这是用于往返验证的合成陈述。";
      const reported = new Date("2026-01-02T03:04:05Z");
      const occurred = new Date("2025-12-01T00:00:00Z");
      const claims = [
        { author: "subject", about: "self", stance: "not_endorsed" },
        { author: "third_party", about: "third_party", stance: "endorsed" },
        { author: "subject", about: "project", stance: "opposed" },
      ];
      await withProfileTransaction(db, ctx, async (tx) => {
        for (const [i, id] of ids.entries()) {
          await tx.insert(c.sourceItems).values({
            ...ctx,
            id,
            sourceKind: "quick_note",
            authorKind: claims[i]!.author,
            content: text,
            capturedAt: reported,
            occurredAt: occurred,
            usageStatus: i === 2 ? "excluded" : "active",
            sourceMeta: {
              root_id: i < 2 ? "old-profile:shared-root" : "old-profile:excluded-root",
              about: claims[i]!.about,
              stance: claims[i]!.stance,
              owner_confirmed: true,
              target_context: { report_id: randomUUID(), run_id: randomUUID(), role: "accepted" },
            },
          });
          await tx.insert(c.sourceAssessments).values({
            sourceItemId: id,
            version: 1,
            attributionStatus: "confirmed_subject",
            contextCompleteness: "sufficient",
            temporalPrecision: "exact",
            eligibility: i === 2 ? "excluded" : "eligible",
            rationale: "合成导出前的旧审核；不可继承其权威",
          });
          await tx.insert(c.evidenceSpans).values({
            sourceItemId: id,
            quote: text,
            locator: { start: 0, end: text.length },
            authorKind: claims[i]!.author,
            aboutSubject: claims[i]!.about === "self",
          });
        }
      });
      const exporter = new CloudExportService(db);
      async function exportedRows(part: string) {
        const rows: Record<string, unknown>[] = [];
        let cursor: number | null = 0;
        do {
          const page = await exporter.page(ctx, part, cursor);
          rows.push(...(page.items as Record<string, unknown>[]));
          cursor = page.next_cursor;
        } while (cursor !== null);
        return rows;
      }
      const archive = {
        format: exporter.manifest().format,
        sections: {
          sources: (await exportedRows("sources")).filter((r) => ids.includes(String(r.id))),
          evidence: (await exportedRows("evidence")).filter((r) =>
            ids.includes(String(r.source_item_id)),
          ),
          assessments: (await exportedRows("assessments")).filter((r) =>
            ids.includes(String(r.source_item_id)),
          ),
          reports: await exportedRows("reports"),
          qualifications: await exportedRows("qualifications"),
        },
      };
      expect(archive.sections.sources).toHaveLength(3);
      const authorityCounts = async () =>
        withProfileTransaction(db, ctx, async (tx) => ({
          reports: (await tx.select().from(d.diagnosticReportRevisions)).length,
          qualifications: (await tx.select().from(p.sourceQualifications)).length,
        }));
      const before = await authorityCounts();
      const extract = vi.fn(async () => {
        throw new Error("MODEL_MUST_NOT_RUN");
      });
      const send = vi.fn(async () => {});
      const processing = new CloudProcessingService(
        db,
        { extract, describe: () => ({ model: "zero-model-restore-fixture" }) } as any,
        {
          enabled: true,
          profileCallLimit: 0,
          maxCallsPerJob: 4,
          maxOutputTokens: 1000,
          timeoutMs: 10000,
        },
        send,
      );
      const inputs: PipelineInput[] = [];
      for (const namespace of [`restore-a-${randomUUID()}`, `restore-b-${randomUUID()}`]) {
        const prepared = prepareExportRestore(archive, namespace);
        const ingest = new CoreIngestService(db);
        for (const chunk of prepared.chunks) {
          const preview = await ingest.preview(ctx, chunk);
          await ingest.commit(ctx, preview.id, preview.input_hash);
        }
        const restored = await withProfileTransaction(db, ctx, (tx) =>
          tx.select().from(c.sourceItems),
        );
        const sources = restored.filter((r) => r.sourceMeta?.namespace === namespace);
        expect(sources).toHaveLength(3);
        for (const [i, oldId] of ids.entries()) {
          const saved = sources.find((r) => r.sourceMeta?.external_id === oldId)!;
          expect(saved).toMatchObject({
            content: text,
            authorKind: claims[i]!.author,
            capturedAt: reported,
            occurredAt: occurred,
            usageStatus: i === 2 ? "excluded" : "active",
            sourceMeta: {
              about: claims[i]!.about,
              stance: claims[i]!.stance,
              owner_confirmed: false,
            },
          });
          expect(saved.sourceMeta).not.toHaveProperty("target_context");
          const [assessment] = await withProfileTransaction(db, ctx, (tx) =>
            tx
              .select()
              .from(c.sourceAssessments)
              .where(eq(c.sourceAssessments.sourceItemId, saved.id)),
          );
          expect(assessment).toMatchObject({
            attributionStatus: "ambiguous",
            eligibility: i === 2 ? "excluded" : "needs_review",
          });
        }
        const active = sources.filter((s) => s.usageStatus === "active");
        const spans = await withProfileTransaction(db, ctx, (tx) =>
          tx
            .select()
            .from(c.evidenceSpans)
            .where(
              inArray(
                c.evidenceSpans.sourceItemId,
                sources.map((s) => s.id),
              ),
            ),
        );
        expect(spans).toHaveLength(3);
        expect(spans.every((s) => s.quote === text)).toBe(true);
        const run = await env
          .repository()
          .create(
            ctx,
            { domain: "collaboration", question: "合成往返陈述如何被理解？" },
            randomUUID(),
          );
        const queued = await processing.enqueue(ctx, run.id, {
          expected_version: 1,
          source_ids: active.map((s) => s.id),
          provider_call_cap: 4,
        });
        const [job] = await withProfileTransaction(db, ctx, (tx) =>
          tx.select().from(p.cloudJobs).where(eq(p.cloudJobs.id, queued.id)),
        );
        const input = PipelineInput.parse(job!.input);
        inputs.push(input);
        expect(new Set(input.sources.map((s) => s.root_id)).size).toBe(1);
        expect(input.sources.every((s) => s.target_context === null)).toBe(true);
        const candidate = (endorsing: boolean) =>
          UnderstandingQualification.parse({
            notes: input.sources.map((s) => ({
              note_id: s.id,
              reason: "合成命题",
              propositions: [
                {
                  quote: text,
                  start: 0,
                  end: text.length,
                  author: endorsing ? "subject" : s.author,
                  about: endorsing ? "self" : s.about,
                  stance: endorsing ? "endorsed" : s.stance,
                  kind: "evaluation",
                  type: "preference",
                  purpose: endorsing ? "personal_expression" : "context_only",
                  proposition: text,
                  scope: "本次合成往返",
                  reason: "仅作合成验证",
                },
              ],
            })),
          });
        expect(() => cloudFacts(input, candidate(true))).toThrow(
          "QUALIFICATION_ATTRIBUTION_CHANGED",
        );
        const facts = cloudFacts(input, candidate(false));
        expect(new Set(facts.flatMap((f) => f.root_ids))).toEqual(
          new Set([input.sources[0]!.root_id]),
        );
      }
      expect(inputs[0]!.sources[0]!.root_id).not.toBe(inputs[1]!.sources[0]!.root_id);
      expect(await authorityCounts()).toEqual(before);
      expect(extract).not.toHaveBeenCalled();
    });
  });
}
