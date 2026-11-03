import { z } from "zod";

const Id = z.string().min(1).max(120);
const Text = z.string().min(1).max(4000);

export const ContentPublicationStatus = z.enum(["draft", "published", "withdrawn"]);

export const ContentSource = z
  .object({
    id: Id,
    title: Text,
    creator: Text,
    source_type: z.enum(["book", "publisher_page", "article", "other"]),
    url: z.string().url(),
    edition: z.string().max(300).optional(),
  })
  .strict();
export type ContentSource = z.infer<typeof ContentSource>;

export const ContentEvidenceChunk = z
  .object({
    id: Id,
    source_id: Id,
    source_version: Text,
    locator: Text,
    fragment: Text,
    fragment_kind: z.enum(["quotation", "paraphrase", "bibliographic"]),
    attribution: Text,
  })
  .strict();
export type ContentEvidenceChunk = z.infer<typeof ContentEvidenceChunk>;

export const ContentApplicabilityKey = z.enum([
  "voluntary_perspective",
  "concrete_situation",
  "role_or_self_narrative",
  "concrete_task",
  "task_start",
  "task_sustain",
  "task_switch",
  "time_estimation",
  "organization",
  "distraction",
  "noise",
  "light",
  "seating",
  "movement_break",
  "written_instructions",
  "urgent_or_crisis_support",
  "clinical_decision",
  "safety_constraint",
  "no_concrete_task",
  "no_consent",
  "no_concrete_situation",
]);
export type ContentApplicabilityKey = z.infer<typeof ContentApplicabilityKey>;

export const ContentClaim = z
  .object({
    id: Id,
    text: Text,
    evidence_chunk_ids: z.array(Id).min(1),
    applicability_keys: z.array(ContentApplicabilityKey).min(1),
    not_applicable_keys: z.array(ContentApplicabilityKey),
    applicable_when: z.array(Text).min(1),
    not_applicable_when: z.array(Text).min(1),
    alternative_explanations: z.array(Text).min(1),
    candidate_options: z.array(Text).min(1),
    burdens: z.array(Text).min(1),
    costs: z.array(Text).min(1),
    unknowns: z.array(Text).min(1),
    limits: z.array(Text).min(1),
  })
  .strict();
export type ContentClaim = z.infer<typeof ContentClaim>;

export const ContentReviewChecklist = z
  .object({
    source_verified: z.boolean(),
    locator_verified: z.boolean(),
    claims_match_sources: z.boolean(),
    applicability_and_limits_reviewed: z.boolean(),
    alternatives_reviewed: z.boolean(),
    no_personal_diagnosis_or_rating: z.boolean(),
    release_approved: z.boolean(),
    reviewer: Text.nullable(),
    reviewed_at: z.string().datetime().nullable(),
  })
  .strict();
export type ContentReviewChecklist = z.infer<typeof ContentReviewChecklist>;

export const ContentCardVersion = z
  .object({
    content_id: Id,
    version: Text,
    status: ContentPublicationStatus,
    title: Text,
    summary: Text,
    sources: z.array(ContentSource).min(1),
    evidence_chunks: z.array(ContentEvidenceChunk).min(1),
    claims: z.array(ContentClaim).min(1),
    review: ContentReviewChecklist,
    published_at: z.string().datetime().nullable(),
    withdrawn_at: z.string().datetime().nullable(),
  })
  .strict();
export type ContentCardVersion = z.infer<typeof ContentCardVersion>;

export const ContentBundle = z
  .object({
    content_id: Id,
    current_version: Text,
    versions: z.array(ContentCardVersion).min(1),
  })
  .strict();
export type ContentBundle = z.infer<typeof ContentBundle>;

export const ReflectionInput = z
  .object({
    enabled: z.boolean(),
    situation: z.string().trim().min(1).max(4000),
    claim_id: Id,
    response: z.string().max(4000).optional(),
  })
  .strict();
export type ReflectionInput = z.infer<typeof ReflectionInput>;

export function isReleaseReady(version: ContentCardVersion): boolean {
  const checks = version.review;
  return (
    version.status === "published" &&
    version.published_at !== null &&
    version.withdrawn_at === null &&
    checks.source_verified &&
    checks.locator_verified &&
    checks.claims_match_sources &&
    checks.applicability_and_limits_reviewed &&
    checks.alternatives_reviewed &&
    checks.no_personal_diagnosis_or_rating &&
    checks.release_approved
  );
}
