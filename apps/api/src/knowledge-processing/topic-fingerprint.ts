import type { KnowledgeTopicProcessInput } from "@findme/core";
import { basisFingerprint } from "./snapshot.js";
import type { readTopicBasis } from "./topic-evidence.js";

export async function fingerprintTopicBasis(
  input: KnowledgeTopicProcessInput,
  {
    sourceRows,
    spanRows,
    evidence,
  }: Pick<Awaited<ReturnType<typeof readTopicBasis>>, "sourceRows" | "spanRows" | "evidence">,
) {
  const sourceIds = [...input.source_ids].sort();
  const spanIds = spanRows.map((row) => row.spanId).sort();
  const claimRevisionIds = [...new Set(evidence.map((item) => item.claimRevisionId))].sort();
  const fingerprint = await basisFingerprint({
    sources: sourceRows
      .map((row) => ({
        id: row.id,
        usageStatus: row.usageStatus,
        eligibility: row.assessmentEligibility,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    spans: spanRows
      .map((row) => ({
        id: row.spanId,
        sourceId: row.sourceId,
        quote: row.quote,
        locator: row.locator,
        speaker: row.speaker,
        aboutSubject: row.aboutSubject,
        eligibility: row.eligibility,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    evidence: evidence
      .map((item) => ({
        claimRevisionId: item.claimRevisionId,
        spanId: item.spanId,
        relation: item.relation,
        independenceGroup: item.independenceGroup,
        claimText: item.claimText,
        claimScope: item.claimScope,
      }))
      .sort((a, b) =>
        `${a.claimRevisionId}:${a.spanId}`.localeCompare(`${b.claimRevisionId}:${b.spanId}`),
      ),
  });
  return { sourceIds, spanIds, claimRevisionIds, fingerprint };
}
