import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import {
  invalidateCoreSourceUnderstanding,
  lockCoreSourceExplorations,
} from "../core/source-invalidation.js";
import { invalidateCloudSources } from "./effects.js";
import { cloudSourceHash } from "./repository.js";
import { withProfileTransaction } from "./scope.js";
const SourceAction = z
  .object({
    action: z.enum(["exclude", "restore", "delete"]),
    expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_assessment_version: z.number().int().positive(),
    confirmation: z.string().optional(),
  })
  .strict();
export class CloudLifecycleService {
  constructor(private db: Db) {}
  async sources(ctx: PersonalContext, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_CURSOR");
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(eq(c.sourceItems.tenantId, ctx.tenantId), eq(c.sourceItems.subjectId, ctx.subjectId)),
        )
        .orderBy(c.sourceItems.capturedAt, c.sourceItems.id)
        .offset(offset)
        .limit(51);
      const result = [];
      for (const source of rows.slice(0, 50)) {
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
        result.push({
          id: source.id,
          text: source.usageStatus === "deleted" ? null : source.content,
          source_kind: source.sourceKind,
          reported_at: source.capturedAt.toISOString(),
          occurred_at: source.occurredAt?.toISOString() ?? null,
          status: source.usageStatus,
          hash: await cloudSourceHash(source),
          assessment_version: assessment?.version ?? null,
          eligibility: assessment?.eligibility ?? "needs_review",
        });
      }
      return { items: result, next_cursor: rows.length > 50 ? offset + 50 : null };
    });
  }
  async act(ctx: PersonalContext, id: string, raw: unknown, key: string) {
    const input = SourceAction.parse(raw);
    if (!key.trim() || key.length > 200) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (input.action === "delete" && input.confirmation !== id)
      throw new Error("DELETE_CONFIRMATION_REQUIRED");
    const hash = await requestHash({ id, ...input });
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ctx, key, "source-lifecycle"])},0))`,
      );
      const [prior] = await tx
        .select()
        .from(p.lifecycleActions)
        .where(
          and(
            eq(p.lifecycleActions.tenantId, ctx.tenantId),
            eq(p.lifecycleActions.subjectId, ctx.subjectId),
            eq(p.lifecycleActions.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (prior) {
        if (prior.requestHash !== hash) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return prior.result;
      }
      // Hard deletion later clears every Core operation of this Profile. Model
      // commits lock their operation row first, so take operation rows before
      // conversations and sources to keep one lock order.
      if (input.action === "delete")
        await tx
          .select({ id: c.coreOperations.id })
          .from(c.coreOperations)
          .where(
            and(
              eq(c.coreOperations.tenantId, ctx.tenantId),
              eq(c.coreOperations.subjectId, ctx.subjectId),
            ),
          )
          .orderBy(c.coreOperations.id)
          .for("update");
      await lockCoreSourceExplorations(tx, ctx, [id]);
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(
            eq(c.sourceItems.id, id),
            eq(c.sourceItems.tenantId, ctx.tenantId),
            eq(c.sourceItems.subjectId, ctx.subjectId),
          ),
        )
        .limit(1)
        .for("update");
      const [assessment] = await tx
        .select()
        .from(c.sourceAssessments)
        .where(
          and(eq(c.sourceAssessments.sourceItemId, id), eq(c.sourceAssessments.isCurrent, true)),
        )
        .limit(1)
        .for("update");
      if (
        !source ||
        !assessment ||
        assessment.version !== input.expected_assessment_version ||
        (await cloudSourceHash(source)) !== input.expected_hash
      )
        throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源版本已变化");
      if (source.usageStatus === "deleted")
        throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "已删除原文不可恢复");
      if (input.action === "restore" && source.usageStatus !== "excluded")
        throw new Error("SOURCE_NOT_EXCLUDED");
      const hard = input.action === "delete";
      const status = input.action === "restore" ? "active" : hard ? "deleted" : "excluded";
      await tx
        .update(c.sourceAssessments)
        .set({ isCurrent: false })
        .where(eq(c.sourceAssessments.id, assessment.id));
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: id,
        version: assessment.version + 1,
        attributionStatus: assessment.attributionStatus,
        contextCompleteness: assessment.contextCompleteness,
        temporalPrecision: assessment.temporalPrecision,
        eligibility: input.action === "restore" ? "needs_review" : "excluded",
        rationale: hard ? "source_deleted" : "用户更改来源使用状态；既有报告必须重新核验。",
        supersedesId: assessment.id,
      });
      await tx
        .update(c.sourceItems)
        .set({
          usageStatus: status,
          ...(hard
            ? {
                content: "",
                sourceMeta: { redacted: true, import_hash: source.sourceMeta?.import_hash },
              }
            : {}),
        })
        .where(eq(c.sourceItems.id, id));
      if (!hard) await invalidateCoreSourceUnderstanding(tx, ctx, [id], `source_${input.action}`);
      const affected = await invalidateCloudSources(tx, ctx, [id], hard);
      if (hard) {
        const batches = await tx
          .select()
          .from(p.importBatches)
          .where(
            and(
              eq(p.importBatches.tenantId, ctx.tenantId),
              eq(p.importBatches.subjectId, ctx.subjectId),
            ),
          );
        for (const batch of batches) {
          const batchPayload = batch.payload as Record<string, unknown>;
          if (batchPayload.kind === "u2-approved-report-import@1") {
            const identity = source.sourceMeta?.u2_evidence_identity;
            let contains = false;
            const reports = Array.isArray(batchPayload.reports)
              ? (batchPayload.reports as Record<string, unknown>[])
              : [];
            for (const report of reports) {
              const evidence = Array.isArray(report.evidence)
                ? (report.evidence as Record<string, unknown>[])
                : [];
              for (const item of evidence) {
                const candidate = await requestHash({
                  source_archive_hash: batchPayload.source_archive_hash,
                  original_source_id: item.source_id,
                  original_start: item.start,
                  original_end: item.end,
                  quote: item.quote,
                  author: item.author,
                });
                if (candidate === identity) contains = true;
              }
            }
            if (contains)
              await tx
                .update(p.importBatches)
                .set({
                  payload: {
                    kind: "u2-approved-report-import@1",
                    redacted: true,
                    input_hash: batch.inputHash,
                  },
                  status: "redacted",
                })
                .where(eq(p.importBatches.id, batch.id));
            continue;
          }
          const sources = Array.isArray(batch.payload.sources)
            ? (batch.payload.sources as Record<string, unknown>[])
            : [];
          const contains = sources.some(
            (s) =>
              `${batch.payload.namespace}:${s.external_id}@${s.version}` === source.externalRef,
          );
          if (contains)
            await tx
              .update(p.importBatches)
              .set({
                payload: { redacted: true, namespace: batch.payload.namespace },
                status: "redacted",
              })
              .where(eq(p.importBatches.id, batch.id));
        }
      }
      const result = {
        source_id: id,
        status,
        assessment_version: assessment.version + 1,
        ...affected,
        model_calls: 0,
        original_file_deletion: "separate_blob_action",
      };
      await tx.insert(p.lifecycleActions).values({
        ...ctx,
        idempotencyKey: key,
        requestHash: hash,
        sourceId: id,
        kind: input.action,
        result,
      });
      return result;
    });
  }
  async rebind(ctx: PersonalContext, id: string, raw: unknown, key: string) {
    const input = z
      .object({ expected_hash: z.string(), replacement_source_id: z.string().uuid() })
      .strict()
      .parse(raw);
    if (!key.trim() || key.length > 200) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (id === input.replacement_source_id) throw new Error("SOURCE_REBIND_SELF");
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ctx, key, "source-rebind"])},0))`,
      );
      const hash = await requestHash({ id, input });
      const [prior] = await tx
        .select()
        .from(p.lifecycleActions)
        .where(
          and(
            eq(p.lifecycleActions.tenantId, ctx.tenantId),
            eq(p.lifecycleActions.subjectId, ctx.subjectId),
            eq(p.lifecycleActions.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (prior) {
        if (prior.requestHash !== hash) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return prior.result;
      }

      await lockCoreSourceExplorations(tx, ctx, [id, input.replacement_source_id]);
      const pair = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(
            eq(c.sourceItems.tenantId, ctx.tenantId),
            eq(c.sourceItems.subjectId, ctx.subjectId),
            inArray(c.sourceItems.id, [id, input.replacement_source_id]),
          ),
        )
        .orderBy(c.sourceItems.id)
        .for("update");
      const original = pair.find((s) => s.id === id);
      const replacement = pair.find((s) => s.id === input.replacement_source_id);
      if (
        !original ||
        !replacement ||
        (await cloudSourceHash(original)) !== input.expected_hash ||
        replacement.usageStatus !== "active"
      )
        throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "替代来源不属于当前 Profile 或已变化");
      await tx
        .insert(c.sourceLinks)
        .values({
          sourceItemId: replacement.id,
          targetSourceItemId: original.id,
          relation: "corrects",
        })
        .onConflictDoNothing();
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, id));
      await invalidateCoreSourceUnderstanding(tx, ctx, [id], "source_rebound");
      const affected = await invalidateCloudSources(tx, ctx, [id]);
      const result = {
        original_source_id: id,
        replacement_source_id: replacement.id,
        ...affected,
        qualification_inherited: false,
      };
      await tx.insert(p.lifecycleActions).values({
        ...ctx,
        idempotencyKey: key,
        requestHash: hash,
        sourceId: id,
        kind: "rebind",
        result,
      });
      return result;
    });
  }
}
