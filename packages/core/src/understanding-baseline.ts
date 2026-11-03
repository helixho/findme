import { z } from "zod";
import { ReasoningStance } from "./diagnostic-reasoning.js";

/** Private staging/projections of existing sources; never another Core truth store. */
export const UNDERSTANDING_VERSION = "u2-understanding-baseline@1";
export const UnderstandingType = z.enum([
  "role",
  "goal",
  "constraint",
  "choice",
  "outcome",
  "evaluation",
  "preference",
  "state",
  "unknown",
]);
export const UnderstandingRelation = z.enum([
  "has_goal",
  "constrained_by",
  "chooses",
  "reports_result",
  "evaluates",
  "contrasts",
  "related_context",
]);
export const OldClaimDisposition = z.enum([
  "unchanged",
  "clarified",
  "reclassified",
  "narrowed",
  "weakened",
  "reversed",
  "withdrawn",
  "needs_review",
]);
const Text = z.string().min(1).max(2400);
const Id = z.string().min(1).max(200);
const Refs = z.array(Id).min(1).max(24);
const Scope = {
  scope: Text,
  evidence_ids: Refs,
  time: z.string().nullable(),
  status: z.enum(["reported", "inferred", "unknown"]),
};
export const UnderstandingFinding = z
  .object({
    key: Id,
    text: Text,
    ...Scope,
    evidence_ids: z.array(Id).max(24),
    counterevidence_ids: z.array(Id).max(24),
    context_ids: z.array(Id).max(24),
  })
  .strict();
const Actor = z.enum(["subject", "project", "third_party", "unknown"]);
export const UnderstandingNode = z
  .object({
    key: Id,
    type: UnderstandingType,
    text: Text,
    stance: ReasoningStance,
    actor: Actor,
    about: Actor,
    ...Scope,
  })
  .strict();
export const UnderstandingLink = z
  .object({ key: Id, type: UnderstandingRelation, from: Id, to: Id, ...Scope })
  .strict();
export const UnderstandingReport = z
  .object({
    headline: Text,
    current_understanding: UnderstandingFinding.nullable(),
    findings: z.array(UnderstandingFinding).max(4),
    resources_conditions_costs: z.array(UnderstandingFinding).max(4),
    alternatives: z.array(Text).max(4),
    unknowns: z.array(Text).max(12),
    question: z
      .object({ text: Text, branches: z.array(Text).min(2).max(3) })
      .strict()
      .nullable(),
    next_step: Text.nullable(),
    nodes: z.array(UnderstandingNode).max(8),
    links: z.array(UnderstandingLink).max(8),
  })
  .strict();
export type UnderstandingReport = z.infer<typeof UnderstandingReport>;
export const UseRepair = z
  .object({
    request_id: Id,
    decision: z.enum(["propositions", "no_change", "unknown"]),
    reason: Text,
    propositions: z
      .array(
        z
          .object({
            evidence_id: Id.nullable(),
            source_id: Id,
            quote: z.string().min(1),
            start: z.number().int().nonnegative().nullable(),
            end: z.number().int().positive().nullable(),
            type: UnderstandingType,
            stance: ReasoningStance,
            about: z.enum(["self", "project", "third_party", "unknown"]),
            kind: z.enum([
              "self_report",
              "evaluation",
              "choice",
              "work_requirement",
              "quotation",
              "system_wrapper",
              "unknown",
            ]),
            purpose: z.enum([
              "personal_expression",
              "project_report",
              "command_context",
              "context_only",
            ]),
            proposition: Text,
            scope: Text,
            reason: Text,
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export const UseRepairs = z.object({ repairs: z.array(UseRepair).max(40) }).strict();
export type UseRepairs = z.infer<typeof UseRepairs>;
export const UnderstandingAudit = z
  .object({
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    checks: z.array(
      z
        .object({
          id: Id,
          checked: z.literal(true),
          rationale: Text,
          same_context: z.boolean(),
          concrete_incompatibility: z.boolean(),
        })
        .strict(),
    ),
    issues: z
      .array(
        z
          .object({
            code: Text,
            target_id: Id.nullable(),
            evidence_ids: z.array(Id),
            severity: z.enum(["blocking", "warning"]),
            rationale: Text,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type UnderstandingAudit = z.infer<typeof UnderstandingAudit>;
export const OldClaimReview = z
  .object({
    dispositions: z
      .array(
        z
          .object({
            old_id: Id,
            disposition: OldClaimDisposition,
            text: Text.nullable(),
            scope: Text,
            new_kind: z
              .enum(["observation", "hypothesis", "tension", "compatible_conditions", "unknown"])
              .nullable(),
            evidence_ids: z.array(Id).max(24),
            reason: Text,
            shared_context: Text.nullable(),
            incompatibility: Text.nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type OldClaimReview = z.infer<typeof OldClaimReview>;
