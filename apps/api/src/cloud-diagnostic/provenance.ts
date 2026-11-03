import { AuthorKind, UnderstandingAudit, type UnderstandingFeedbackReceipt } from "@findme/core";
import { platformSchema as p } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { PersonalContext } from "../core/exploration-service.js";
import { validateAudit } from "../domain/understanding/policy.js";
import type { Fact } from "../domain/understanding/types.js";
import { digest } from "../shared/primitives.js";
import { UnderstandingQualification } from "../understanding-app/qualification-schema.js";
import {
  QUALIFICATION_AUDIT_PROMPT,
  QUALIFICATION_PROMPT,
  QUALIFICATION_RULES,
  qualificationAssigned,
  qualificationFacts,
  qualificationInput,
} from "../understanding-app/qualification.js";
import type { ProfileTransaction } from "./scope.js";
export const SnapshotSource = z
  .object({
    id: z.string().uuid(),
    hash: z.string(),
    assessment_version: z.number().int(),
    text: z.string(),
    reported_at: z.string(),
    occurred_at: z.string().nullable(),
    root_id: z.string(),
    kind: z.string(),
    author: AuthorKind,
    about: z.enum(["self", "project", "third_party", "unknown"]).default("unknown"),
    stance: z
      .enum(["endorsed", "not_endorsed", "opposed", "reported", "unknown"])
      .default("unknown"),
    target_context: z.record(z.unknown()).nullable().default(null),
    response_kind: z.string().default("supplement"),
  })
  .strict();
export const PipelineInput = z
  .object({
    run_id: z.string().uuid(),
    run_version: z.number().int(),
    domain: z.string(),
    question: z.string(),
    sources: z.array(SnapshotSource).min(1).max(8),
    policy: z.string(),
    qualification_jobs: z.record(z.string()).default({}),
    omitted_source_ids: z.array(z.string()).default([]),
    dependencies: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int(),
            head_version: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type PipelineInput = z.infer<typeof PipelineInput>;
export const CLOUD_QUALIFICATION_RULES = `${QUALIFICATION_RULES}:cloud-source-attribution@2`;
export const CLOUD_QUALIFICATION_PROMPT = `${QUALIFICATION_PROMPT} Every note includes immutable source_attribution: author, source kind, occurred_at, about and stance. These are retained source claims, not a submitter identity or independently confirmed facts. Use them together with the complete original text. Unknown permits semantic analysis; never silently replace a known non-subject author, object or non-endorsement with a subject endorsement. Source kind describes origin, not proposition type. Preserve reported time separately from event time.`;
export const CLOUD_QUALIFICATION_AUDIT_PROMPT = `${QUALIFICATION_AUDIT_PROMPT} Explicitly compare every candidate with each note's source_attribution (author, kind, occurred_at, about, stance), and flag unsupported attribution or stance changes. Original metadata is fallible retained context, never a new owner confirmation.`;
export const QUALIFICATION_HASH = digest([
  CLOUD_QUALIFICATION_RULES,
  CLOUD_QUALIFICATION_PROMPT,
  CLOUD_QUALIFICATION_AUDIT_PROMPT,
]);
export function sourceAttribution(source: PipelineInput["sources"][number]) {
  return {
    author: source.author,
    kind: source.kind,
    occurred_at: source.occurred_at,
    about: source.about,
    stance: source.stance,
  };
}
export function cloudQualificationInput(input: PipelineInput) {
  const receipts = input.sources.map(
    (s) =>
      ({
        id: s.id,
        source_id: s.id,
        saved_at: s.reported_at,
        revision: 1,
        input: {
          baseline_version: "cloud",
          input_hash: digest(input),
          domain: input.domain,
          report_version: String(input.run_version),
          type: "supplement",
          note: s.text,
          context: { question: input.question },
        },
        status: "pending_analysis",
        error: null,
        result_version: null,
      }) as UnderstandingFeedbackReceipt,
  );
  const qualifiedInput = qualificationInput(receipts);
  const complete = {
    ...qualifiedInput,
    rules: CLOUD_QUALIFICATION_RULES,
    generation_prompt: CLOUD_QUALIFICATION_PROMPT,
    audit_prompt: CLOUD_QUALIFICATION_AUDIT_PROMPT,
    notes: qualifiedInput.notes.map((note) => {
      const source = input.sources.find((s) => s.id === note.source_id);
      if (!source) throw new Error("QUALIFICATION_SOURCE_MISMATCH");
      return { ...note, source_attribution: sourceAttribution(source) };
    }),
    original_target_context: input.sources.map((s) => ({
      source_id: s.id,
      response_kind: s.response_kind,
      target_context: s.target_context,
    })),
    target_rule:
      "Prior reports are disputed review context, not new factual evidence; never inherit a claim without current originals.",
  };
  if (new TextEncoder().encode(JSON.stringify(complete)).length > 48000)
    throw new Error("QUALIFICATION_INPUT_BOUND_EXCEEDED");
  return complete;
}
export function cloudFacts(input: PipelineInput, candidate: UnderstandingQualification): Fact[] {
  return qualificationFacts(cloudQualificationInput(input), candidate).map((f) => {
    const s = input.sources.find((s) => s.id === f.source_id);
    if (!s) throw new Error("QUALIFICATION_SOURCE_MISMATCH");
    if (
      f.use !== "context" &&
      ((!["unknown", "mixed", "subject"].includes(s.author) && f.content_author === "subject") ||
        (s.about !== "unknown" && f.about !== s.about) ||
        (s.stance !== "unknown" && f.stance !== s.stance))
    )
      throw new Error("QUALIFICATION_ATTRIBUTION_CHANGED");
    return {
      ...f,
      ...(f.id === s.id ? { content_author: s.author, about: s.about, stance: s.stance } : {}),
      source_attribution: sourceAttribution(s),
      canonical_id: s.root_id,
      root_ids: [s.root_id],
      group_id: s.root_id,
      project: "cloud",
      session_id: input.run_id,
      time: s.reported_at,
    };
  });
}
/** Reconstruct facts from the independently audited raw pair, not a trusted JSON projection. */
export async function qualificationProof(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  jobId: string,
) {
  const [job] = await tx
    .select()
    .from(p.cloudJobs)
    .where(
      and(
        eq(p.cloudJobs.id, jobId),
        eq(p.cloudJobs.tenantId, ctx.tenantId),
        eq(p.cloudJobs.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!job) throw new Error("QUALIFICATION_PROOF_MISSING");
  const input = PipelineInput.parse(job.input);
  const attempts = await tx
    .select()
    .from(p.cloudAttempts)
    .where(
      and(
        eq(p.cloudAttempts.jobId, jobId),
        eq(p.cloudAttempts.tenantId, ctx.tenantId),
        eq(p.cloudAttempts.subjectId, ctx.subjectId),
        eq(p.cloudAttempts.status, "ok"),
      ),
    )
    .orderBy(desc(p.cloudAttempts.createdAt));
  const generation = attempts.find((a) => a.phase === "qualification");
  const audit = attempts.find((a) => a.phase === "qualification_audit");
  if (!generation?.raw || !audit?.raw) throw new Error("QUALIFICATION_PROOF_MISSING");
  const candidate = UnderstandingQualification.parse(JSON.parse(generation.raw));
  const review = UnderstandingAudit.parse(JSON.parse(audit.raw));
  const q = cloudQualificationInput(input);
  // Old persisted inputs remain parseable. Their old audit is never authority for this
  // expanded input; reads surface needs_review rather than silently rerunning a model.
  if (
    generation.inputHash !== digest(q) ||
    audit.inputHash !==
      digest({
        analysis_input: q,
        analysis_input_hash: digest(q),
        candidate,
        assigned: qualificationAssigned(q, candidate),
      })
  )
    throw new Error("QUALIFICATION_INPUT_VERSION_CHANGED");
  if (
    digest(candidate) !== digest(UnderstandingQualification.parse(generation.result)) ||
    digest(review) !== digest(UnderstandingAudit.parse(audit.result))
  )
    throw new Error("QUALIFICATION_PROOF_CHANGED");
  validateAudit(
    review,
    digest(q),
    qualificationAssigned(q, candidate),
    input.sources.map((s) => s.id),
  );
  return { input, facts: cloudFacts(input, candidate) };
}
