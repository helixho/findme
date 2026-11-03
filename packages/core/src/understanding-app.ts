import { z } from "zod";
import type { OldClaimReview, UnderstandingReport } from "./understanding-baseline.js";
/** Transport only: private adapters and future repositories share this contract. */
export const UNDERSTANDING_APP_VERSION = "understanding-app@1";
/** Report context only. Never included in the user's original event/evidence. */
export const CoreReportTarget = z
  .object({
    baseline_version: z.string().min(1).max(200),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    domain: z.string().min(1).max(80),
    report_version: z.string().min(1).max(200),
    finding_key: z.string().min(1).max(200).optional(),
    question: z.string().min(1).max(2400).optional(),
  })
  .strict();
export type CoreReportTarget = z.infer<typeof CoreReportTarget>;
export const CoreReportSourceBinding = z
  .object({
    tenant_id: z.string().uuid(),
    subject_id: z.string().uuid(),
    exploration_id: z.string().uuid(),
    source_id: z.string().uuid(),
    assessment_version: z.number().int().positive(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    occurred_at: z.string().nullable(),
    disclosed_at: z.string(),
    attribution_basis: z.string(),
  })
  .strict();
export type CoreReportSourceBinding = z.infer<typeof CoreReportSourceBinding>;
export const CoreReportTransferInput = z
  .object({
    source_id: z.string().uuid(),
    assessment_version: z.number().int().positive(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CoreReportTransferInput = z.infer<typeof CoreReportTransferInput>;
export const UnderstandingFeedbackInput = z
  .object({
    baseline_version: z.string().min(1).max(200),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    domain: z.string().min(1).max(80),
    report_version: z.string().min(1).max(200),
    finding_key: z.string().min(1).max(200).optional(),
    context: z
      .object({ question: z.string().min(1).max(2400) })
      .strict()
      .optional(),
    type: z.enum(["disagree", "scope_only", "time_update", "supplement", "helpful"]),
    note: z.string().max(2400),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type !== "helpful" && !v.note.trim())
      ctx.addIssue({ code: "custom", message: "NOTE_REQUIRED", path: ["note"] });
  });
export type UnderstandingFeedbackInput = z.infer<typeof UnderstandingFeedbackInput>;
export type UnderstandingProcessingStatus =
  | "ready"
  | "partial"
  | "no_evidence"
  | "context_required"
  | "not_selected"
  | "needs_review"
  | "blocked";
export type UnderstandingTopicView = {
  domain: string;
  title: string;
  version: string;
  status: UnderstandingProcessingStatus;
  report: UnderstandingReport | null;
  selection: {
    scope: string;
    selected_original_atoms: number;
    canonical_count: number;
    omitted_count: number;
    repair_inputs_unavailable: number;
  };
};
export type UnderstandingFeedbackReceipt = {
  id: string;
  source_id: string;
  revision: number;
  saved_at: string;
  input: UnderstandingFeedbackInput;
  status: "saved" | "pending_analysis" | "processing" | "accepted" | "rejected" | "failed";
  result_version: string | null;
  error: string | null;
  qualification?: "pending" | "ready" | "context_only" | "rejected" | "not_applicable";
  core_source?: CoreReportSourceBinding;
  source_status?: "active" | "invalid" | "retired";
  replaces_source_id?: string;
};
export const UnderstandingOverallRequest = z
  .object({
    baseline_version: z.string().min(1),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    prior_overall_version: z.string().min(1),
    dependency_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type UnderstandingOverallRequest = z.infer<typeof UnderstandingOverallRequest>;
export const UnderstandingRecoveryRequest = z
  .object({
    recover: z.boolean().optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type UnderstandingRecoveryRequest = z.infer<typeof UnderstandingRecoveryRequest>;
export type UnderstandingAppView = {
  format: typeof UNDERSTANDING_APP_VERSION;
  baseline_version: string;
  input_hash: string;
  overall: {
    status: "ready" | "unavailable" | "needs_review";
    version: string;
    report: UnderstandingReport | null;
  };
  capabilities: {
    provider_enabled: boolean;
    remaining_calls: number;
    native_core: "unavailable" | "available";
    topic_recovery?: {
      domain: string;
      version: string;
      action: "process" | null;
      blocked_reason: string | null;
    }[];
    feedback_actions: {
      id: string;
      action: "process" | "recover" | "revise_reason" | null;
      blocked_reason: string | null;
      required_calls?: number;
    }[];
    overall: {
      status: "blocked" | "pending" | "running" | "ready" | "rejected" | "failed";
      blocked_reason: string | null;
      request: UnderstandingOverallRequest | null;
      action: "process" | "recover" | "revise_reason" | null;
      required_calls?: number;
    };
  };
  topics: UnderstandingTopicView[];
  old_dispositions: {
    version: string;
    status: "ready" | "partial" | "needs_review";
    report: OldClaimReview | null;
  };
  frameworks: {
    human_3: "not_run" | "in_progress" | "needs_review" | "completed" | "abandoned";
  };
  scope: {
    cutoff_before: string;
    source_fingerprint: string;
    exhaustive: false;
    owner_confirmed: false;
  };
  sources?: UnderstandingSourceStatus[];
  feedback: UnderstandingFeedbackReceipt[];
};
export type UnderstandingExactEvidence = {
  id: string;
  quote: string;
  qualifier: string | null;
  author: string;
  about: string;
  stance: string;
  report_time: string | null;
  scope: string;
  source_id: string;
  source_ids: string[];
  session_id: string;
  message_id: string;
  start: number;
  end: number;
  offset_unit: "utf16";
};

export type UnderstandingSourceStatus = {
  source_id: string;
  lifecycle_revision: number;
  status: "active" | "invalid" | "retired";
  reason: string | null;
  affected_domains: string[];
};
export const UnderstandingSourceAction = z
  .object({
    source_id: z.string().min(1).max(200),
    expected_lifecycle_revision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(1000),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/),
  })
  .strict();
export type UnderstandingSourceAction = z.infer<typeof UnderstandingSourceAction>;
export const UnderstandingSourceRebind = UnderstandingSourceAction.extend({
  exploration_id: z.string().uuid(),
  new_source_id: z.string().uuid(),
  target: CoreReportTarget,
});
export type UnderstandingSourceRebind = z.infer<typeof UnderstandingSourceRebind>;
export type UnderstandingReportVersion = {
  domain: string;
  version: string;
  previous_version: string | null;
  status: "accepted" | "superseded" | "needs_review" | "blocked";
  origin: "baseline" | "feedback" | "source_recovery";
  feedback_types: UnderstandingFeedbackInput["type"][];
};
export type UnderstandingReportHistory = {
  versions: UnderstandingReportVersion[];
  truncated: boolean;
};
export type UnderstandingVersionView = UnderstandingReportVersion & {
  report: UnderstandingReport | null;
};
