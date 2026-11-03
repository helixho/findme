import path from "node:path";
import { CoreReportSourceBinding, UnderstandingFeedbackInput } from "@findme/core";
import { z } from "zod";
import { atomic, digest, fail, optionalJson, prepareOutput } from "../understanding-baseline/io.js";
import type { PrivateUnderstandingPaths } from "./read.js";

export const Receipt = z.object({
  id: z.string(),
  source_id: z.string(),
  revision: z.number().int().positive(),
  saved_at: z.string(),
  input: UnderstandingFeedbackInput,
  status: z.enum(["saved", "pending_analysis", "processing", "accepted", "rejected", "failed"]),
  result_version: z.string().nullable(),
  error: z.string().nullable(),
  core_source: CoreReportSourceBinding.optional(),
  replaces_source_id: z.string().optional(),
});
const Entry = z.object({
  key: z.string(),
  body_hash: z.string(),
  receipt: Receipt,
  target_context: z
    .object({ question: z.string().nullable(), target_text: z.string().nullable() })
    .strict()
    .optional(),
});
const Attempt = z
  .object({
    id: z.string(),
    job_id: z.string(),
    phase: z.enum(["generation", "audit", "qualification_generation", "qualification_audit"]),
    route: z.string(),
    model: z.string().nullable(),
    reserved_at: z.string(),
    completed_at: z.string().nullable(),
    status: z.enum(["reserved", "ok", "error", "interrupted"]),
    usage: z.record(z.unknown()).nullable(),
    raw: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
const Lifecycle = z
  .object({
    revision: z.number().int().positive(),
    kind: z.enum(["retire", "rebind"]),
    source_id: z.string(),
    actor: z.object({ tenantId: z.string().uuid(), subjectId: z.string().uuid() }).strict(),
    binding_fingerprints: z.array(z.string()),
    source_fingerprints: z.array(z.string()),
    expected_lifecycle_revision: z.number().int().nonnegative(),
    reason: z.string(),
    key: z.string(),
    request_hash: z.string(),
    saved_at: z.string(),
    replacement_id: z.string().nullable(),
    replacement_binding_fingerprint: z.string().nullable(),
    replacement_source_fingerprint: z.string().nullable(),
  })
  .strict();
const State = z
  .object({
    format: z.literal("u3-feedback-state@1"),
    revision: z.number().int().nonnegative(),
    calls_reserved: z.number().int().nonnegative(),
    entries: z.array(Entry),
    revisions: z.array(z.record(z.unknown())),
    attempts: z.array(Attempt).default([]),
    lifecycle: z.array(Lifecycle).default([]),
  })
  .strict();
export type FeedbackState = z.infer<typeof State>;
export const emptyState = (): FeedbackState => ({
  format: "u3-feedback-state@1",
  revision: 0,
  calls_reserved: 0,
  entries: [],
  revisions: [],
  attempts: [],
  lifecycle: [],
});
export async function prepareState(p: PrivateUnderstandingPaths) {
  return prepareOutput(p.stateDir, [p.repoRoot, p.batch, p.coverage, p.baselineDir]);
}
export async function readState(p: PrivateUnderstandingPaths): Promise<FeedbackState> {
  const raw = await optionalJson<{ state: unknown; hash: string }>(
    path.join(p.stateDir, "feedback.json"),
  );
  if (!raw) return emptyState();
  if (digest(raw.state) !== raw.hash) fail("FEEDBACK_STATE_INTEGRITY");
  const s = State.parse(raw.state);
  if (
    s.lifecycle.some((a, i) => a.revision !== i + 1 || a.expected_lifecycle_revision !== i) ||
    new Set(s.lifecycle.map((a) => a.key)).size !== s.lifecycle.length ||
    s.lifecycle.some(
      (a) =>
        !s.entries.some((e) => e.receipt.source_id === a.source_id) ||
        (a.replacement_id !== null && !s.entries.some((e) => e.receipt.id === a.replacement_id)),
    ) ||
    s.attempts.length > s.calls_reserved ||
    new Set(s.attempts.map((a) => a.id)).size !== s.attempts.length ||
    new Set(s.entries.map((e) => e.key)).size !== s.entries.length ||
    new Set(s.entries.map((e) => e.receipt.revision)).size !== s.entries.length ||
    s.entries.some(
      (e) => e.body_hash !== digest(e.receipt.input) || e.receipt.revision > s.revision,
    )
  )
    fail("FEEDBACK_STATE_INTEGRITY");
  return s;
}
export async function writeState(p: PrivateUnderstandingPaths, state: FeedbackState) {
  await atomic(path.join(p.stateDir, "feedback.json"), { state, hash: digest(state) });
}
