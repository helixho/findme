import type { KnowledgeEvidenceItem, KnowledgeProcessingRecord } from "@findme/core";
import { coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { snapshotEvidence, union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";

export async function sanitizeHistoricalRecord(
  db: KnowledgeDb,
  ctx: PersonalContext,
  record: KnowledgeProcessingRecord,
) {
  const evidence = snapshotEvidence(record, true);
  const sourceIds = union([...record.source_ids, ...evidence.map((item) => item.source_id)]);
  if (!sourceIds.length) return record;
  const [sourceRows, replacementRows, spanRows] = await Promise.all([
    db
      .select({
        id: coreSchema.sourceItems.id,
        usageStatus: coreSchema.sourceItems.usageStatus,
        eligibility: coreSchema.sourceAssessments.eligibility,
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
          inArray(coreSchema.sourceItems.id, sourceIds),
        ),
      ),
    db
      .select({ targetId: coreSchema.sourceLinks.targetSourceItemId })
      .from(coreSchema.sourceLinks)
      .where(
        and(
          inArray(coreSchema.sourceLinks.targetSourceItemId, sourceIds),
          inArray(coreSchema.sourceLinks.relation, ["corrects", "updates"]),
        ),
      ),
    db
      .select({
        id: coreSchema.evidenceSpans.id,
        sourceId: coreSchema.evidenceSpans.sourceItemId,
        authorKind: coreSchema.evidenceSpans.authorKind,
        aboutSubject: coreSchema.evidenceSpans.aboutSubject,
      })
      .from(coreSchema.evidenceSpans)
      .where(inArray(coreSchema.evidenceSpans.sourceItemId, sourceIds)),
  ]);
  const spans = new Map(spanRows.map((row) => [row.id, row]));
  const unavailableSpan = (item: KnowledgeEvidenceItem) => {
    const span = spans.get(item.span_id);
    return (
      !span ||
      span.sourceId !== item.source_id ||
      span.authorKind !== "subject" ||
      !span.aboutSubject
    );
  };
  const sources = new Map(sourceRows.map((row) => [row.id, row]));
  const replaced = new Set(replacementRows.map((row) => row.targetId));
  const hidden = new Set(
    sourceIds.filter((id) => {
      const source = sources.get(id);
      return (
        !source ||
        source.usageStatus !== "active" ||
        source.eligibility !== "eligible" ||
        replaced.has(id)
      );
    }),
  );
  const redact = (result: KnowledgeProcessingRecord["result"]) => {
    if (!result) return null;
    const findings = result.findings.filter(
      (finding) =>
        ![...finding.support, ...finding.counterexamples, ...finding.context].some(
          (item) => hidden.has(item.source_id) || unavailableSpan(item),
        ),
    );
    return findings.length === result.findings.length
      ? result
      : {
          ...result,
          summary: "部分历史判断涉及当前不可展示的来源，相关内容已隐藏。",
          findings,
          gaps: union([...result.gaps, "来源被排除、替换或删除后，历史证据文本不再展示。"]),
        };
  };
  return {
    ...record,
    result: redact(record.result),
    historical_result: redact(record.historical_result),
    feedback: record.feedback.map((item) =>
      item.source_ids.some((id) => hidden.has(id))
        ? { ...item, note: "反馈文本涉及当前不可展示的来源，内容已隐藏。" }
        : item,
    ),
  };
}
