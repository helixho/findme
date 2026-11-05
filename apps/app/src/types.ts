import type { CoreReportTarget } from "@findme/core";

export type ExplorationPhase =
  | "ready_to_plan"
  | "awaiting_answer"
  | "review"
  | "insufficient"
  | "needs_review"
  | "completed";

export type ExplorationOutcome = "provisional" | "insufficient" | "withdrawn";

export type GuidedQuestion = {
  id: string;
  sequence?: number;
  status?: string;
  question: string;
  intent: string;
  quick_options: string[];
};

export type ClaimView = {
  claim_id: string;
  claim_revision_id: string;
  key: string;
  kind: string;
  version?: number;
  mode: "self_report" | "observation" | "interpretation" | string;
  text: string;
  scope: string;
  evidence_status?: "valid" | "stale" | "invalid" | string;
  confidence_level: "low" | "medium" | "high" | string;
  confidence_basis: string;
  invalidation_reason?: string | null;
  updated_at?: string;
};

export type EvidenceView = {
  key: string;
  spanId: string;
  sourceItemId: string;
  quote: string;
  authorKind: string;
  eligibility: string;
  assessmentVersion?: number | null;
  attributionStatus?: string;
  contextCompleteness?: string;
  temporalPrecision?: string;
  assessmentRationale?: string | null;
};

export type GapView = {
  id?: string;
  key?: string;
  gapKey?: string;
  question: string;
  why_it_matters?: string;
  whyItMatters?: string;
};

export type ExplorationReading = {
  current_reading: string;
  key_uncertainty: string | null;
  intent: string;
  stop_reason?: string | null;
};

export type QuestionBudget = {
  asked: number;
  default_budget: number;
  hard_cap: number;
  policy_version?: string;
};

export type StartResponse = {
  exploration: {
    id: string;
    status: string;
    version: number;
    started_at?: string;
    last_activity_at?: string;
  };
  experience: { id: string; summary: string };
  phase: "ready_to_plan";
  saved: true;
};

export type RespondResponse = {
  exploration_id: string;
  experience_id: string;
  version: number;
  phase: "ready_to_plan";
  saved: true;
  source_id: string;
  input_turn_id: string;
};

export type UnderstandingResponse = {
  exploration_id: string;
  experience_id: string;
  version: number;
  phase?: "review" | "insufficient" | "needs_review";
  outcome: ExplorationOutcome | null;
  claims: ClaimView[];
  gaps: GapView[];
  needs_review?: ClaimView[];
  next_question: string | null;
  evidence: EvidenceView[];
  reading?: ExplorationReading;
  question_budget?: QuestionBudget;
};

export type RevisionResponse = UnderstandingResponse & {
  change_summary: string;
  revision_reason: string;
  before: Array<{
    key: string;
    kind: string;
    revision_id?: string;
    text?: string;
    scope?: string;
    confidence_level?: string;
  }>;
  withdrawn_claim_keys: string[];
};

export type CurrentUnderstandingResponse = {
  state: "current" | "empty" | "needs_review";
  claims: Array<ClaimView & { updated_at: string; version: number }>;
  needs_review: Array<ClaimView & { updated_at: string; version: number }>;
};

export type ExplorationSummary = {
  id: string;
  status: string;
  version: number;
  phase: ExplorationPhase;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  experience_id: string;
  summary: string;
  open_question: GuidedQuestion | null;
  parked?: boolean;
  key_uncertainty?: string | null;
};

export type ExplorationListResponse = {
  items: ExplorationSummary[];
};

export type CoreReportSource = {
  source_id: string;
  assessment_version: number;
  content_hash: string;
  content: string;
  occurred_at: string | null;
  disclosed_at: string;
};

export type ExplorationView = {
  report_target?: CoreReportTarget | null;
  report_sources?: CoreReportSource[];
  id: string;
  version: number;
  status: string;
  phase: ExplorationPhase;
  parked?: boolean;
  pending?: PendingInputs;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  experience: {
    id: string;
    summary: string;
    occurred_at: string | null;
    context: Record<string, unknown>;
  };
  open_question: GuidedQuestion | null;
  latest_step:
    | ({
        sequence: number;
        decision: "ask" | "stop";
        decision_meta?: Record<string, unknown>;
      } & ExplorationReading)
    | null;
  question_budget: QuestionBudget;
  questions: GuidedQuestion[];
  turns: Array<{
    id: string;
    role: string;
    turnKind: string;
    content: string;
    createdAt: string;
  }>;
  understanding: {
    outcome: ExplorationOutcome | null;
    claims: ClaimView[];
    gaps: GapView[];
    needs_review: ClaimView[];
  };
  evidence: EvidenceView[];
};

export type ContinueAskResponse = {
  exploration_id: string;
  experience_id: string;
  version: number;
  phase: "awaiting_answer";
  reading: ExplorationReading;
  question: GuidedQuestion;
  question_budget: QuestionBudget;
};

export type ContinueReviewResponse = UnderstandingResponse & {
  phase: "review" | "insufficient";
  reading: ExplorationReading;
  question_budget: QuestionBudget;
};

export type ContinueResponse = ContinueAskResponse | ContinueReviewResponse;

export type CompleteResponse = {
  exploration_id: string;
  version: number;
  status: "completed";
  phase: "completed";
  completed_at: string;
};

export type PriorEffectView = {
  prior_key: string;
  claim_id: string;
  from_revision_id: string;
  to_revision_id: string | null;
  effect: "unchanged" | "supports" | "narrows" | "challenges" | "skipped_stale" | "not_assessed";
  text: string;
  scope: string;
  rationale: string | null;
};

export type ProcessingView = {
  result: "revised" | "challenged" | "added" | "supported" | "unknown";
  new_claims: number;
  prior_effects: PriorEffectView[];
};

export type PriorSelectionView = {
  selection_version: string;
  used: Array<{ key: string; claim_id: string; claim_revision_id: string; version: number }>;
  excluded: Array<{ claim_id: string; claim_revision_id: string; reason: string }>;
  candidate_count: number;
  omitted_count: number;
};

export type CoreModelStatus = {
  enabled: boolean;
  window_hours: number;
  operation_limit: number;
  operations_used: number;
};

export type PendingInputs = {
  corrections: Array<{
    source_id: string;
    note: string;
    correction_type: string | null;
    claim_revision_ids: string[];
    saved_at: string;
  }>;
  messages: Array<{ source_id: string; message: string; saved_at: string }>;
  /** Replied messages whose new facts have not reached the understanding yet. */
  updates?: Array<{ source_id: string; message: string; saved_at: string }>;
};

export type UnderstandingChange = {
  claim_id: string;
  claim_revision_id: string;
  key: string;
  change: "added" | "revised" | "withdrawn";
  text: string;
  scope: string;
  reason: string | null;
  changed_at: string;
};
