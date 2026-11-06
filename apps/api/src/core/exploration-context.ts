import type { UnderstandingDraft } from "@findme/core";
import type { EvidenceRow } from "./exploration-types.js";

export function localClaimKey(explorationId: string, key: string) {
  return `${explorationId}/${key}`;
}

export function modelClaimKey(explorationId: string, key: string) {
  const prefix = `${explorationId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function outcomeForUnderstanding(draft: UnderstandingDraft) {
  return draft.claims.length > 0 ? "provisional" : "insufficient";
}

export function jsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function deriveExplorationPhase(args: {
  status: string;
  openQuestion: unknown;
  claims: Array<{ evidenceStatus: string; pendingFeedback?: boolean }>;
  gaps: unknown[];
  hasWithdrawn?: boolean;
  /** Latest step is a completed synthesis that changed prior understanding only. */
  priorProcessed?: boolean;
}) {
  if (args.status !== "active") return "completed";
  if (args.openQuestion) return "awaiting_answer";
  if (args.claims.some((claim) => claim.evidenceStatus !== "valid" || claim.pendingFeedback))
    return "needs_review";
  if (args.claims.some((claim) => claim.evidenceStatus === "valid")) return "review";
  if (args.hasWithdrawn) return "review";
  if (args.priorProcessed) return "review";
  if (args.gaps.length > 0) return "insufficient";
  return "ready_to_plan";
}

export function evidenceText(rows: EvidenceRow[]) {
  return rows
    .map(
      (row) =>
        `[${row.key}] author=${row.authorKind}; eligibility=${row.eligibility}\n${row.quote}`,
    )
    .join("\n\n");
}

/**
 * True when the latest stop step persisted a substantive effect on prior
 * understanding and nothing has changed the exploration since that commit
 * (a later amendment or source change bumps the version past it).
 */
export function hasPriorProcessing(
  step: { decision: string; modelMeta: unknown; basisVersion: number } | null | undefined,
  explorationVersion: number,
) {
  if (!step || step.decision !== "stop") return false;
  if (step.basisVersion + 1 !== explorationVersion) return false;
  const processing = (
    step.modelMeta as { processing?: { prior_effects?: Array<{ effect: string }> } }
  )?.processing;
  return (processing?.prior_effects ?? []).some((item) =>
    ["supports", "narrows", "challenges"].includes(item.effect),
  );
}
