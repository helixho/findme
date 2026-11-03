import type {
  KnowledgeClaimEvidence,
  KnowledgeProcessingRecord,
  KnowledgeTopicProcessInput,
} from "@findme/core";
import { coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { sourceContext } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";
import { sourceLineage } from "./source-lineage.js";

export async function readTopicBasis(
  db: KnowledgeDb,
  ctx: PersonalContext,
  input: KnowledgeTopicProcessInput,
) {
  const sourceRows = await db
    .select({
      id: coreSchema.sourceItems.id,
      sourceKind: coreSchema.sourceItems.sourceKind,
      authorKind: coreSchema.sourceItems.authorKind,
      occurredAt: coreSchema.sourceItems.occurredAt,
      sourceMeta: coreSchema.sourceItems.sourceMeta,
      usageStatus: coreSchema.sourceItems.usageStatus,
      assessmentEligibility: coreSchema.sourceAssessments.eligibility,
    })
    .from(coreSchema.sourceItems)
    .leftJoin(
      coreSchema.sourceAssessments,
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        inArray(coreSchema.sourceItems.id, input.source_ids),
      ),
    );
  if (sourceRows.length !== input.source_ids.length) {
    throw new CoreError("NOT_FOUND", 404, "固定范围包含不可读取的个人来源");
  }

  const spanRows = await db
    .select({
      spanId: coreSchema.evidenceSpans.id,
      sourceId: coreSchema.evidenceSpans.sourceItemId,
      quote: coreSchema.evidenceSpans.quote,
      locator: coreSchema.evidenceSpans.locator,
      speaker: coreSchema.evidenceSpans.authorKind,
      aboutSubject: coreSchema.evidenceSpans.aboutSubject,
      sourceAuthor: coreSchema.sourceItems.authorKind,
      sourceMeta: coreSchema.sourceItems.sourceMeta,
      occurredAt: coreSchema.sourceItems.occurredAt,
      eligibility: coreSchema.sourceAssessments.eligibility,
      usageStatus: coreSchema.sourceItems.usageStatus,
    })
    .from(coreSchema.evidenceSpans)
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
    )
    .leftJoin(
      coreSchema.sourceAssessments,
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        inArray(coreSchema.sourceItems.id, input.source_ids),
      ),
    );
  const replacements = await db
    .select({ targetId: coreSchema.sourceLinks.targetSourceItemId })
    .from(coreSchema.sourceLinks)
    .where(
      and(
        inArray(coreSchema.sourceLinks.targetSourceItemId, input.source_ids),
        inArray(coreSchema.sourceLinks.relation, ["corrects", "updates"]),
      ),
    );
  const replacedSourceIds = new Set(replacements.map((row) => row.targetId));
  const qualifiedSpanIds = spanRows
    .filter(
      (row) =>
        !replacedSourceIds.has(row.sourceId) &&
        row.eligibility === "eligible" &&
        row.usageStatus === "active" &&
        row.aboutSubject &&
        row.speaker === "subject",
    )
    .map((row) => row.spanId);

  const evidenceRows = qualifiedSpanIds.length
    ? await db
        .select({
          claimId: coreSchema.claims.id,
          claimRevisionId: coreSchema.claimRevisions.id,
          claimText: coreSchema.claimRevisions.text,
          claimScope: coreSchema.claimRevisions.scope,
          sourceId: coreSchema.evidenceSpans.sourceItemId,
          spanId: coreSchema.evidenceSpans.id,
          relation: coreSchema.claimEvidence.relation,
          independenceGroup: coreSchema.claimEvidence.independenceGroup,
          quote: coreSchema.evidenceSpans.quote,
          locator: coreSchema.evidenceSpans.locator,
          speaker: coreSchema.evidenceSpans.authorKind,
          occurredAt: coreSchema.sourceItems.occurredAt,
          sourceMeta: coreSchema.sourceItems.sourceMeta,
          experienceSummary: coreSchema.experiences.summary,
          experienceContext: coreSchema.experiences.context,
        })
        .from(coreSchema.claimEvidence)
        .innerJoin(
          coreSchema.claimRevisions,
          eq(coreSchema.claimEvidence.claimRevisionId, coreSchema.claimRevisions.id),
        )
        .innerJoin(coreSchema.claims, eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id))
        .innerJoin(
          coreSchema.evidenceSpans,
          eq(coreSchema.claimEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
        )
        .innerJoin(
          coreSchema.sourceItems,
          eq(coreSchema.evidenceSpans.sourceItemId, coreSchema.sourceItems.id),
        )
        .leftJoin(
          coreSchema.experienceEvidence,
          eq(coreSchema.experienceEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
        )
        .leftJoin(
          coreSchema.experiences,
          and(
            eq(coreSchema.experienceEvidence.experienceId, coreSchema.experiences.id),
            eq(coreSchema.experiences.tenantId, ctx.tenantId),
            eq(coreSchema.experiences.subjectId, ctx.subjectId),
          ),
        )
        .where(
          and(
            eq(coreSchema.claims.tenantId, ctx.tenantId),
            eq(coreSchema.claims.subjectId, ctx.subjectId),
            eq(coreSchema.claimRevisions.status, "current"),
            eq(coreSchema.claimRevisions.evidenceStatus, "valid"),
            inArray(coreSchema.evidenceSpans.id, qualifiedSpanIds),
          ),
        )
    : [];

  const evidence: KnowledgeClaimEvidence[] = evidenceRows
    .filter((row) => ["supports", "challenges", "contextualizes"].includes(row.relation))
    .map((row) => {
      const metadata = sourceContext(row.sourceMeta);
      const context = {
        ...sourceContext(metadata.context),
        ...(row.experienceSummary ? { experience_summary: row.experienceSummary } : {}),
        ...sourceContext(row.experienceContext),
      };
      return {
        claimId: row.claimId,
        claimRevisionId: row.claimRevisionId,
        claimText: row.claimText,
        claimScope: row.claimScope,
        sourceId: row.sourceId,
        spanId: row.spanId,
        relation: row.relation,
        independenceGroup: row.independenceGroup || row.sourceId,
        quote: row.quote,
        locator: sourceContext(row.locator),
        speaker: row.speaker,
        stance: typeof metadata.stance === "string" ? metadata.stance : "未登记",
        occurredAt: row.occurredAt?.toISOString() ?? null,
        context,
      };
    });

  const spansBySource = new Map<string, string[]>();
  for (const span of spanRows) {
    const ids = spansBySource.get(span.sourceId) ?? [];
    ids.push(span.spanId);
    spansBySource.set(span.sourceId, ids);
  }
  const supportedSourceIds = new Set(evidence.map((item) => item.sourceId));
  const coverage: KnowledgeProcessingRecord["coverage"] = sourceRows.map((source) => {
    const sourceSpans = spanRows.filter((span) => span.sourceId === source.id);
    let disposition: KnowledgeProcessingRecord["coverage"][number]["disposition"];
    let reason: string;
    if (
      replacedSourceIds.has(source.id) ||
      source.usageStatus !== "active" ||
      source.assessmentEligibility === "excluded"
    ) {
      disposition = "excluded";
      reason = "来源已停用或评估标记为排除。";
    } else if (
      source.authorKind !== "subject" ||
      (sourceSpans.length > 0 &&
        sourceSpans.every((span) => !span.aboutSubject || span.speaker !== "subject"))
    ) {
      disposition = "background";
      reason = "当前范围只提供背景或非本人表达。";
    } else if (!source.assessmentEligibility) {
      disposition = "unprocessed";
      reason = "尚无当前来源资格评估，未将其计入个人证据。";
    } else if (source.assessmentEligibility !== "eligible") {
      disposition = "unknown";
      reason =
        source.sourceKind === "action_trial_review"
          ? "行动回顾来源已保存，但仍待资格复核和形成认识；当前未纳入个人证据。"
          : `来源资格为 ${source.assessmentEligibility}，当前无法作为个人证据。`;
    } else if (supportedSourceIds.has(source.id)) {
      disposition = "successful";
      reason = "已从固定来源范围内的当前个人认识读取到可追溯证据。";
    } else if (
      sourceSpans.some(
        (span) =>
          span.eligibility === "eligible" && span.aboutSubject && span.speaker === "subject",
      )
    ) {
      disposition = "unknown";
      reason = "来源资格通过，但当前认识中没有与本专题关联的支持、反例或情境链接。";
    } else {
      disposition = "unprocessed";
      reason = "来源没有可用的本人片段，未被用于专题判断。";
    }
    return {
      source_id: source.id,
      disposition,
      reason,
      span_ids: spansBySource.get(source.id) ?? [],
    };
  });

  // Collapse full derived/quoted lineages and existing event groups together.
  const lineage = await sourceLineage(db, input.source_ids, evidence);
  for (const item of coverage) {
    if (lineage.reusedSources.has(item.source_id) && item.disposition === "successful") {
      item.disposition = "reused";
      item.reason = "来源与已存在材料有派生/引用关系；沿用证据身份，不增加独立份数。";
    }
  }

  return { sourceRows, spanRows, evidence, coverage };
}
