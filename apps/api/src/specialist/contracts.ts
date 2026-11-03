import { z } from "zod";
export const OptionalText = (max = 1000) => z.string().trim().max(max).optional();
export const SessionBody = z
  .object({
    pathway: z.enum(["general", "adhd"]).default("adhd"),
    voluntary: z.literal(true),
    goal: OptionalText(800),
    setting: OptionalText(300),
    difficulty: OptionalText(800),
    difficulty_categories: z
      .array(
        z.enum([
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
        ]),
      )
      .max(12)
      .default([]),
    scope_flags: z
      .array(
        z.enum([
          "urgent_or_crisis_support",
          "clinical_decision",
          "safety_constraint",
          "no_concrete_task",
          "no_consent",
          "no_concrete_situation",
        ]),
      )
      .max(6)
      .default([]),
    environment: OptionalText(800),
    environment_categories: z
      .array(
        z.enum([
          "concrete_task",
          "task_sustain",
          "distraction",
          "noise",
          "light",
          "seating",
          "movement_break",
          "written_instructions",
        ]),
      )
      .max(8)
      .default([]),
    existing_supports: OptionalText(800),
    burden: OptionalText(500),
    self_reported_diagnosis: z
      .enum(["diagnosed", "concern", "none", "prefer_not_to_say"])
      .optional(),
    skipped_steps: z
      .array(z.enum(["setting", "difficulty", "environment", "existing_supports", "burden"]))
      .max(5)
      .default([]),
  })
  .strict();

// Context may be completed on the same event; entry pathway and consent stay fixed.
export const SessionUpdateBody = SessionBody.omit({ pathway: true, voluntary: true })
  .partial()
  .extend({ expected_version: z.number().int().positive() })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== "expected_version"));

export const ProposalBody = z
  .object({
    content_id: z.string().min(1).max(120),
    content_version: z.string().min(1).max(40),
    claim_id: z.string().min(1).max(120),
    adjustment_kind: z.enum([
      "environment",
      "task_structure",
      "written_instruction",
      "distraction_reduction",
      "movement_break",
    ]),
    action_text: z.string().trim().min(1).max(300),
    applicability_confirmed: z.array(z.string().min(1).max(80)).min(1).max(12),
    scope_reviewed: z.literal(true),
    evidence_mode: z.enum(["content_supported", "exploratory"]).default("content_supported"),
  })
  .strict();

export const DecisionBody = z
  .object({ expected_version: z.number().int().positive(), reason: OptionalText(500) })
  .strict();
export const ConfirmBody = z
  .object({
    expected_version: z.number().int().positive(),
    modified_action_text: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export const ReviewBody = z
  .object({
    expected_version: z.number().int().positive(),
    execution: z.enum(["completed", "not_executed", "partly_executed", "unknown"]),
    outcome: z.enum(["helpful", "no_effect", "worse", "mixed", "unknown"]),
    burden: OptionalText(300),
    observation: OptionalText(1000),
    related_claim_revision_id: z.string().uuid().optional(),
    continue_trial: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.execution === "not_executed" && value.outcome !== "unknown") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "未执行时结果应记录为 unknown",
      });
    }
  });

export const idParams = z.object({ id: z.string().uuid() });
export const sessionParams = z.object({ sessionId: z.string().uuid() });
export const sessionQuery = z.object({ session_id: z.string().uuid() });

export type SessionInput = z.infer<typeof SessionBody>;
export type SessionUpdate = z.infer<typeof SessionUpdateBody>;
export type ProposalInput = z.infer<typeof ProposalBody>;
export type DecisionInput = z.infer<typeof DecisionBody>;
export type ConfirmInput = z.infer<typeof ConfirmBody>;
export type ReviewInput = z.infer<typeof ReviewBody>;
