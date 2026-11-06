import { z } from "zod";

export const SourceKind = z.enum([
  "native_event",
  "guided_response",
  "quick_note",
  "conversation_import",
  "journal_import",
  "assessment_response",
  "external_summary",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const AuthorKind = z.enum(["subject", "assistant", "third_party", "mixed", "unknown"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

export const SourceEligibility = z.enum(["eligible", "context_only", "excluded", "needs_review"]);
export type SourceEligibility = z.infer<typeof SourceEligibility>;
export const AttributionStatus = z.enum([
  "confirmed_subject",
  "confirmed_other",
  "quoted_other",
  "mixed",
  "ambiguous",
]);
export type AttributionStatus = z.infer<typeof AttributionStatus>;

export const ContextCompleteness = z.enum(["sufficient", "partial", "thin", "unknown"]);
export type ContextCompleteness = z.infer<typeof ContextCompleteness>;

export const TemporalPrecision = z.enum(["exact", "day", "range", "approximate", "unknown"]);
export type TemporalPrecision = z.infer<typeof TemporalPrecision>;

export const EvidenceRelation = z.enum(["supports", "challenges", "contextualizes"]);
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;
export const EvidenceDirectness = z.enum(["direct", "near_direct", "indirect"]);
export type EvidenceDirectness = z.infer<typeof EvidenceDirectness>;

export const ContributionLevel = z.enum(["low", "medium", "high"]);
export type ContributionLevel = z.infer<typeof ContributionLevel>;

export const ClaimKind = z.enum([
  "background",
  "pattern",
  "value",
  "worldview",
  "life_orientation",
  "interpretation",
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimMode = z.enum(["self_report", "observation", "interpretation"]);
export type ClaimMode = z.infer<typeof ClaimMode>;
export const ClaimStatus = z.enum(["candidate", "current", "contested", "superseded", "withdrawn"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ConfidenceLevel = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const SourceAssessmentInput = z.object({
  attribution_status: AttributionStatus,
  context_completeness: ContextCompleteness,
  temporal_precision: TemporalPrecision,
  eligibility: SourceEligibility,
  rationale: z.string().min(1).max(1200),
});
export type SourceAssessmentInput = z.infer<typeof SourceAssessmentInput>;
export const EvidenceUse = z.object({
  evidence_key: z.string().min(1),
  relation: EvidenceRelation,
  directness: EvidenceDirectness,
  contribution: ContributionLevel,
  scope_match: z.string().min(1).max(600),
  rationale: z.string().min(1).max(1200),
});
export type EvidenceUse = z.infer<typeof EvidenceUse>;

/** Explicit communication preferences proposed only during requested understanding updates. */
export const InteractionPreferenceDraft = z
  .object({
    evidence_key: z.string().min(1).max(120),
    original_text: z.string().trim().min(1).max(1600),
    scope: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("turn") }).strict(),
        z.object({ kind: z.literal("conversation") }).strict(),
        z.object({ kind: z.literal("topic"), id: z.string().min(1).max(160) }).strict(),
        z.object({ kind: z.literal("task"), id: z.string().min(1).max(160) }).strict(),
        z.object({ kind: z.literal("default"), explicitlyLongTerm: z.literal(true) }).strict(),
      ])
      .default({ kind: "conversation" }),
    scope_quote: z.string().trim().min(1).max(1600).optional(),
  })
  .strict();
export type InteractionPreferenceDraft = z.infer<typeof InteractionPreferenceDraft>;

export const ClaimDraft = z.object({
  key: z.string().min(1).max(120),
  kind: ClaimKind,
  mode: ClaimMode,
  text: z.string().min(1).max(1600),
  scope: z.string().min(1).max(1000),
  confidence_level: ConfidenceLevel,
  confidence_basis: z.string().min(1).max(1200),
  evidence: z.array(EvidenceUse).min(1),
  interaction_preference: InteractionPreferenceDraft.nullish(),
});
export type ClaimDraft = z.infer<typeof ClaimDraft>;
export const KnowledgeGap = z.object({
  key: z.string().min(1).max(120),
  question: z.string().min(1).max(600),
  why_it_matters: z.string().min(1).max(900),
});
export type KnowledgeGap = z.infer<typeof KnowledgeGap>;

export const UnderstandingDraft = z.object({
  claims: z.array(ClaimDraft).max(4),
  gaps: z.array(KnowledgeGap).max(4),
  next_question: z.string().min(1).max(600).nullable(),
});
export type UnderstandingDraft = z.infer<typeof UnderstandingDraft>;

// A new experience may affect a current understanding formed elsewhere. The model
// proposes the effect; deterministic validation and a versioned revision decide it.
export const PriorUnderstandingEffect = z.enum(["unchanged", "supports", "narrows", "challenges"]);
export type PriorUnderstandingEffect = z.infer<typeof PriorUnderstandingEffect>;
export const PriorUnderstandingUpdate = z.object({
  prior_key: z.string().regex(/^P\d{1,2}$/),
  effect: PriorUnderstandingEffect,
  revised_text: z.string().min(1).max(1600).nullable().default(null),
  revised_scope: z.string().min(1).max(1000).nullable().default(null),
  rationale: z.string().min(1).max(900),
  evidence: z.array(EvidenceUse).max(4).default([]),
});
export type PriorUnderstandingUpdate = z.infer<typeof PriorUnderstandingUpdate>;
export const UnderstandingWithPriorDraft = UnderstandingDraft.extend({
  prior_updates: z.array(PriorUnderstandingUpdate).max(8).default([]),
});
export type UnderstandingWithPriorDraft = z.infer<typeof UnderstandingWithPriorDraft>;

export const CorrectionType = z.enum([
  "not_mine",
  "missing_context",
  "overinterpreted",
  "changed_now",
  "wrong_fact",
  "other",
]);
export type CorrectionType = z.infer<typeof CorrectionType>;
export const CorrectionInput = z.object({
  type: CorrectionType,
  note: z.string().min(1).max(4000),
});
export type CorrectionInput = z.infer<typeof CorrectionInput>;

export const RevisionDraft = UnderstandingDraft.extend({
  change_summary: z.string().min(1).max(1200),
  revision_reason: z.string().min(1).max(1600),
  withdrawn_claim_keys: z.array(z.string()).default([]),
});
export type RevisionDraft = z.infer<typeof RevisionDraft>;

export const UpdateSourceAssessmentInput = z.object({
  source_id: z.string().uuid(),
  expected_assessment_version: z.number().int().positive(),
  assessment: SourceAssessmentInput,
});
export type UpdateSourceAssessmentInput = z.infer<typeof UpdateSourceAssessmentInput>;
