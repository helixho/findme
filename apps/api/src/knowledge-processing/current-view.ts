import type { KnowledgeProcessingRecord } from "@findme/core";
import type { PersonalContext } from "../core/exploration-service.js";
import { readCurrentDependencies } from "./dependency-reading.js";
import { applyProfileBlockers } from "./profile-feedback.js";
import { snapshotEvidence, union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";
/** Recheck persisted evidence dependencies before any snapshot is presented as current. */
export async function currentView(
  db: KnowledgeDb,
  ctx: PersonalContext,
  raw: KnowledgeProcessingRecord,
) {
  const usedEvidence = snapshotEvidence(raw);
  const historicalEvidence = snapshotEvidence(raw, true);
  const sourceIds = union([...raw.source_ids, ...historicalEvidence.map((item) => item.source_id)]);
  const spanIds = union([...raw.span_ids, ...historicalEvidence.map((item) => item.span_id)]);
  if (!sourceIds.length) return applyProfileBlockers(db, ctx, raw);
  const revisionIds = union(usedEvidence.map((item) => item.claim_revision_id));
  const { sourceRows, spanRows, revisionRows, evidenceRows, replacements } =
    await readCurrentDependencies(db, ctx, sourceIds, spanIds, revisionIds);
  const sources = new Map(sourceRows.map((row) => [row.id, row]));
  const spans = new Map(spanRows.map((row) => [row.id, row]));
  const revisions = new Map(revisionRows.map((row) => [row.id, row]));
  const evidenceLinkKeys = new Set(
    evidenceRows.map((row) => `${row.claimRevisionId}:${row.spanId}:${row.relation}`),
  );
  const replacedSourceIds = new Set(replacements.map((row) => row.targetId));
  const unavailableSourceIds = new Set(
    sourceIds.filter((id) => {
      const source = sources.get(id);
      return (
        !source ||
        source.usageStatus !== "active" ||
        source.eligibility !== "eligible" ||
        replacedSourceIds.has(id)
      );
    }),
  );
  const redactResult = (value: KnowledgeProcessingRecord["result"]) => {
    if (!value) return null;
    const findings = value.findings.filter(
      (finding) =>
        ![...finding.support, ...finding.counterexamples, ...finding.context].some(
          (item) =>
            unavailableSourceIds.has(item.source_id) ||
            !spans.has(item.span_id) ||
            spans.get(item.span_id)?.sourceId !== item.source_id ||
            spans.get(item.span_id)?.authorKind !== "subject" ||
            !spans.get(item.span_id)?.aboutSubject,
        ),
    );
    if (findings.length === value.findings.length) return value;
    return {
      ...value,
      summary: "部分历史判断涉及当前不可展示的来源，相关内容已隐藏。",
      findings,
      gaps: union([...value.gaps, "来源被排除、替换或删除后，历史证据文本不再展示。"]),
    };
  };
  const invalidated = {
    claim_ids: [] as string[],
    claim_revision_ids: [] as string[],
    source_ids: [] as string[],
    span_ids: [] as string[],
    evidence: [] as { claim_revision_id: string; source_id: string; span_id: string }[],
  };
  for (const item of usedEvidence) {
    const source = sources.get(item.source_id);
    const span = spans.get(item.span_id);
    const revision = revisions.get(item.claim_revision_id);
    const sourceInvalid =
      !source ||
      source.usageStatus !== "active" ||
      source.eligibility !== "eligible" ||
      replacedSourceIds.has(item.source_id);
    const spanInvalid =
      !span ||
      span.sourceId !== item.source_id ||
      !span.aboutSubject ||
      span.authorKind !== "subject";
    const revisionInvalid =
      !revision || revision.status !== "current" || revision.evidenceStatus !== "valid";
    const linkInvalid = !evidenceLinkKeys.has(
      `${item.claim_revision_id}:${item.span_id}:${item.relation}`,
    );
    if (sourceInvalid || spanInvalid || revisionInvalid || linkInvalid) {
      invalidated.claim_ids.push(item.claim_id);
      invalidated.claim_revision_ids.push(item.claim_revision_id);
      invalidated.evidence.push({
        claim_revision_id: item.claim_revision_id,
        source_id: item.source_id,
        span_id: item.span_id,
      });
      if (sourceInvalid) invalidated.source_ids.push(item.source_id);
      if (spanInvalid || linkInvalid) invalidated.span_ids.push(item.span_id);
    }
  }
  invalidated.claim_ids = union(invalidated.claim_ids);
  invalidated.claim_revision_ids = union(invalidated.claim_revision_ids);
  invalidated.source_ids = union(invalidated.source_ids);
  invalidated.span_ids = union(invalidated.span_ids);
  const sanitizedResult = redactResult(raw.result);
  const sanitizedHistory = redactResult(raw.historical_result);
  const sanitizedFeedback = raw.feedback.map((item) =>
    item.source_ids.some((id) => unavailableSourceIds.has(id))
      ? { ...item, note: "反馈文本涉及当前不可展示的来源，内容已隐藏。" }
      : item,
  );
  if (!invalidated.claim_revision_ids.length) {
    return applyProfileBlockers(db, ctx, {
      ...raw,
      coverage: raw.coverage.map((item) => {
        const source = sources.get(item.source_id);
        if (
          !source ||
          replacedSourceIds.has(item.source_id) ||
          source.usageStatus !== "active" ||
          source.eligibility === "excluded"
        ) {
          return {
            ...item,
            disposition: "excluded" as const,
            reason: "来源已删除、停用、替换或当前资格评估为排除。",
          };
        }
        if (source.eligibility !== "eligible") {
          return {
            ...item,
            disposition: source.eligibility ? ("unknown" as const) : ("unprocessed" as const),
            reason: "来源当前不具备可用的本人证据资格。",
          };
        }
        return item;
      }),
      result: sanitizedResult,
      historical_result: sanitizedHistory,
      feedback: sanitizedFeedback,
    });
  }

  const invalidRevisionIds = new Set(invalidated.claim_revision_ids);
  const result = sanitizedResult
    ? {
        ...sanitizedResult,
        status: "needs_review" as const,
        summary:
          "来源、片段或 Claim Revision 已变化；受影响判断已从当前视图隐藏，旧版保留在历史中。",
        findings: sanitizedResult.findings.filter(
          (finding) => !invalidRevisionIds.has(finding.claim_revision_id),
        ),
        gaps: union([
          ...sanitizedResult.gaps,
          `待复核 claim revisions: ${invalidated.claim_revision_ids.join(", ")}`,
        ]),
      }
    : null;
  return applyProfileBlockers(db, ctx, {
    ...raw,
    coverage: raw.coverage.map((item) => {
      const source = sources.get(item.source_id);
      if (
        !source ||
        replacedSourceIds.has(item.source_id) ||
        source.usageStatus !== "active" ||
        source.eligibility === "excluded"
      ) {
        return {
          ...item,
          disposition: "excluded" as const,
          reason: "来源已删除、停用、替换或当前资格评估为排除。",
        };
      }
      if (source.eligibility !== "eligible") {
        return {
          ...item,
          disposition: source.eligibility ? ("unknown" as const) : ("unprocessed" as const),
          reason: "来源当前不具备可用的本人证据资格。",
        };
      }
      return item;
    }),
    result,
    feedback: sanitizedFeedback,
    pending_review: true,
    invalidated_dependencies: {
      claim_ids: union([...raw.invalidated_dependencies.claim_ids, ...invalidated.claim_ids]),
      claim_revision_ids: union([
        ...raw.invalidated_dependencies.claim_revision_ids,
        ...invalidated.claim_revision_ids,
      ]),
      source_ids: union([...raw.invalidated_dependencies.source_ids, ...invalidated.source_ids]),
      span_ids: union([...raw.invalidated_dependencies.span_ids, ...invalidated.span_ids]),
      evidence: [
        ...raw.invalidated_dependencies.evidence,
        ...invalidated.evidence.filter(
          (item) =>
            !raw.invalidated_dependencies.evidence.some(
              (old) =>
                old.claim_revision_id === item.claim_revision_id &&
                old.source_id === item.source_id &&
                old.span_id === item.span_id,
            ),
        ),
      ],
    },
    historical_result: sanitizedHistory ?? sanitizedResult,
  });
}
