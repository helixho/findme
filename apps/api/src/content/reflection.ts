import type { ContentCardVersion, ContentClaim } from "@findme/core";

export function buildANewEarthReflection(
  version: ContentCardVersion,
  claim: ContentClaim,
  situation: string,
  response?: string,
) {
  const evidence = version.evidence_chunks.filter((chunk) =>
    claim.evidence_chunk_ids.includes(chunk.id),
  );
  return {
    perspective_id: version.content_id,
    version: version.version,
    enabled: true,
    situation,
    claim: claim.text,
    applicability_keys: claim.applicability_keys,
    not_applicable_keys: claim.not_applicable_keys,
    evidence: evidence.map((chunk) => ({
      source_title: version.sources.find((source) => source.id === chunk.source_id)?.title,
      source_url: version.sources.find((source) => source.id === chunk.source_id)?.url,
      source_version: chunk.source_version,
      locator: chunk.locator,
      fragment: chunk.fragment,
      attribution: chunk.attribution,
    })),
    applicable_when: claim.applicable_when,
    not_applicable_when: claim.not_applicable_when,
    alternative_explanations: claim.alternative_explanations,
    candidate_options: claim.candidate_options,
    burdens: claim.burdens,
    costs: claim.costs,
    unknowns: claim.unknowns,
    reflection_prompts: [
      "在这件具体事情里，你是否看见某个自我叙事或角色影响了自己的理解？",
      "哪些事实、责任或现实约束也能解释你的理解？",
      "这个角色是否由你认可或主动选择？你也可以不同意这个作品视角。",
    ],
    limits: claim.limits,
    user_response: response ?? null,
    response_persisted: false,
  };
}
