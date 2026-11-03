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
    valid_time: z
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
      }),
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
export const UnderstandingImport = z
  .object({
    format: z.literal("findme-understanding-import@1"),
    namespace: key,
    sources: z
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
      .max(500),
    insights: z
      .array(
        z
          .object({
            key,
            kind: ClaimKind,
            mode: ClaimMode,
            revisions: z
              .array(
                z
                  .object({
                    version: z.number().int().positive(),
                    status: z.enum(["candidate", "contested", "withdrawn", "superseded"]),
                    text,
                    scope: text,
                    reason: text,
                    origin: span,
                    dimensions: UnderstandingDimensions,
                    evidence: z.array(span.extend({ relation: EvidenceRelation }).strict()).max(50),
                    relations: z
                      .array(
                        z
                          .object({
                            target_key: key,
                            target_version: z.number().int().positive(),
                            kind: relationKind,
                          })
                          .strict(),
                      )
                      .max(30),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
          })
          .strict(),
      )
      .max(100),
    feedback: z
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
      .max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
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
    const checkSpan = (ref: z.infer<typeof span>) => {
      const source = sources.get(ref.source_key);
      if (
        !source ||
        ref.end <= ref.start ||
        ref.end > source.text.length ||
        source.text.slice(ref.start, ref.end) !== ref.quote
      )
        issue("EXACT_SOURCE_SPAN_REQUIRED");
    };
    for (const insight of value.insights) {
      for (const [index, revision] of insight.revisions.entries()) {
        if (revision.version !== index + 1) issue("REVISION_SEQUENCE_REQUIRED");
        if (
          index < insight.revisions.length - 1 &&
          !["withdrawn", "superseded"].includes(revision.status)
        )
          issue("HISTORICAL_REVISION_MUST_BE_RETIRED");
        checkSpan(revision.origin);
        if (
          insight.mode === "self_report" &&
          sources.get(revision.origin.source_key)?.role !== "user"
        )
          issue("SELF_REPORT_REQUIRES_USER_SOURCE");
        if (new Set(revision.dimensions.domains).size !== revision.dimensions.domains.length)
          issue("DUPLICATE_DOMAIN");
        if (revision.text !== revision.origin.quote) issue("INSIGHT_MUST_MATCH_ORIGINAL_ANALYSIS");
        for (const ref of revision.evidence) {
          checkSpan(ref);
          if (ref.relation !== "contextualizes" && sources.get(ref.source_key)?.role !== "user")
            issue("ASSISTANT_IS_NOT_INDEPENDENT_PERSONAL_EVIDENCE");
        }
        for (const link of revision.relations)
          if (!revisions.has(`${link.target_key}@${link.target_version}`))
            issue("RELATION_MUST_REFERENCE_EARLIER_REVISION");
        revisions.add(`${insight.key}@${revision.version}`);
      }
    }
    for (const f of value.feedback) {
      if (sources.get(f.source_key)?.role !== "user") issue("FEEDBACK_REQUIRES_USER_SOURCE");
      if (
        f.target.type === "source"
          ? !sources.has(f.target.key)
          : !revisions.has(`${f.target.key}@${f.target.version}`)
      )
        issue("FEEDBACK_TARGET_MISSING");
    }
  });
export type UnderstandingImport = z.infer<typeof UnderstandingImport>;

/** Immutable revision metadata; links refer to exact stored revisions, never titles. */
export const StoredUnderstandingDetails = UnderstandingDimensions.extend({
  schema_version: z.literal("personal-understanding@1"),
  relations: z.array(
    z.object({ target_revision_id: z.string().uuid(), kind: relationKind }).strict(),
  ),
}).strict();
export type StoredUnderstandingDetails = z.infer<typeof StoredUnderstandingDetails>;
