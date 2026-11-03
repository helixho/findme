import type {
  KnowledgeClaimEvidence,
  KnowledgeEvidenceItem,
  KnowledgeProcessingRecord,
} from "@findme/core";

export function sourceContext(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type SnapshotEvidence = KnowledgeEvidenceItem;

export function snapshotEvidence(
  record: KnowledgeProcessingRecord,
  includeHistorical = false,
): SnapshotEvidence[] {
  const findings = [
    ...(record.result?.findings ?? []),
    ...(includeHistorical ? (record.historical_result?.findings ?? []) : []),
  ];
  const rows = findings.flatMap((finding) => [
    ...finding.support,
    ...finding.counterexamples,
    ...finding.context,
  ]);
  return [
    ...new Map(
      rows.map((item) => [`${item.claim_revision_id}:${item.span_id}:${item.relation}`, item]),
    ).values(),
  ];
}

export function union(values: string[]) {
  return [...new Set(values)];
}

export function dependencyRows(
  items: Array<
    | Pick<KnowledgeClaimEvidence, "claimRevisionId" | "sourceId" | "spanId">
    | Pick<KnowledgeEvidenceItem, "claim_revision_id" | "source_id" | "span_id">
  >,
) {
  const unique = new Map<
    string,
    { claim_revision_id: string; source_id: string; span_id: string }
  >();
  for (const item of items) {
    const dependency =
      "claimRevisionId" in item
        ? {
            claim_revision_id: item.claimRevisionId,
            source_id: item.sourceId,
            span_id: item.spanId,
          }
        : {
            claim_revision_id: item.claim_revision_id,
            source_id: item.source_id,
            span_id: item.span_id,
          };
    unique.set(
      `${dependency.claim_revision_id}:${dependency.source_id}:${dependency.span_id}`,
      dependency,
    );
  }
  return [...unique.values()];
}
