import { z } from "zod";
import { ClaimKind, ClaimMode, EvidenceRelation } from "./model.js";

const key = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
const text = z.string().trim().min(1).max(1600);
export const UnderstandingDomain = z.enum([
  "cognition_emotion",
  "body_recovery",
  "relationships_belonging",
  "work_creation",
  "values_meaning",
  "conditions_resources",
]);
const validTime = z
  .object({
    from: z.string().datetime({ offset: true }).nullable(),
    to: z.string().datetime({ offset: true }).nullable(),
    precision: z.enum(["unknown", "approximate", "day", "range", "exact"]),
    label: z.string().max(300).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.precision === "unknown" && (value.from || value.to))
      ctx.addIssue({ code: "custom", message: "UNKNOWN_TIME_HAS_BOUNDS" });
    if (value.precision === "exact" && !value.from)
      ctx.addIssue({ code: "custom", message: "EXACT_TIME_REQUIRES_VALUE" });
    if (value.precision !== "unknown" && !value.from && !value.to && !value.label?.trim())
      ctx.addIssue({ code: "custom", message: "KNOWN_TIME_REQUIRES_BASIS" });
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to))
      ctx.addIssue({ code: "custom", message: "INVALID_TIME_RANGE" });
  });
export const UnderstandingDimensions = z
  .object({
    domains: z.array(UnderstandingDomain).max(6),
    content_type: z.enum([
      "background",
      "role",
      "goal",
      "state",
      "pattern",
      "value",
      "narrative",
      "resource",
      "constraint",
      "explanation",
      "proposal",
    ]),
    analysis_role: z.enum([
      "background",
      "observation",
      "reframe",
      "resource",
      "constraint",
      "tension",
      "hypothesis",
      "alternative",
      "counterexample",
      "unknown",
      "next_validation",
    ]),
    context: z
      .object({
        projects: z.array(text).max(10),
        roles: z.array(text).max(10),
        situations: z.array(text).max(10),
      })
      .strict(),
    valid_time: validTime,
  })
  .strict();
export type UnderstandingDimensions = z.infer<typeof UnderstandingDimensions>;

const span = z
  .object({
    source_key: key,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: text,
  })
  .strict();
const relationKind = z.enum(["supports", "challenges", "qualifies", "alternative", "revises"]);
const relationLinks = z
  .array(
    z
      .object({
        target_key: key,
        target_version: z.number().int().positive(),
        kind: relationKind,
      })
      .strict(),
  )
  .max(30);

const sourceList = z
  .array(
    z
      .object({
        key,
        sequence: z.number().int().nonnegative(),
        role: z.enum(["user", "assistant"]),
        message_kind: z.enum(["user", "commentary", "final_answer"]).optional(),
        text: z.string().min(1).max(100000),
        recorded_at: z.string().datetime({ offset: true }).nullable(),
        time_basis: z.enum(["message", "turn_start", "unknown"]),
      })
      .strict(),
  )
  .min(1)
  .max(500);

const feedbackList = z
  .array(
    z
      .object({
        key,
        source_key: key,
        target: z.discriminatedUnion("type", [
          z.object({ type: z.literal("source"), key }).strict(),
          z
            .object({ type: z.literal("revision"), key, version: z.number().int().positive() })
            .strict(),
        ]),
        purpose: z.enum([
          "fact_agreement",
          "interpretation_agreement",
          "insight_usefulness",
          "advice_usefulness",
          "disagreement",
          "correction",
          "unspecified",
        ]),
      })
      .strict(),
  )
  .max(200);

const revisionCore = {
  version: z.number().int().positive(),
  status: z.enum(["candidate", "contested", "withdrawn", "superseded"]),
  text,
  scope: text,
  reason: text,
  dimensions: UnderstandingDimensions,
  relations: relationLinks,
};
const insightCore = { key, kind: ClaimKind, mode: ClaimMode };

/** @2: a real-world experience that several evidence spans can describe. */
const experience = z
  .object({
    key,
    label: z.string().trim().min(1).max(300),
    nature: z.enum(["occurred", "hypothetical", "ongoing", "recurring"]),
    valid_time: validTime,
  })
  .strict();
const choiceLabel = z.string().regex(/^[A-Za-z0-9]{1,8}$/);
/**
 * @2: a claim that records how the person answered a question the assistant asked.
 * The question, every option and the answer stay as exact fragments of the sources; the claim
 * text is a derived summary (never a quotation) and the answer is elicited, not spontaneous.
 */
const answerBinding = z
  .object({
    relation: z.literal("elicited_by"),
    text_basis: z.literal("derived_summary"),
    question: span,
    options: z
      .array(
        z
          .object({
            label: choiceLabel,
            text,
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
          })
          .strict(),
      )
      .min(2)
      .max(12),
    selected: z.array(choiceLabel).min(1).max(12),
    claim_label: choiceLabel,
    answer: span,
  })
  .strict();
const spanV2 = span.extend({ experience_key: key.optional() }).strict();

const revisionV1 = z
  .object({
    ...revisionCore,
    origin: span,
    evidence: z.array(span.extend({ relation: EvidenceRelation }).strict()).max(50),
  })
  .strict();
const revisionV2 = z
  .object({
    ...revisionCore,
    origin: spanV2,
    evidence: z.array(spanV2.extend({ relation: EvidenceRelation }).strict()).max(50),
    answer_binding: answerBinding.optional(),
  })
  .strict();
const insightsV1 = z
  .array(z.object({ ...insightCore, revisions: z.array(revisionV1).min(1).max(30) }).strict())
  .max(100);
const insightsV2 = z
  .array(z.object({ ...insightCore, revisions: z.array(revisionV2).min(1).max(30) }).strict())
  .max(100);

type Ref = {
  source_key: string;
  start: number;
  end: number;
  quote: string;
  experience_key?: string | undefined;
};
type Loose = {
  sources: z.infer<typeof sourceList>;
  experiences?: Array<{ key: string }>;
  insights: Array<{
    key: string;
    mode: z.infer<typeof ClaimMode>;
    revisions: Array<{
      version: number;
      status: string;
      text: string;
      origin: Ref;
      dimensions: { domains: string[] };
      evidence: Array<Ref & { relation: string }>;
      relations: Array<{ target_key: string; target_version: number }>;
      answer_binding?: z.infer<typeof answerBinding> | undefined;
    }>;
  }>;
  feedback: z.infer<typeof feedbackList>;
};

function checkImport(value: Loose, ctx: z.RefinementCtx) {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const sources = new Map(value.sources.map((s) => [s.key, s]));
  if (
    sources.size !== value.sources.length ||
    new Set(value.sources.map((s) => s.sequence)).size !== value.sources.length
  )
    issue("DUPLICATE_SOURCE_ID_OR_SEQUENCE");
  if (
    new Set(value.insights.map((i) => i.key)).size !== value.insights.length ||
    new Set(value.feedback.map((f) => f.key)).size !== value.feedback.length
  )
    issue("DUPLICATE_ITEM_KEY");
  for (const source of value.sources) {
    if ((source.time_basis === "unknown") !== (source.recorded_at === null))
      issue("RECORD_TIME_BASIS_MISMATCH");
    if (source.message_kind && (source.role === "user") !== (source.message_kind === "user"))
      issue("MESSAGE_ROLE_MISMATCH");
  }
  const revisions = new Set<string>();
  const checkSpan = (ref: Omit<Ref, "experience_key">) => {
    const source = sources.get(ref.source_key);
    if (
      !source ||
      ref.end <= ref.start ||
      ref.end > source.text.length ||
      source.text.slice(ref.start, ref.end) !== ref.quote
    )
      issue("EXACT_SOURCE_SPAN_REQUIRED");
  };
  const experiences = new Set((value.experiences ?? []).map((e) => e.key));
  if (experiences.size !== (value.experiences ?? []).length) issue("DUPLICATE_EXPERIENCE_KEY");
  const usedExperiences = new Set<string>();
  const spanExperience = new Map<string, string | undefined>();
  // The unit of independence is the exact span: one span cannot belong to two experiences,
  // and a span declared once keeps that declaration wherever it is reused.
  const checkExperience = (ref: Ref) => {
    if (ref.experience_key) {
      if (!experiences.has(ref.experience_key)) issue("UNKNOWN_EXPERIENCE");
      usedExperiences.add(ref.experience_key);
    }
    const token = `${ref.source_key}:${ref.start}:${ref.end}`;
    if (spanExperience.has(token) && spanExperience.get(token) !== ref.experience_key)
      issue("SPAN_EXPERIENCE_CONFLICT");
    spanExperience.set(token, ref.experience_key);
  };
  const sameSpan = (a: Omit<Ref, "experience_key">, b: Omit<Ref, "experience_key">) =>
    a.source_key === b.source_key && a.start === b.start && a.end === b.end;
  for (const insight of value.insights) {
    for (const [index, revision] of insight.revisions.entries()) {
      if (revision.version !== index + 1) issue("REVISION_SEQUENCE_REQUIRED");
      if (
        index < insight.revisions.length - 1 &&
        !["withdrawn", "superseded"].includes(revision.status)
      )
        issue("HISTORICAL_REVISION_MUST_BE_RETIRED");
      checkSpan(revision.origin);
      checkExperience(revision.origin);
      if (
        insight.mode === "self_report" &&
        sources.get(revision.origin.source_key)?.role !== "user"
      )
        issue("SELF_REPORT_REQUIRES_USER_SOURCE");
      if (new Set(revision.dimensions.domains).size !== revision.dimensions.domains.length)
        issue("DUPLICATE_DOMAIN");
      const binding = revision.answer_binding;
      if (!binding) {
        if (revision.text !== revision.origin.quote) issue("INSIGHT_MUST_MATCH_ORIGINAL_ANALYSIS");
      } else {
        if (insight.mode !== "self_report") issue("ANSWER_BINDING_REQUIRES_SELF_REPORT");
        const questionSource = sources.get(binding.question.source_key);
        const answerSource = sources.get(binding.answer.source_key);
        checkSpan(binding.question);
        checkSpan(binding.answer);
        if (questionSource?.role !== "assistant") issue("QUESTION_MUST_BE_ASSISTANT_TEXT");
        if (answerSource?.role !== "user") issue("ANSWER_MUST_BE_USER_TEXT");
        if (questionSource && answerSource && answerSource.sequence <= questionSource.sequence)
          issue("ANSWER_MUST_FOLLOW_QUESTION");
        if (!sameSpan(revision.origin, binding.answer)) issue("ANSWER_BINDING_ORIGIN_MISMATCH");
        const labels = binding.options.map((o) => o.label);
        if (new Set(labels).size !== labels.length) issue("DUPLICATE_OPTION_LABEL");
        if (
          new Set(binding.selected).size !== binding.selected.length ||
          !binding.selected.every((l) => labels.includes(l)) ||
          !binding.selected.includes(binding.claim_label)
        )
          issue("SELECTED_OPTION_MISSING");
        for (const option of binding.options) {
          checkSpan({
            source_key: binding.question.source_key,
            start: option.start,
            end: option.end,
            quote: option.text,
          });
          if (
            questionSource &&
            !questionSource.text
              .slice(Math.max(0, option.start - 8), option.start)
              .includes(option.label)
          )
            issue("OPTION_LABEL_NOT_FOUND");
        }
        const chosen = binding.options.find((o) => o.label === binding.claim_label);
        const has = (ref: Omit<Ref, "experience_key">, contextual: boolean) =>
          revision.evidence.some(
            (e) => sameSpan(e, ref) && (e.relation === "contextualizes") === contextual,
          );
        if (
          !has(binding.answer, false) ||
          !has(binding.question, true) ||
          (chosen &&
            !has(
              {
                source_key: binding.question.source_key,
                start: chosen.start,
                end: chosen.end,
                quote: chosen.text,
              },
              true,
            ))
        )
          issue("ANSWER_BINDING_EVIDENCE_REQUIRED");
        // A derived summary must not pass for something the person or the assistant said.
        if (
          [
            binding.answer.quote,
            binding.question.quote,
            ...binding.options.map((o) => o.text),
          ].includes(revision.text)
        )
          issue("DERIVED_TEXT_MUST_NOT_BE_QUOTE");
      }
      for (const ref of revision.evidence) {
        checkSpan(ref);
        checkExperience(ref);
        if (ref.relation !== "contextualizes" && sources.get(ref.source_key)?.role !== "user")
          issue("ASSISTANT_IS_NOT_INDEPENDENT_PERSONAL_EVIDENCE");
      }
      for (const link of revision.relations)
        if (!revisions.has(`${link.target_key}@${link.target_version}`))
          issue("RELATION_MUST_REFERENCE_EARLIER_REVISION");
      revisions.add(`${insight.key}@${revision.version}`);
    }
  }
  if ([...experiences].some((k) => !usedExperiences.has(k))) issue("EXPERIENCE_WITHOUT_EVIDENCE");
  for (const f of value.feedback) {
    if (sources.get(f.source_key)?.role !== "user") issue("FEEDBACK_REQUIRES_USER_SOURCE");
    if (
      f.target.type === "source"
        ? !sources.has(f.target.key)
        : !revisions.has(`${f.target.key}@${f.target.version}`)
    )
      issue("FEEDBACK_TARGET_MISSING");
  }
}

const importV1 = z
  .object({
    format: z.literal("findme-understanding-import@1"),
    namespace: key,
    sources: sourceList,
    insights: insightsV1,
    feedback: feedbackList,
  })
  .strict()
  .superRefine(checkImport);
const importV2 = z
  .object({
    format: z.literal("findme-understanding-import@2"),
    namespace: key,
    sources: sourceList,
    experiences: z.array(experience).max(60).default([]),
    insights: insightsV2,
    feedback: feedbackList,
  })
  .strict()
  .superRefine(checkImport);

/** `@1` packages keep their original meaning; `@2` adds answer bindings and experience groups. */
export const UnderstandingImport = z.unknown().transform((raw, ctx) => {
  const format = (raw as { format?: unknown } | null)?.format;
  const parsed =
    format === "findme-understanding-import@2" ? importV2.safeParse(raw) : importV1.safeParse(raw);
  if (!parsed.success) {
    for (const found of parsed.error.issues) ctx.addIssue(found as z.IssueData);
    return z.NEVER;
  }
  return parsed.data;
});
export type UnderstandingImport = z.infer<typeof UnderstandingImport>;

const storedRelations = z.array(
  z.object({ target_revision_id: z.string().uuid(), kind: relationKind }).strict(),
);
/** Immutable revision metadata; links refer to exact stored revisions, never titles. */
export const StoredUnderstandingDetails = z.union([
  UnderstandingDimensions.extend({
    schema_version: z.literal("personal-understanding@1"),
    relations: storedRelations,
  }).strict(),
  UnderstandingDimensions.extend({
    schema_version: z.literal("personal-understanding@2"),
    relations: storedRelations,
    text_basis: z.literal("derived_summary").optional(),
    answer_binding: answerBinding.optional(),
    experiences: z.array(
      experience.extend({ independence_group: z.string().min(1).max(400) }).strict(),
    ),
  }).strict(),
]);
export type StoredUnderstandingDetails = z.infer<typeof StoredUnderstandingDetails>;
