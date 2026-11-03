import type { ProposalInput } from "./contracts.js";
import type { PublishedClaimResolver } from "./types.js";
export const executionLabels = {
  completed: "已执行",
  not_executed: "未执行",
  partly_executed: "部分执行",
  unknown: "执行情况未知",
} as const;
export const outcomeLabels = {
  helpful: "本人报告有帮助",
  no_effect: "本人报告没有明显作用",
  worse: "本人报告情况更难",
  mixed: "本人报告有利有弊",
  unknown: "作用未知",
} as const;

export function contentBasis(
  version: NonNullable<ReturnType<PublishedClaimResolver>>["version"],
  claim: NonNullable<ReturnType<PublishedClaimResolver>>["claim"],
) {
  const chunks = version.evidence_chunks.filter((chunk) =>
    claim.evidence_chunk_ids.includes(chunk.id),
  );
  const sources = version.sources.filter((source) =>
    chunks.some((chunk) => chunk.source_id === source.id),
  );
  return {
    content_id: version.content_id,
    version: version.version,
    status: version.status,
    title: version.title,
    claim: { id: claim.id, text: claim.text, evidence_chunk_ids: claim.evidence_chunk_ids },
    applicable_when: claim.applicable_when,
    not_applicable_when: claim.not_applicable_when,
    limits: claim.limits,
    candidate_options:
      (claim as typeof claim & { candidate_options?: string[] }).candidate_options ?? [],
    burdens: (claim as typeof claim & { burdens?: string[] }).burdens ?? [],
    costs: (claim as typeof claim & { costs?: string[] }).costs ?? [],
    unknowns: (claim as typeof claim & { unknowns?: string[] }).unknowns ?? [],
    evidence_chunks: chunks,
    sources,
  };
}
export function optionKinds(option: string) {
  const kinds = new Set<ProposalInput["adjustment_kind"]>();
  if (/书面|文字说明|written/i.test(option)) kinds.add("written_instruction");
  if (/短时|专注|休息|movement|break/i.test(option)) {
    kinds.add("task_structure");
    kinds.add("movement_break");
  }
  if (/座位|光线|噪声|环境|seating|light|noise/i.test(option)) {
    kinds.add("environment");
    kinds.add("distraction_reduction");
  }
  return kinds;
}
