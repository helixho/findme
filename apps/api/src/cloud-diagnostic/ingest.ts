import { CoreImportEnvelope } from "@findme/core";
import { type Db, coreSchema as c, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { withProfileTransaction } from "./scope.js";
export class CoreIngestService {
  constructor(private db: Db) {}
  async preview(ctx: PersonalContext, raw: unknown) {
    const parsed = CoreImportEnvelope.parse(raw);
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 2 * 1024 * 1024)
      throw new Error("IMPORT_TOO_LARGE");
    // Retain holdout identities, never their text or derived reports in the active input boundary.
    const sources = parsed.sources.filter((s) => s.split === "dev");
    if (!sources.length) throw new Error("IMPORT_HAS_NO_DEVELOPMENT_SOURCES");
    if (parsed.sources.some((s) => s.split === "holdout") && parsed.historical_reports.length)
      throw new Error("IMPORT_HISTORICAL_REPORT_SCOPE_REQUIRED");
    const envelope = {
      ...parsed,
      sources,
      holdout_ids: parsed.sources.filter((s) => s.split === "holdout").map((s) => s.external_id),
    };
    const hash = await requestHash(envelope);
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const items = [];
      for (const source of sources) {
        const externalRef = `${parsed.namespace}:${source.external_id}@${source.version}`;
        const [old] = await tx
          .select()
          .from(c.sourceItems)
          .where(
            and(
              eq(c.sourceItems.tenantId, ctx.tenantId),
              eq(c.sourceItems.subjectId, ctx.subjectId),
              eq(c.sourceItems.externalRef, externalRef),
            ),
          )
          .limit(1);
        const sourceHash = await requestHash(source);
        items.push({
          external_id: source.external_id,
          version: source.version,
          external_ref: externalRef,
          status: old ? (old.sourceMeta?.import_hash === sourceHash ? "reuse" : "conflict") : "new",
          excluded: source.excluded,
          source_hash: sourceHash,
        });
      }
      const [created] = await tx
        .insert(p.importBatches)
        .values({
          ...ctx,
          inputHash: hash,
          payload: envelope,
          result: {
            items,
            holdout_omitted: envelope.holdout_ids.length,
            historical_reports: "candidate_only",
          },
        })
        .onConflictDoNothing()
        .returning();
      const row =
        created ??
        (
          await tx
            .select()
            .from(p.importBatches)
            .where(
              and(
                eq(p.importBatches.tenantId, ctx.tenantId),
                eq(p.importBatches.subjectId, ctx.subjectId),
                eq(p.importBatches.inputHash, hash),
              ),
            )
            .limit(1)
        )[0];
      if (!row) throw new Error("IMPORT_PREVIEW_FAILED");
      return {
        id: row.id,
        input_hash: hash,
        status: row.status,
        items,
        holdout_omitted: envelope.holdout_ids.length,
        requires_confirmation: true,
      };
    });
  }
  async commit(ctx: PersonalContext, id: string, expectedHash: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const [batch] = await tx
        .select()
        .from(p.importBatches)
        .where(
          and(
            eq(p.importBatches.id, id),
            eq(p.importBatches.tenantId, ctx.tenantId),
            eq(p.importBatches.subjectId, ctx.subjectId),
          ),
        )
        .limit(1)
        .for("update");
      if (!batch || batch.inputHash !== expectedHash)
        throw new CoreError("STALE_VERSION", 409, "导入预览已变化");
      if (batch.status === "committed") return batch.result;
      if (batch.status !== "preview" || (await requestHash(batch.payload)) !== batch.inputHash)
        throw new CoreError("STALE_VERSION", 409, "导入预览不可提交");
      const { holdout_ids, ...body } = batch.payload;
      const envelope = CoreImportEnvelope.parse(body);
      const imported = [];
      for (const source of envelope.sources) {
        const externalRef = `${envelope.namespace}:${source.external_id}@${source.version}`;
        const importHash = await requestHash(source);
        const [old] = await tx
          .select()
          .from(c.sourceItems)
          .where(
            and(
              eq(c.sourceItems.tenantId, ctx.tenantId),
              eq(c.sourceItems.subjectId, ctx.subjectId),
              eq(c.sourceItems.externalRef, externalRef),
            ),
          )
          .limit(1);
        if (old) {
          if (old.sourceMeta?.import_hash !== importHash || old.usageStatus === "deleted")
            throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "已有来源与预览不一致");
          imported.push({ id: old.id, reused: true });
          continue;
        }
        const [row] = await tx
          .insert(c.sourceItems)
          .values({
            ...ctx,
            sourceKind: source.kind,
            authorKind: source.author,
            content: source.text,
            occurredAt: source.occurred_at ? new Date(source.occurred_at) : null,
            capturedAt: new Date(source.reported_at),
            externalRef,
            usageStatus: source.excluded ? "excluded" : "active",
            sourceMeta: {
              import_hash: importHash,
              import_batch: batch.id,
              namespace: envelope.namespace,
              external_id: source.external_id,
              external_version: source.version,
              root_id: `${envelope.namespace}:${source.root_id}`,
              about: source.about,
              stance: source.stance,
              split: "dev",
              owner_confirmed: false,
            },
          })
          .returning();
        if (!row) throw new Error("IMPORT_WRITE_FAILED");
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: row.id,
          version: 1,
          attributionStatus: "ambiguous",
          contextCompleteness: "unknown",
          temporalPrecision: "unknown",
          eligibility: source.excluded ? "excluded" : "needs_review",
          rationale: "导入原话；来源标签未作为本人确认或用途审核。",
        });
        for (const span of source.spans)
          await tx.insert(c.evidenceSpans).values({
            sourceItemId: row.id,
            quote: span.quote,
            locator: { start: span.start, end: span.end, import_batch: batch.id },
            authorKind: source.author,
            aboutSubject: source.about === "self",
          });
        imported.push({ id: row.id, reused: false });
      }
      const result = {
        sources: imported,
        holdout_omitted: Array.isArray(holdout_ids) ? holdout_ids.length : 0,
        historical_reports: envelope.historical_reports.length,
        historical_report_status: "candidate_only",
        model_calls: 0,
      };
      await tx
        .update(p.importBatches)
        .set({ status: "committed", result, committedAt: new Date() })
        .where(eq(p.importBatches.id, id));
      return result;
    });
  }
}
