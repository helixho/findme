import {
  FrameworkAudit,
  FrameworkCandidate,
  FrameworkDefinition,
  FrameworkDomainAssessment,
  FrameworkSynthesis,
} from "@findme/core";
import { z } from "zod";

export const Answer = z
  .object({
    id: z.string(),
    question_id: z.string(),
    domain: z.string(),
    text: z.string(),
    hash: z.string(),
    start: z.number().int(),
    end: z.number().int(),
    saved_at: z.string(),
    status: z.enum(["valid", "corrected", "excluded"]),
    replaces: z.string().nullable(),
  })
  .strict();
const Question = z
  .object({
    id: z.string(),
    domain: z.string(),
    text: z.string(),
    intent: z.string().nullable(),
    input_source_ids: z.array(z.string()),
  })
  .strict();
export const Run = z
  .object({
    id: z.string(),
    owner_key: z.string(),
    version: z.number().int().positive(),
    definition: FrameworkDefinition,
    mode: z.enum(["direct_interview", "history_adapted"]),
    status: z.enum(["active", "paused", "completed", "abandoned", "needs_review"]),
    phase: z.enum(["intake", "assessing", "synthesizing", "review", "completed"]),
    domain_index: z.number().int().nonnegative(),
    open_question: Question.nullable(),
    questions: z.array(Question),
    skipped_questions: z
      .array(
        z
          .object({
            question_id: z.string(),
            domain: z.string(),
            skipped_at: z.string(),
          })
          .strict(),
      )
      .default([]),
    answers: z.array(Answer),
    assessments: z.array(FrameworkDomainAssessment),
    result: z
      .object({
        domains: z.array(FrameworkDomainAssessment),
        synthesis: FrameworkSynthesis,
        evidence_status: z.enum(["valid", "stale"]),
        created_at: z.string(),
      })
      .strict()
      .nullable(),
    result_history: z.array(
      z
        .object({
          domains: z.array(FrameworkDomainAssessment),
          synthesis: FrameworkSynthesis,
          evidence_status: z.enum(["valid", "stale"]),
          created_at: z.string(),
        })
        .strict(),
    ),
    started_at: z.string(),
    updated_at: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export type Run = z.infer<typeof Run>;
const Job = z
  .object({
    id: z.string(),
    run_id: z.string(),
    input_hash: z.string(),
    input: z.string(),
    binding_version: z.number().int(),
    stage: z.enum(["question", "adaptive", "evaluation", "synthesis"]),
    status: z.enum(["processing", "failed", "rejected", "obsolete", "completed"]),
    execution: z.string(),
    calls_remaining: z.number().int().nonnegative(),
    lease_until: z.string(),
    candidate: FrameworkCandidate.nullable(),
    audit: FrameworkAudit.nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type Job = z.infer<typeof Job>;
const Attempt = z
  .object({
    id: z.string(),
    job_id: z.string(),
    execution: z.string(),
    phase: z.enum(["generation", "audit"]),
    route: z.string(),
    model: z.string().nullable(),
    reserved_at: z.string(),
    completed_at: z.string().nullable(),
    status: z.enum(["reserved", "ok", "error", "interrupted"]),
    usage: z.record(z.unknown()).nullable(),
    estimate: z.record(z.unknown()).nullable(),
    raw: z.string().nullable(),
    parsed: z.unknown().optional(),
    error: z.string().nullable(),
  })
  .strict();
const State = z
  .object({
    format: z.literal("u4-framework-state@1"),
    owner_key: z.string(),
    revision: z.number().int().nonnegative(),
    u4_calls_reserved: z.number().int().nonnegative(),
    runs: z.array(Run),
    jobs: z.array(Job),
    attempts: z.array(Attempt),
    actions: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          key: z.string(),
          request_hash: z.string(),
          run_id: z.string(),
          run_version: z.number().int().positive(),
          action: z.string(),
          at: z.string(),
          reason: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type FrameworkState = z.infer<typeof State>;
/** Inject another implementation for hosted storage; routes/service do not depend on fs. */
export interface FrameworkRepository {
  read(): Promise<FrameworkState>;
  update<T>(fn: (state: FrameworkState) => T | Promise<T>): Promise<T>;
}

export { State as FrameworkStateSchema };
