import { z } from "zod";
import { CorrectionInput, RevisionDraft, UnderstandingDraft } from "./model.js";
import { CoreReportTarget } from "./understanding-app.js";

export const StartExplorationInput = z.object({
  event: z.string().min(1).max(5000),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  occurred_label: z.string().max(120).optional(),
  report_target: CoreReportTarget.optional(),
  /** Answer this first message directly before any exploration (daily use). */
  reply_first: z.boolean().optional(),
});
export type StartExplorationInput = z.infer<typeof StartExplorationInput>;

export const GuidedQuestion = z.object({
  question: z.string().min(1).max(600),
  intent: z.string().min(1).max(600),
  quick_options: z.array(z.string().min(1).max(100)).max(4).default([]),
});
export type GuidedQuestion = z.infer<typeof GuidedQuestion>;

export const ExplorationPlan = z
  .object({
    current_reading: z.string().min(1).max(1200),
    key_uncertainty: z.string().min(1).max(900).nullable(),
    decision: z.enum(["ask", "stop"]),
    question: z.string().min(1).max(600).nullable(),
    intent: z.string().min(1).max(900),
    quick_options: z.array(z.string().min(1).max(120)).max(4),
    stop_reason: z.string().min(1).max(900).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "ask" && (!value.question || !value.key_uncertainty)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ask requires question and key_uncertainty",
      });
    }
    if (value.decision === "stop" && !value.stop_reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stop requires stop_reason" });
    }
  });
export type ExplorationPlan = z.infer<typeof ExplorationPlan>;

export const RespondToExplorationInput = z
  .object({
    exploration_id: z.string().uuid(),
    expected_version: z.number().int().positive(),
    question_id: z.string().uuid(),
    answer: z.string().max(5000).default(""),
    selected_options: z.array(z.string().min(1).max(120)).max(4).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.answer.trim() && value.selected_options.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer or selected_options required" });
    }
  });
export type RespondToExplorationInput = z.infer<typeof RespondToExplorationInput>;
export const ExplorationUnderstanding = UnderstandingDraft.extend({
  exploration_id: z.string().uuid(),
  experience_id: z.string().uuid(),
});
export type ExplorationUnderstanding = z.infer<typeof ExplorationUnderstanding>;

export const CorrectUnderstandingInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  claim_revision_ids: z.array(z.string().uuid()).min(1),
  correction: CorrectionInput,
});
export type CorrectUnderstandingInput = z.infer<typeof CorrectUnderstandingInput>;

export const RevisedExplorationUnderstanding = RevisionDraft.extend({
  exploration_id: z.string().uuid(),
  experience_id: z.string().uuid(),
});
export type RevisedExplorationUnderstanding = z.infer<typeof RevisedExplorationUnderstanding>;

export const ExplorationStatus = z.enum(["active", "completed", "abandoned"]);
export type ExplorationStatus = z.infer<typeof ExplorationStatus>;

export const ExplorationPhase = z.enum([
  "ready_to_plan",
  "awaiting_answer",
  "review",
  "insufficient",
  "needs_review",
  "completed",
]);
export type ExplorationPhase = z.infer<typeof ExplorationPhase>;

export const ExplorationOutcome = z.enum(["provisional", "insufficient", "withdrawn"]);
export type ExplorationOutcome = z.infer<typeof ExplorationOutcome>;

export const ContinueExplorationInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  force_deeper: z.boolean().optional().default(false),
});
export type ContinueExplorationInput = z.infer<typeof ContinueExplorationInput>;

export const CompleteExplorationInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
});
export type CompleteExplorationInput = z.infer<typeof CompleteExplorationInput>;

export const AmendSourceInput = z.object({
  exploration_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  target_source_id: z.string().uuid(),
  type: z.enum(["supplements", "corrects", "updates"]),
  note: z.string().min(1).max(5000),
});
export type AmendSourceInput = z.infer<typeof AmendSourceInput>;
