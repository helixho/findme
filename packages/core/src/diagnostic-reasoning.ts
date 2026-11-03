import { z } from "zod";
import { AuthorKind, ClaimMode, EvidenceRelation } from "./model.js";

const Text = z.string().min(1).max(2400);
const Id = z.string().min(1).max(200);
export const ReasoningStance = z.enum([
  "reported",
  "endorsed",
  "not_endorsed",
  "opposed",
  "unknown",
]);
export const ReasoningSource = z
  .object({
    id: Id,
    session_id: Id,
    message_id: Id,
    source_uuid: Id.nullable(),
    project: z.string(),
    occurred_at: z.string().datetime({ offset: true }).nullable(),
    disclosed_at: z.string().datetime({ offset: true }).nullable(),
    group_id: Id,
    split: z.enum(["dev", "holdout"]),
    original_text: z.string(),
    revision: z.string(),
    review_revision: z.number().int().nonnegative(),
    review_notes: z.array(z.string()).default([]),
    blocked_ranges: z
      .array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }))
      .default([]),
    excluded: z.boolean(),
  })
  .strict();
export const ReasoningEvidence = z
  .object({
    id: Id,
    canonical_id: Id,
    source_id: Id,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1),
    content_author: AuthorKind,
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
    stance: ReasoningStance,
    stance_candidate: z.string(),
    provenance: z.enum(["model_candidate", "owner_review", "typed_input"]),
    attribution_notes: z.array(z.string()).default([]),
    use: z.enum(["personal_expression", "context"]),
    revision: z.string(),
    excluded: z.boolean(),
    stale: z.boolean(),
    classification_conflict: z.boolean(),
  })
  .strict();
export const EvidencePacket = z
  .object({
    format: z.literal("diagnostic-evidence-packet@1"),
    question: Text,
    question_origin: z.enum(["user_request", "test_question"]),
    sources: z.array(ReasoningSource),
    evidence: z.array(ReasoningEvidence),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const sources = new Map(packet.sources.map((s) => [s.id, s]));
    if (sources.size !== packet.sources.length) fail("Duplicate source IDs");
    if (new Set(packet.evidence.map((e) => e.id)).size !== packet.evidence.length)
      fail("Duplicate evidence IDs");
    for (const e of packet.evidence) {
      const s = sources.get(e.source_id);
      if (
        !s ||
        e.end <= e.start ||
        s.original_text.slice(e.start, e.end) !== e.quote ||
        e.end > s.original_text.length
      )
        fail("Invalid exact UTF16 span");
      if (
        e.use === "personal_expression" &&
        (e.content_author !== "subject" ||
          !["self_report", "evaluation", "choice"].includes(e.kind) ||
          e.classification_conflict)
      )
        fail("Ineligible personal expression");
    }
  });
export type EvidencePacket = z.infer<typeof EvidencePacket>;
export type ReasoningEvidence = z.infer<typeof ReasoningEvidence>;
export type ReasoningSource = z.infer<typeof ReasoningSource>;

export const RevisionOperation = z.enum([
  "unchanged",
  "clarified",
  "expanded",
  "narrowed",
  "weakened",
  "reversed",
  "withdrawn",
]);
export const RevisionRelation = z.enum([
  "supports",
  "contradicts",
  "clarifies",
  "adds_alternative",
  "irrelevant",
  "source_correction",
]);
export const AuditIssueCode = z.enum([
  "stance_escalation",
  "unsupported_revision",
  "scope_leakage",
  "manufactured_conflict",
  "question_not_discriminating",
  "unacknowledged_stop_constraints",
  "unsupported_claim",
  "stale_target",
  "task_misattribution",
  "other",
]);
const reference = (ids: string[]) =>
  ids.length ? z.enum(ids as [string, ...string[]]) : z.literal("__no_reference__");

/** The transport itself restricts every evidence basis to the supplied set. */
export function reasoningCandidateSchema(evidenceIds: string[], oldFindingIds: string[] = []) {
  const EvidenceId = reference(evidenceIds);
  const Basis = z
    .array(z.object({ evidence_id: EvidenceId, relation: EvidenceRelation }).strict())
    .max(12);
  const Finding = z
    .object({
      key: z.enum(["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "E1", "E2", "E3"]),
      text: Text,
      mode: ClaimMode,
      scope: Text,
      sufficiency: z.enum(["partial", "unknown", "sufficient_for_scope"]),
      basis: Basis,
      alternatives: z.array(Text).max(3),
      would_change: Text,
    })
    .strict();
  return z
    .object({
      headline: Text,
      presented_problem: z.string().max(2400).nullable(),
      reframe: Text,
      observations: z.array(Finding.extend({ category: z.enum(["resource", "condition"]) })).max(8),
      explanations: z.array(Finding).max(3),
      tension: z
        .object({
          kind: z.enum(["compatible_conditions", "actual_costly_tension", "unknown"]),
          text: Text,
          basis: Basis,
        })
        .strict()
        .nullable(),
      stances: z
        .array(
          z
            .object({
              evidence_id: EvidenceId,
              quote: Text,
              subject: Text,
              proposition: Text,
              stance: ReasoningStance,
            })
            .strict(),
        )
        .max(12),
      question: z
        .object({
          target_key: Id,
          text: Text,
          branches: z
            .array(z.object({ answer: Text, consequence: Text }).strict())
            .min(2)
            .max(3),
        })
        .strict()
        .nullable(),
      next_step: z
        .object({ target_key: Id, text: Text, stop: Text, constraints: Text })
        .strict()
        .nullable(),
      revisions: z
        .array(
          z
            .object({
              old_finding_id: reference(oldFindingIds),
              op: RevisionOperation,
              new_key: Id.nullable(),
              newly_disclosed_evidence_ids: z.array(EvidenceId).max(12),
              relation: RevisionRelation,
              chronology: z.enum([
                "old_fact_disclosed_late",
                "new_event",
                "source_correction",
                "no_new_information",
              ]),
              old_proposition: Text,
              new_proposition: z.string().max(2400).nullable(),
              shared_context: z.string().max(2400).nullable(),
              incompatibility: z.string().max(2400).nullable(),
              rationale: Text,
            })
            .strict(),
        )
        .max(oldFindingIds.length),
      limitations: z.array(Text).max(10),
    })
    .strict();
}
export type ReasoningCandidate = z.infer<ReturnType<typeof reasoningCandidateSchema>>;
export function reasoningAuditSchema(
  evidenceIds: string[],
  findingIds: string[],
  oldFindingIds: string[],
) {
  return z
    .object({
      task_checked: z
        .object({ question: Text, question_origin: z.enum(["user_request", "test_question"]) })
        .strict(),
      finding_checks: z.array(
        z
          .object({ finding_id: reference(findingIds), checked: z.literal(true), rationale: Text })
          .strict(),
      ),
      revision_checks: z
        .array(
          z
            .object({
              old_finding_id: reference(oldFindingIds),
              old_proposition_matches: z.boolean(),
              same_context: z.boolean(),
              concrete_incompatibility: z.boolean(),
              rationale: Text,
            })
            .strict(),
        )
        .max(oldFindingIds.length),
      issues: z
        .array(
          z
            .object({
              code: AuditIssueCode,
              finding_id: reference([...findingIds, ...oldFindingIds]).nullable(),
              evidence_ids: z.array(reference(evidenceIds)),
              severity: z.enum(["blocking", "warning"]),
              rationale: Text,
            })
            .strict(),
        )
        .max(24),
    })
    .strict();
}
export type ReasoningAudit = z.infer<ReturnType<typeof reasoningAuditSchema>>;
