import { type CoreReportSourceBinding, CoreReportTarget } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-service.js";
import { requestHash } from "./operations.js";
import type { CoreReportBackend, ReportSource } from "./report-bridge.js";

type SourceSnapshot = {
  source: typeof coreSchema.sourceItems.$inferSelect;
  assessment: typeof coreSchema.sourceAssessments.$inferSelect;
  turn: typeof coreSchema.explorationTurns.$inferSelect;
  replaced: boolean;
};
/** Fail closed; an eligible span/claim alone is insufficient to import original input. */
export async function eligibleReportSource(
  ctx: PersonalContext,
  explorationId: string,
  row: SourceSnapshot,
): Promise<ReportSource> {
  const { source, assessment, turn } = row;
  if (source.tenantId !== ctx.tenantId || source.subjectId !== ctx.subjectId)
    throw new CoreError("REPORT_OWNER_MISMATCH", 403, "当前身份无权使用这条来源");
  if (
    turn.explorationId !== explorationId ||
    turn.sourceItemId !== source.id ||
    assessment.sourceItemId !== source.id ||
    !assessment.isCurrent ||
    turn.content !== source.content
  )
    throw new CoreError("REPORT_SOURCE_INELIGIBLE", 409, "来源绑定或当前资格记录不完整");
  if (!["active", "excluded", "deleted"].includes(source.usageStatus))
    throw new CoreError("REPORT_SOURCE_INELIGIBLE", 409, "来源状态无法核验");
  if (source.usageStatus !== "active" || row.replaced || assessment.eligibility === "excluded")
    throw new CoreError("REPORT_SOURCE_INELIGIBLE", 409, "所选来源已排除或替换", {
      source_state: row.replaced
        ? "REPORT_SOURCE_REPLACED"
        : source.usageStatus === "deleted"
          ? "REPORT_SOURCE_DELETED"
          : "REPORT_SOURCE_EXCLUDED",
    });
  if (
    source.authorKind !== "subject" ||
    turn.role !== "user" ||
    !["event", "answer", "correction", "amendment"].includes(turn.turnKind) ||
    !["native_event", "guided_response", "guided_amendment"].includes(source.sourceKind) ||
    assessment.eligibility !== "eligible" ||
    assessment.attributionStatus !== "confirmed_subject"
  )
    throw new CoreError("REPORT_SOURCE_INELIGIBLE", 409, "当前来源已不满足原始回应资格", {
      source_state: "STALE_REPORT_SOURCE",
    });
  // Option labels are authored by Core. Only the separately saved user free text may return.
  const content =
    turn.turnKind === "answer"
      ? typeof source.sourceMeta?.free_text === "string"
        ? source.sourceMeta.free_text
        : ""
      : source.content;
  if (!content.trim())
    throw new CoreError("REPORT_SOURCE_INELIGIBLE", 409, "所选来源没有本人原话", {
      source_state: "STALE_REPORT_SOURCE",
    });
  return {
    source_id: source.id,
    assessment_version: assessment.version,
    content_hash: await requestHash([
      {
        ...source,
        occurredAt: source.occurredAt?.toISOString() ?? null,
        capturedAt: source.capturedAt.toISOString(),
      },
      { ...assessment, createdAt: assessment.createdAt.toISOString() },
      { ...turn, createdAt: turn.createdAt.toISOString() },
    ]),
    content,
    occurred_at: source.occurredAt?.toISOString() ?? null,
    disclosed_at: source.capturedAt.toISOString(),
    attribution_basis: assessment.rationale,
  };
}
export function createCoreReportBackend(db: Db): CoreReportBackend {
  async function exploration(ctx: PersonalContext, id: string) {
    const [row] = await db
      .select()
      .from(coreSchema.explorations)
      .where(
        and(
          eq(coreSchema.explorations.id, id),
          eq(coreSchema.explorations.tenantId, ctx.tenantId),
          eq(coreSchema.explorations.subjectId, ctx.subjectId),
        ),
      )
      .limit(1);
    if (!row) throw new CoreError("NOT_FOUND", 404, "探索不存在");
    return row;
  }
  return {
    async target(ctx, id) {
      const row = await exploration(ctx, id);
      return row.ext?.report_target ? CoreReportTarget.parse(row.ext.report_target) : null;
    },
    async source(ctx, id, sourceId) {
      await exploration(ctx, id);
      const [row] = await db
        .select({
          source: coreSchema.sourceItems,
          assessment: coreSchema.sourceAssessments,
          turn: coreSchema.explorationTurns,
        })
        .from(coreSchema.sourceItems)
        .innerJoin(
          coreSchema.sourceAssessments,
          and(
            eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
            eq(coreSchema.sourceAssessments.isCurrent, true),
          ),
        )
        .innerJoin(
          coreSchema.explorationTurns,
          and(
            eq(coreSchema.explorationTurns.sourceItemId, coreSchema.sourceItems.id),
            eq(coreSchema.explorationTurns.explorationId, id),
          ),
        )
        .where(
          and(
            eq(coreSchema.sourceItems.id, sourceId),
            eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
            eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!row) {
        const [original] = await db
          .select()
          .from(coreSchema.sourceItems)
          .where(eq(coreSchema.sourceItems.id, sourceId))
          .limit(1);
        if (
          original &&
          (original.tenantId !== ctx.tenantId || original.subjectId !== ctx.subjectId)
        )
          throw new CoreError("REPORT_OWNER_MISMATCH", 403, "当前身份无权使用这条来源");
        throw new CoreError(
          "REPORT_SOURCE_INELIGIBLE",
          409,
          "来源不存在或缺少当前归属记录",
          original ? undefined : { source_state: "REPORT_SOURCE_DELETED" },
        );
      }
      const replacements = await db
        .select({ id: coreSchema.sourceLinks.id })
        .from(coreSchema.sourceLinks)
        .where(
          and(
            eq(coreSchema.sourceLinks.targetSourceItemId, sourceId),
            inArray(coreSchema.sourceLinks.relation, ["corrects", "updates"]),
          ),
        )
        .limit(1);
      return eligibleReportSource(ctx, id, { ...row, replaced: replacements.length > 0 });
    },
  };
}
export function createCoreReportVerifier(db: Db) {
  const backend = createCoreReportBackend(db);
  return async (binding: CoreReportSourceBinding, note: string) => {
    let current: ReportSource;
    try {
      current = await backend.source(
        { tenantId: binding.tenant_id, subjectId: binding.subject_id },
        binding.exploration_id,
        binding.source_id,
      );
    } catch (e) {
      if (
        e instanceof CoreError &&
        e.code === "REPORT_SOURCE_INELIGIBLE" &&
        typeof e.details?.source_state === "string"
      )
        throw new Error(e.details.source_state);
      throw e;
    }
    if (
      current.content_hash !== binding.content_hash ||
      current.assessment_version !== binding.assessment_version ||
      current.content !== note ||
      current.occurred_at !== binding.occurred_at ||
      current.disclosed_at !== binding.disclosed_at ||
      current.attribution_basis !== binding.attribution_basis
    )
      throw new CoreError("STALE_REPORT_SOURCE", 409, "报告所用原话已经失效");
  };
}
