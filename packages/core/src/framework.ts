import { z } from "zod";

const Text = z.string().trim().min(1).max(8000);
const Key = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const HttpsSourceUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:");
export const FrameworkDefinition = z
  .object({
    key: Key,
    version: Key,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    title: Text,
    creator: Text,
    publication_status: z.enum(["draft", "published", "retired"]),
    source_refs: z
      .array(z.object({ id: Key, url: HttpsSourceUrl, attribution: Text }).strict())
      .min(1),
    usage_status: z.enum(["review_required", "reviewed"]),
    source_status: Text,
    disclaimer: Text,
    efficacy: z.literal("unverified"),
    adaptation: z
      .object({
        language: Text,
        equivalence: z.literal("unverified"),
        history_mode: z.enum(["direct_interview_only", "explicit_adaptation_allowed"]),
      })
      .strict(),
    domains: z
      .array(
        z
          .object({
            key: Key,
            title: Text,
            intro_question: Text,
            min_answers: z.number().int().positive(),
            max_answers: z.number().int().positive(),
            rubric: Text,
            probes: z.array(Text).min(1),
          })
          .strict()
          .refine((d) => d.max_answers >= d.min_answers),
      )
      .min(1),
    levels: z.array(z.object({ key: Key, meaning: Text }).strict()).min(1),
    phases: z.array(z.object({ key: Key, meaning: Text }).strict()).min(1),
    concepts: z.array(z.object({ key: Key, meaning: Text }).strict()).min(1),
    lifestyle_examples: z.array(Text),
    synthesis_protocol: Text,
    plan_horizons: z.array(Key).min(1),
    boundaries: z.array(Text).min(1),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const list of [d.domains, d.levels, d.phases, d.concepts])
      if (new Set(list.map((i) => i.key)).size !== list.length)
        ctx.addIssue({ code: "custom", message: "Duplicate definition key" });
    if (new Set(d.plan_horizons).size !== d.plan_horizons.length)
      ctx.addIssue({ code: "custom", message: "Duplicate horizon" });
  });
export type FrameworkDefinition = z.infer<typeof FrameworkDefinition>;

export const FrameworkRef = z
  .object({
    source_id: Key,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: Text,
  })
  .strict();
export type FrameworkRef = z.infer<typeof FrameworkRef>;
export const FrameworkAssertion = z
  .object({
    id: Key,
    text: Text,
    basis: z.enum(["reported", "hypothesis"]),
    refs: z.array(FrameworkRef).min(1),
  })
  .strict();
export type FrameworkAssertion = z.infer<typeof FrameworkAssertion>;
const Trait = z
  .object({
    status: z.enum(["supported", "unknown", "not_asked"]),
    assessment: FrameworkAssertion.nullable(),
    reason: Text.nullable(),
  })
  .strict();
export const FrameworkDomainAssessment = z
  .object({
    domain: Key,
    evidence_status: z.enum(["supported", "unknown", "not_asked"]),
    level: Key.nullable(),
    phase: Key.nullable(),
    reason: Text,
    rationale: FrameworkAssertion.nullable(),
    knowledge: Trait,
    experience: Trait,
    skill: Trait,
    strengths: z.array(FrameworkAssertion),
    limitations: z.array(FrameworkAssertion),
    practice_mismatch: z.array(FrameworkAssertion),
    regression: z.array(FrameworkAssertion),
    channels: z.array(FrameworkAssertion),
  })
  .strict();
export type FrameworkDomainAssessment = z.infer<typeof FrameworkDomainAssessment>;
export const FrameworkSynthesis = z
  .object({
    integration: FrameworkAssertion,
    lifestyle: z.object({ name: Text, assessment: FrameworkAssertion }).strict(),
    metatype: z.object({ name: Text, assessment: FrameworkAssertion }).strict(),
    cross_domain_links: z.array(
      z
        .object({
          domains: z.array(Key).min(2),
          relation: z.enum(["block", "unlock", "interaction"]),
          assessment: FrameworkAssertion,
        })
        .strict(),
    ),
    core_problem: FrameworkAssertion,
    plans: z.array(
      z
        .object({
          horizon: Key,
          status: z.literal("proposal"),
          proposals: z.array(FrameworkAssertion).min(1),
        })
        .strict(),
    ),
    glitch_risks: z.array(FrameworkAssertion),
  })
  .strict();
export type FrameworkSynthesis = z.infer<typeof FrameworkSynthesis>;
export const FrameworkCandidate = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("question"), domain: Key, text: Text, intent: FrameworkAssertion })
    .strict(),
  z.object({ kind: z.literal("evaluation"), assessment: FrameworkDomainAssessment }).strict(),
  z.object({ kind: z.literal("synthesis"), synthesis: FrameworkSynthesis }).strict(),
]);
export type FrameworkCandidate = z.infer<typeof FrameworkCandidate>;
export const FrameworkAudit = z
  .object({
    input_hash: z.string(),
    candidate_hash: z.string(),
    source_ids: z.array(Key),
    checks: z.array(
      z
        .object({
          assertion_id: Key,
          supported: z.boolean(),
          safe: z.boolean(),
          findings: z.array(Text),
        })
        .strict(),
    ),
    findings: z.array(Text),
  })
  .strict();
export type FrameworkAudit = z.infer<typeof FrameworkAudit>;

export type FrameworkAnswer = {
  id: string;
  question_id: string;
  domain: string;
  text: string | null;
  hash: string;
  start: number;
  end: number;
  saved_at: string;
  status: "valid" | "corrected" | "excluded";
  replaces: string | null;
};
export type FrameworkQuestion = { id: string; domain: string; text: string; intent: string | null };
export type FrameworkRunView = {
  id: string;
  version: number;
  definition: FrameworkDefinition;
  mode: "direct_interview" | "history_adapted";
  protocol_status: "draft_adaptation" | "versioned_interview" | "history_adaptation";
  status: "active" | "paused" | "completed" | "abandoned" | "needs_review";
  phase: "intake" | "assessing" | "synthesizing" | "review" | "completed";
  current_domain: string | null;
  open_question: FrameworkQuestion | null;
  skipped_questions: { question_id: string; domain: string; skipped_at: string }[];
  answers: FrameworkAnswer[];
  assessments: FrameworkDomainAssessment[];
  result: {
    domains: FrameworkDomainAssessment[];
    synthesis: FrameworkSynthesis;
    evidence_status: "valid";
    created_at: string;
  } | null;
  started_at: string;
  updated_at: string;
  error: string | null;
  processing: boolean;
  recovery_required: boolean;
};
export type FrameworkCatalog = {
  definitions: {
    definition: FrameworkDefinition;
    available: boolean;
    blocked_reason: "DRAFT_DISABLED" | "RETIRED" | "USAGE_REVIEW_REQUIRED" | null;
  }[];
  runs: {
    id: string;
    version: number;
    title: string;
    status: FrameworkRunView["status"];
    updated_at: string;
  }[];
  capabilities: { provider_enabled: boolean; remaining_u4_calls: number };
};
export const FrameworkStartInput = z
  .object({
    key: Key,
    definition_version: Key,
    definition_hash: z.string(),
    mode: z.enum(["direct_interview", "history_adapted"]).default("direct_interview"),
  })
  .strict();
export const FrameworkVersionInput = z
  .object({ expected_version: z.number().int().positive() })
  .strict();
export const FrameworkRespondInput = FrameworkVersionInput.extend({
  question_id: Key,
  text: z.string().max(12000),
  skipped: z.boolean().default(false),
}).strict();
export const FrameworkContinueInput = FrameworkVersionInput.extend({
  recovery: z.boolean().default(false),
}).strict();
export const FrameworkAmendInput = FrameworkVersionInput.extend({
  source_id: Key,
  action: z.enum(["correct", "exclude"]),
  text: z.string().max(12000).optional(),
  reason: Text,
}).strict();
