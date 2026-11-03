import { z } from "zod";
import { validateDiagnosticRun } from "./diagnostic-validation.js";
import { AuthorKind, ClaimMode, EvidenceRelation, SourceEligibility } from "./model.js";

const Id = z.string().min(1).max(160);
const Version = z.number().int().positive();
const Text = z.string().min(1);
export const DiagnosticStatus = z.enum([
  "candidate",
  "current",
  "needs_review",
  "contested",
  "superseded",
]);
export const SourceVersionRef = z.object({
  source_id: Id,
  version: Version,
  assessment_version: Version,
});
export const FindingVersionRef = z.object({ finding_id: Id, version: Version });
export const DiagnosticSourceSnapshot = z.object({
  id: Id,
  version: Version,
  original_text: Text,
  occurred_at: Text,
  reported_at: Text,
  submitter: AuthorKind,
  content_author: AuthorKind,
  about: AuthorKind,
  expression: z.enum([
    "self_report",
    "instruction",
    "quotation",
    "summary",
    "third_party_evaluation",
  ]),
  stance: z.enum(["endorsed", "not_endorsed", "opposed", "reported", "unknown"]),
  elicitation: z.string(),
  reuse: z.enum(["direct", "historical"]),
  event_group: Id,
  availability: z.enum(["local_snapshot", "unavailable"]),
});
export type DiagnosticSourceSnapshot = z.infer<typeof DiagnosticSourceSnapshot>;
export const DiagnosticSourceAssessment = z.object({
  source_id: Id,
  source_version: Version,
  version: Version,
  eligibility: SourceEligibility,
  correction: z.enum(["initial", "excluded", "not_mine", "changed_now", "narrower_scope"]),
  note: Text,
  effective_at: Text,
});
export const DiagnosticEvidenceSnapshot = z.object({
  id: Id,
  source_id: Id,
  source_version: Version,
  // JavaScript UTF-16 offsets; original_text is immutable, never a normalized paraphrase.
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: Text,
});
export type DiagnosticEvidenceSnapshot = z.infer<typeof DiagnosticEvidenceSnapshot>;
export const DiagnosticMethod = z.object({
  id: Id,
  version: Text,
  protocol_id: Id,
  protocol_version: Text,
  adaptation: z.enum(["native", "original_protocol", "historical_adaptation"]),
  adaptation_notes: z.string(),
  input_complete: z.boolean(),
  grading: z
    .object({ allowed_values: z.array(Text).min(1), allows_historical_adaptation: z.boolean() })
    .optional(),
  required_evidence_ids: z.array(Id),
});
export const DiagnosticFinding = z.object({
  id: Id,
  version: Version,
  priority: Version,
  mode: ClaimMode,
  status: DiagnosticStatus,
  title: Text,
  text: Text,
  scope: Text,
  method_id: Id,
  evidence_sufficiency: z.enum(["sufficient_for_scope", "partial", "insufficient", "unknown"]),
  framework_grade: z.object({ framework_id: Id, protocol_version: Text, value: Text }).nullable(),
  evidence: z.array(z.object({ evidence_id: Id, relation: EvidenceRelation })),
  required_evidence_ids: z.array(Id),
  alternatives: z.array(Text),
  would_change: Text,
});
export type DiagnosticFinding = z.infer<typeof DiagnosticFinding>;
export const DiagnosticTargetQuestion = z.object({
  id: Id,
  targets: z.array(FindingVersionRef).min(1),
  text: Text,
  target_uncertainty: Text,
  why_missing: Text,
  branches: z.array(z.object({ id: Id, sample_answer: Text, consequence: Text })).min(2),
});
export const DiagnosticProposal = z.object({
  id: Id,
  targets: z.array(FindingVersionRef).min(1),
  status: z.enum(["offered", "needs_review", "declined"]),
  purpose: Text,
  step: Text,
  constraints: Text,
  interpretation: Text,
  stop: Text,
  review: Text,
});
export const ReportRevision = z.object({
  id: Id,
  run_id: Id,
  version: Version,
  previous_report_id: Id.nullable(),
  created_at: Text,
  reason: Text,
  status: DiagnosticStatus,
  question: Text,
  summary: z.object({
    text: Text,
    status: DiagnosticStatus,
    targets: z.array(FindingVersionRef).min(1),
  }),
  coverage_scope: Text,
  coverage: z.array(
    z.object({
      area: Text,
      coverage: z.enum(["observed", "partial", "unknown"]),
      note: Text,
      evidence_ids: z.array(Id),
    }),
  ),
  source_refs: z.array(SourceVersionRef),
  findings: z.array(DiagnosticFinding).min(1),
  resources: z.array(
    z.object({
      text: Text,
      evidence_ids: z.array(Id).min(1),
      status: z.enum(["available", "needs_review"]),
    }),
  ),
  constraints: z.array(Text),
  questions: z.array(DiagnosticTargetQuestion),
  proposals: z.array(DiagnosticProposal).max(1),
});
export type ReportRevision = z.infer<typeof ReportRevision>;
export const DiagnosticFeedback = z.object({
  id: Id,
  report_id: Id,
  targets: z.array(FindingVersionRef),
  kind: z.enum([
    "contested",
    "helpful",
    "changed_now",
    "narrower_scope",
    "free_text",
    "sample_answer",
    "unknown",
    "skip",
    "excluded",
    "not_mine",
  ]),
  text: z.string(),
  analysis_status: z.enum(["recorded", "pending", "scripted"]),
  created_at: Text,
});
export type DiagnosticFeedback = z.infer<typeof DiagnosticFeedback>;

export const DiagnosticRun = z
  .object({
    id: Id,
    version: Version,
    subject_kind: z.enum(["synthetic", "subject"]),
    method: DiagnosticMethod,
    sources: z.array(DiagnosticSourceSnapshot),
    assessments: z.array(DiagnosticSourceAssessment),
    evidence: z.array(DiagnosticEvidenceSnapshot),
    reports: z.array(ReportRevision).min(1),
    current_report_id: Id,
    feedback: z.array(DiagnosticFeedback),
  })
  .superRefine(validateDiagnosticRun);
export type DiagnosticRun = z.infer<typeof DiagnosticRun>;
