import { z } from "zod";

export const KnowledgeCoverageDisposition = z.enum([
  "successful",
  "reused",
  "background",
  "unknown",
  "excluded",
  "failed",
  "unprocessed",
]);

export const KnowledgeFeedbackKind = z.enum([
  "fact_correction",
  "interpretation_disagreement",
  "temporal_change",
  "utility_feedback",
]);

export const KnowledgeTopicProcessInput = z
  .object({
    expected_version: z.number().int().nonnegative().optional(),
    topic_key: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(1000),
    source_ids: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.source_ids).size !== value.source_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_ids"],
        message: "source_ids must be unique",
      });
    }
  });

export const KnowledgeFeedbackInput = z
  .object({
    expected_version: z.number().int().positive(),
    kind: KnowledgeFeedbackKind,
    note: z.string().trim().min(1).max(5000),
    claim_revision_ids: z.array(z.string().uuid()).max(100).default([]),
  })
  .strict();

export const KnowledgeEvidenceItem = z.object({
  source_id: z.string().uuid(),
  span_id: z.string().uuid(),
  claim_id: z.string().uuid(),
  claim_revision_id: z.string().uuid(),
  claim_text: z.string(),
  claim_scope: z.string(),
  relation: z.enum(["supports", "challenges", "contextualizes"]),
  independence_group: z.string().min(1),
  quote: z.string(),
  locator: z.record(z.unknown()),
  speaker: z.string(),
  stance: z.string(),
  occurred_at: z.string().nullable(),
  context: z.record(z.unknown()),
});

export const KnowledgeTopicResult = z.object({
  topic_key: z.string(),
  title: z.string(),
  question: z.string(),
  status: z.enum(["provisional", "unknown", "needs_review"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      claim_id: z.string().uuid(),
      claim_revision_id: z.string().uuid(),
      text: z.string(),
      scope: z.string(),
      support: z.array(KnowledgeEvidenceItem),
      counterexamples: z.array(KnowledgeEvidenceItem),
      context: z.array(KnowledgeEvidenceItem),
      independent_support_count: z.number().int().nonnegative(),
      independent_counterexample_count: z.number().int().nonnegative(),
      status: z.enum(["provisional", "contested", "unknown"]),
    }),
  ),
  gaps: z.array(z.string()),
});

export const KnowledgeProcessingRecord = z.object({
  topic_key: z.string(),
  version: z.number().int().positive(),
  record_type: z.enum(["topic_result", "feedback"]),
  source_ids: z.array(z.string().uuid()),
  span_ids: z.array(z.string().uuid()),
  claim_revision_ids: z.array(z.string().uuid()),
  basis_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.array(
    z.object({
      source_id: z.string().uuid(),
      disposition: KnowledgeCoverageDisposition,
      reason: z.string(),
      span_ids: z.array(z.string().uuid()),
    }),
  ),
  result: KnowledgeTopicResult.nullable(),
  feedback: z.array(
    z.object({
      kind: KnowledgeFeedbackKind,
      note: z.string(),
      origin_topic_key: z.string().optional(),
      claim_ids: z.array(z.string().uuid()).default([]),
      claim_revision_ids: z.array(z.string().uuid()),
      source_ids: z.array(z.string().uuid()).default([]),
      span_ids: z.array(z.string().uuid()).default([]),
      resolved_at: z.string().optional(),
      resolved_by_revision_ids: z.array(z.string().uuid()).default([]),
      evidence_dependencies: z
        .array(
          z.object({
            claim_revision_id: z.string().uuid(),
            source_id: z.string().uuid(),
            span_id: z.string().uuid(),
          }),
        )
        .default([]),
      created_at: z.string(),
    }),
  ),
  pending_review: z.boolean(),
  invalidated_dependencies: z
    .object({
      claim_ids: z.array(z.string().uuid()).default([]),
      claim_revision_ids: z.array(z.string().uuid()).default([]),
      source_ids: z.array(z.string().uuid()).default([]),
      span_ids: z.array(z.string().uuid()).default([]),
      evidence: z
        .array(
          z.object({
            claim_revision_id: z.string().uuid(),
            source_id: z.string().uuid(),
            span_id: z.string().uuid(),
          }),
        )
        .default([]),
    })
    .default({}),
  blocking_feedback: z
    .array(
      z.object({
        topic_key: z.string(),
        kind: KnowledgeFeedbackKind,
        note: z.string(),
        created_at: z.string(),
        claim_ids: z.array(z.string().uuid()),
        claim_revision_ids: z.array(z.string().uuid()),
        source_ids: z.array(z.string().uuid()),
        span_ids: z.array(z.string().uuid()),
      }),
    )
    .default([]),
  affected_topics: z.array(z.string()),
  affected_overviews: z.array(z.string()),
  historical_result: KnowledgeTopicResult.nullable(),
  created_at: z.string(),
});

export type KnowledgeCoverageDisposition = z.infer<typeof KnowledgeCoverageDisposition>;
export type KnowledgeFeedbackKind = z.infer<typeof KnowledgeFeedbackKind>;
export type KnowledgeTopicProcessInput = z.infer<typeof KnowledgeTopicProcessInput>;
export type KnowledgeFeedbackInput = z.infer<typeof KnowledgeFeedbackInput>;
export type KnowledgeEvidenceItem = z.infer<typeof KnowledgeEvidenceItem>;
export type KnowledgeTopicResult = z.infer<typeof KnowledgeTopicResult>;
export type KnowledgeProcessingRecord = z.infer<typeof KnowledgeProcessingRecord>;

export type KnowledgeClaimEvidence = {
  claimId: string;
  claimRevisionId: string;
  claimText: string;
  claimScope: string;
  sourceId: string;
  spanId: string;
  relation: string;
  independenceGroup: string;
  quote: string;
  locator: Record<string, unknown>;
  speaker: string;
  stance: string;
  occurredAt: string | null;
  context: Record<string, unknown>;
};

/** Build a transparent, bounded topic view from existing qualified personal claims only. */
export function buildKnowledgeTopicResult(input: {
  topicKey: string;
  title: string;
  question: string;
  evidence: KnowledgeClaimEvidence[];
}): KnowledgeTopicResult {
  const byRevision = new Map<string, KnowledgeClaimEvidence[]>();
  for (const item of input.evidence) {
    const list = byRevision.get(item.claimRevisionId) ?? [];
    list.push(item);
    byRevision.set(item.claimRevisionId, list);
  }

  const findings = [...byRevision.entries()]
    .map(([revisionId, items]) => {
      const first = items[0];
      if (!first) return null;
      const unique = (relation: string) => {
        const seen = new Set<string>();
        return items
          .filter((item) => item.relation === relation)
          .sort(
            (a, b) =>
              a.independenceGroup.localeCompare(b.independenceGroup) ||
              a.spanId.localeCompare(b.spanId),
          )
          .filter((item) => {
            if (seen.has(item.independenceGroup)) return false;
            seen.add(item.independenceGroup);
            return true;
          })
          .map((item) => ({
            source_id: item.sourceId,
            span_id: item.spanId,
            claim_id: item.claimId,
            claim_revision_id: item.claimRevisionId,
            claim_text: item.claimText,
            claim_scope: item.claimScope,
            relation: item.relation as "supports" | "challenges" | "contextualizes",
            independence_group: item.independenceGroup,
            quote: item.quote,
            locator: item.locator,
            speaker: item.speaker,
            stance: item.stance,
            occurred_at: item.occurredAt,
            context: item.context,
          }));
      };
      const support = unique("supports");
      const counterexamples = unique("challenges");
      const context = unique("contextualizes");
      const status: "unknown" | "contested" | "provisional" =
        support.length === 0 ? "unknown" : counterexamples.length ? "contested" : "provisional";
      return {
        claim_id: first.claimId,
        claim_revision_id: revisionId,
        text: first.claimText,
        scope: first.claimScope,
        support,
        counterexamples,
        context,
        independent_support_count: support.length,
        independent_counterexample_count: counterexamples.length,
        status,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const hasSupport = findings.some((item) => item.independent_support_count > 0);
  const hasCounterexample = findings.some((item) => item.independent_counterexample_count > 0);
  const gaps = [
    ...(!findings.length ? ["固定来源范围内没有可回溯的当前 claim revision。"] : []),
    ...(findings.length
      ? [
          "现有主库没有 topic 到 claim 的明确归属；这里仅列出固定来源范围关联的当前 claim，需据标题和问题由用户确认专题相关性。",
        ]
      : []),
    ...(!hasSupport ? ["没有满足资格的独立支持证据，不能形成专题认识。"] : []),
    ...(hasCounterexample ? ["存在反例；当前认识保持争议状态并保留反例。"] : []),
    ...(!findings.some((item) => item.context.length)
      ? ["可用情境信息有限，表达者立场或发生背景可能仍不完整。"]
      : []),
  ];
  return {
    topic_key: input.topicKey,
    title: input.title,
    question: input.question,
    status: hasSupport ? "provisional" : "unknown",
    summary: hasSupport
      ? "以下仅呈现固定来源范围内已有且可追溯的本人认识；支持与反例按独立来源组去重。"
      : "现有材料不足以形成此专题结论。",
    findings,
    gaps,
  };
}
