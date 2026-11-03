import { z } from "zod";
import { UnderstandingReport } from "./understanding-baseline.js";

// Persistent cloud run contracts, not C1 synthetic previews or a second profile model.
export const CloudDiagnosticCreate = z
  .object({
    domain: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/),
    question: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => s.trim().length > 0),
  })
  .strict();
export const CloudDiagnosticResponse = z
  .object({
    expected_version: z.number().int().positive(),
    report_revision_id: z.string().uuid().nullable(),
    kind: z.enum(["supplement", "inaccurate", "context_only", "changed_now", "helpful"]),
    note: z
      .string()
      .min(1)
      .max(5000)
      .refine((s) => s.trim().length > 0),
  })
  .strict();
export const CloudEvidenceBinding = z
  .object({
    evidence_id: z.string().min(1).max(200),
    source_id: z.string().uuid(),
    span_id: z.string().uuid(),
    assessment_version: z.number().int().positive(),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const CloudReportCandidate = z
  .object({
    expected_version: z.number().int().positive(),
    report: UnderstandingReport,
    evidence: z.array(CloudEvidenceBinding).max(200),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    policy_version: z.string().min(1).max(200),
    prompt_version: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.evidence.map((e) => e.evidence_id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate evidence binding" });
  });
export const CloudBlobDeclaration = z
  .object({
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_length: z
      .number()
      .int()
      .min(0)
      .max(50 * 1024 * 1024),
    media_type: z.enum([
      "application/json",
      "application/x-ndjson",
      "text/plain",
      "application/pdf",
    ]),
    file_name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type CloudDiagnosticCreate = z.infer<typeof CloudDiagnosticCreate>;
export type CloudDiagnosticResponse = z.infer<typeof CloudDiagnosticResponse>;
export type CloudEvidenceBinding = z.infer<typeof CloudEvidenceBinding>;
export type CloudReportCandidate = z.infer<typeof CloudReportCandidate>;
export type CloudBlobDeclaration = z.infer<typeof CloudBlobDeclaration>;

export const CloudProcessRequest = z
  .object({
    expected_version: z.number().int().positive(),
    source_ids: z.array(z.string().uuid()).max(8).default([]),
    topic_run_ids: z.array(z.string().uuid()).max(12).default([]),
    provider_call_cap: z.number().int().min(0).max(20),
  })
  .strict();
