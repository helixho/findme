import { AuthorKind, ClaimKind, ClaimMode } from "@findme/core";
import { z } from "zod";
import type { GatewayExecution } from "../llm/gateway.js";
import { hash } from "../shared/primitives.js";
import type { FreezeManifest, RawSession } from "./freeze.js";

export const POLICY = "av-dogfood-policy@2-thinking-disabled";
export const PROMPT = "av-owner-prompt@3";
export const VALIDATOR = "av-dogfood-validator@2";
export const THINKING_MODE = "disabled" as const;
export { hash } from "../shared/primitives.js";
export class DogfoodError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const About = z.enum(["self", "third_party", "project", "unknown"]);
export const SpanDraft = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1),
    author: AuthorKind,
    about: About,
    stance: z.string().max(600),
    kind: z.enum([
      "self_report",
      "evaluation",
      "choice",
      "work_requirement",
      "quotation",
      "system_wrapper",
      "unknown",
    ]),
    uncertainty: z.string().max(1000),
  })
  .strict();
export type Candidate = z.infer<typeof SpanDraft> & {
  id: string;
  sourceId: string;
  checksum: string;
  revision: number;
  status: "candidate" | "adopted" | "excluded";
  context: string[];
  judgedBy: "model_candidate" | "owner";
  runId: string;
  contextSourceIds?: string[];
  provenanceStatus?: "current" | "stale";
};
export const ClaimProposal = z
  .object({
    action: z.enum(["create", "reuse", "withdraw"]),
    reuseId: z.string().nullable(),
    kind: ClaimKind,
    mode: ClaimMode,
    text: z.string().min(1).max(1600),
    scope: z.string().min(1).max(1000),
    evidence: z.array(z.string()).max(20),
    counterevidence: z.array(z.string()).max(20),
    rationale: z.string().max(1200),
    alternatives: z.array(z.string().max(600)).max(4),
    changeCondition: z.string().max(1000),
    question: z.string().nullable(),
  })
  .strict();
export const SynthesisDraft = z
  .object({ claims: z.array(ClaimProposal).max(4), unknowns: z.array(z.string().max(1000)).max(6) })
  .strict();
export type Claim = z.infer<typeof ClaimProposal> & {
  contextSourceIds?: string[];
  id: string;
  revision: number;
  channel: "structured" | "baseline";
  status: "candidate" | "reviewed" | "stale" | "invalid" | "contested" | "historical" | "withdrawn";
  history: {
    revision: number;
    status: string;
    note: string;
    at: string;
    text?: string;
    scope?: string;
  }[];
  runId: string;
  inputFingerprint: string;
  independence: "unknown";
};
export type Source = {
  id: string;
  originalMessageId?: string;
  originalSessionId?: string;
  sourceUuid?: string | null;
  ordinal?: number | null;
  sourceRevision?: string | null;
  sessionId: string;
  groupId: string;
  role: "user" | "assistant" | "system";
  text: string;
  time: string | null;
  split: "dev" | "holdout";
  fingerprint: string;
};
export type Chunk = {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  status: "pending" | "completed" | "failed" | "running";
};
export type Run = {
  id: string;
  operation: "extract" | "synthesize" | "compare";
  fingerprint: string;
  startVersion: number;
  model: string;
  policy: string;
  prompt: string;
  validator: string;
  sourceIds: string[];
  status: "running" | "completed" | "failed" | "stale";
  error: string | null;
  startedAt: string;
  chunkId?: string;
  unknowns?: string[];
  evidenceIds?: string[];
  ownerPid?: number;
  leaseExpiresAt?: string;
  retryOf?: string;
  thinkingMode?: "disabled" | "enabled";
  coverage?: { sourceId: string; start: number; end: number; fingerprint: string }[];
  context?: FrozenContext[];
  comparisonScope?: ComparisonScope;
  payloadFingerprint?: string;
};
export type FrozenContext = {
  sourceId: string;
  role: Source["role"];
  start: number;
  end: number;
  text: string;
  time: string | null;
  groupId: string;
  review: ReturnType<typeof sourceReview>;
  reviewedAttributions: ReturnType<typeof reviewedAttributions>;
  purpose: "referent_context_only";
};
export type ComparisonScope = {
  coverage: NonNullable<Run["coverage"]>;
  context: FrozenContext[];
  sourceReviews: { sourceId: string; review: ReturnType<typeof sourceReview> }[];
  reviewedAttributions: ReturnType<typeof reviewedAttributions>;
  attributionVersions: { id: string; sourceId: string; revision: number; checksum: string }[];
};
export type Attempt = {
  execution?: GatewayExecution;
  id: string;
  runId: string;
  attempt: number;
  model: string;
  layer: string;
  inputFingerprint: string;
  estimatedInputTokens: number;
  estimateMethod: string;
  serializedUtf8Bytes: number;
  reservedOutput: number;
  status: "reserved" | "ok" | "error" | "interrupted";
  errorKind: string | null;
  latencyMs: number | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheInputTokens: number | null;
    cacheOutputTokens: number | null;
  } | null;
  thinkingMode?: "disabled" | "enabled";
};
export type Feedback = {
  expectedVersion: number;
  idempotencyKey: string;
  targetId: string;
  action: "adopt" | "exclude" | "correct" | "context" | "contested" | "time_update";
  author?: z.infer<typeof AuthorKind>;
  about?: z.infer<typeof About>;
  kind?: Candidate["kind"];
  note?: string;
};
export const FeedbackInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(160),
    targetId: z.string().min(1).max(200),
    action: z.enum(["adopt", "exclude", "correct", "context", "contested", "time_update"]),
    author: AuthorKind.optional(),
    about: About.optional(),
    kind: SpanDraft.shape.kind.optional(),
    note: z.string().max(4000).optional(),
  })
  .strict();
export type State = {
  format: "findme-av-staging@1";
  version: number;
  manifestFingerprint: string;
  rawFingerprint: string;
  model: string | null;
  scope: string[];
  candidates: Candidate[];
  claims: Claim[];
  runs: Run[];
  sourceReviews: Record<string, { revision: number; excluded: boolean; context: string[] }>;
  feedback: (Feedback & { at: string; version: number; fingerprint: string })[];
  requests: Record<string, string>;
  usage: {
    attempts: Attempt[];
    reservedInput: number;
    outputCap: number;
    requestCap: number;
    inputCap: number;
  };
};
export type Batch = {
  manifest: FreezeManifest;
  raw: RawSession[];
  sources: Source[];
  state: State;
};
export function sourcesFrom(manifest: FreezeManifest, raw: RawSession[]): Source[] {
  return raw.flatMap((session) => {
    const entry = manifest.sessions.find((s) => s.id === session.id);
    if (!entry) throw new DogfoodError("BATCH_INTEGRITY");
    return session.messages.map((message) => ({
      ...message,
      id: `source-${hash([session.id, message.id]).slice(0, 24)}`,
      sessionId: session.id,
      originalMessageId: message.id,
      originalSessionId: session.sourceSessionId ?? session.id,
      sourceRevision: session.sourceRevision ?? null,
      groupId: entry.groupId,
      split: entry.split,
      fingerprint: hash(message.text),
    }));
  });
}
export function chunks(source: Source, size = 7000): Chunk[] {
  if (source.role !== "user") return [];
  const out: Chunk[] = [];
  for (let start = 0; start < source.text.length; ) {
    let end = Math.min(start + size, source.text.length);
    // Avoid splitting a UTF-16 surrogate pair. Offsets everywhere use JS UTF-16.
    if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end - 1] ?? "")) end--;
    out.push({
      id: `chunk-${hash([source.id, source.fingerprint, start, end]).slice(0, 24)}`,
      sourceId: source.id,
      start,
      end,
      status: "pending",
    });
    start = end;
  }
  return out;
}
export function sourceReview(state: State, id: string) {
  return state.sourceReviews[id] ?? { revision: 0, excluded: false, context: [] };
}
export function reviewedAttributions(state: State, sourceId: string, start: number, end: number) {
  return state.candidates
    .filter(
      (c) => c.sourceId === sourceId && c.judgedBy === "owner" && c.start < end && c.end > start,
    )
    .map((c) => ({
      id: c.id,
      sourceId: c.sourceId,
      start: c.start,
      end: c.end,
      revision: c.revision,
      author: c.author,
      about: c.about,
      kind: c.kind,
      stance: c.stance,
      status: c.status,
      context: c.context,
      independentProof: false as const,
    }));
}
export function expressionEligible(
  candidate: Pick<Candidate, "author" | "about" | "kind" | "stance">,
) {
  return (
    candidate.author === "subject" &&
    ((candidate.about === "self" &&
      ["self_report", "evaluation", "choice"].includes(candidate.kind)) ||
      (["project", "third_party"].includes(candidate.about) &&
        ["evaluation", "choice"].includes(candidate.kind) &&
        candidate.stance.trim().length > 0))
  );
}
export function rawSupportPossible(
  state: State,
  source: Source,
  start = 0,
  end = source.text.length,
) {
  if (source.role !== "user" || source.split !== "dev" || sourceReview(state, source.id).excluded)
    return false;
  const blocked = reviewedAttributions(state, source.id, start, end)
    .filter((c) => c.status === "excluded" || !expressionEligible(c))
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  for (const span of blocked) {
    if (span.end <= cursor || span.start >= end) continue;
    if (source.text.slice(cursor, Math.min(span.start, end)).trim()) return true;
    cursor = Math.max(cursor, Math.min(span.end, end));
  }
  return Boolean(source.text.slice(cursor, end).trim());
}
export function qualified(state: State, candidate: Candidate) {
  return (
    candidate.status !== "excluded" &&
    candidate.provenanceStatus !== "stale" &&
    !sourceReview(state, candidate.sourceId).excluded &&
    !(candidate.contextSourceIds ?? []).some((id) => sourceReview(state, id).excluded) &&
    expressionEligible(candidate)
  );
}
