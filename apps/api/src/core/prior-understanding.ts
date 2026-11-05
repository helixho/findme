import type { PriorUnderstandingUpdate, UnderstandingWithPriorDraft } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { lexicalScores } from "../diagnostic-reasoning/ranking.js";
import { hasUnsafeUnderstandingText } from "./epistemic-policy.js";
import { CoreError } from "./errors.js";
import type { EvidenceRow, PersonalContext } from "./exploration-types.js";

/**
 * Bounded, versioned selection of the subject's current understanding formed in
 * other explorations. It is context for planning/synthesis, never evidence for
 * the present experience; withdrawn or invalidated items are listed only so they
 * are not used as a premise again.
 */
export const PRIOR_SELECTION_VERSION = "prior-understanding-selection@v1";
export const PRIOR_VALIDATOR_VERSION = "prior-update-validator@v1";
export const PRIOR_SELECTION_LIMITS = {
  maxClaims: 6,
  minRecentFallback: 2,
  maxTextChars: 3600,
  maxExcluded: 6,
} as const;

export type PriorClaim = {
  key: string;
  claimId: string;
  claimKind: string;
  revisionId: string;
  version: number;
  mode: string;
  text: string;
  scope: string;
  confidenceLevel: string;
  confidenceBasis: string;
  basis: "lexical" | "recent";
  score: number;
};

export type PriorExcluded = {
  claimId: string;
  revisionId: string;
  text: string;
  scope: string;
  reason: "withdrawn" | "evidence_invalid" | "evidence_stale";
  note: string | null;
};

export type PriorUnderstanding = {
  version: typeof PRIOR_SELECTION_VERSION;
  claims: PriorClaim[];
  excluded: PriorExcluded[];
  candidateCount: number;
  omittedCount: number;
};

type RevisionRow = {
  claimId: string;
  claimKey: string;
  claimKind: string;
  revisionId: string;
  version: number;
  mode: string;
  text: string;
  scope: string;
  status: string;
  evidenceStatus: string;
  confidenceLevel: string;
  confidenceBasis: string;
  revisionReason: string | null;
  invalidationReason: string | null;
  createdAt: Date;
};

export function rankPriorCandidates(
  queryText: string,
  candidates: RevisionRow[],
): Array<RevisionRow & { basis: "lexical" | "recent"; score: number }> {
  const scores = lexicalScores(
    queryText,
    candidates.map((row) => ({ id: row.revisionId, quote: `${row.text}\n${row.scope}` })),
  );
  const byRecency = [...candidates].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.claimKey.localeCompare(b.claimKey),
  );
  const lexical = byRecency
    .map((row) => ({ row, score: scores.get(row.revisionId)?.score ?? 0 }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const selected: Array<RevisionRow & { basis: "lexical" | "recent"; score: number }> = [];
  let chars = 0;
  const fits = (row: RevisionRow) => {
    const size = row.text.length + row.scope.length;
    if (chars + size > PRIOR_SELECTION_LIMITS.maxTextChars) return false;
    chars += size;
    return true;
  };
  for (const { row, score } of lexical) {
    if (selected.length >= PRIOR_SELECTION_LIMITS.maxClaims) break;
    if (fits(row)) selected.push({ ...row, basis: "lexical", score: Number(score.toFixed(4)) });
  }
  // A few recent items let the planner notice a relation that shares no words;
  // they are labelled so the model treats them as weakly related context.
  for (const row of byRecency) {
    if (selected.length >= PRIOR_SELECTION_LIMITS.minRecentFallback) break;
    if (selected.some((item) => item.revisionId === row.revisionId)) continue;
    if (fits(row)) selected.push({ ...row, basis: "recent", score: 0 });
  }
  return selected;
}

export async function loadPriorUnderstanding(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  args: { explorationId: string; queryText: string },
): Promise<PriorUnderstanding> {
  const rows: RevisionRow[] = await db
    .select({
      claimId: coreSchema.claims.id,
      claimKey: coreSchema.claims.claimKey,
      claimKind: coreSchema.claims.claimKind,
      revisionId: coreSchema.claimRevisions.id,
      version: coreSchema.claimRevisions.version,
      mode: coreSchema.claimRevisions.mode,
      text: coreSchema.claimRevisions.text,
      scope: coreSchema.claimRevisions.scope,
      status: coreSchema.claimRevisions.status,
      evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
      confidenceLevel: coreSchema.claimRevisions.confidenceLevel,
      confidenceBasis: coreSchema.claimRevisions.confidenceBasis,
      revisionReason: coreSchema.claimRevisions.revisionReason,
      invalidationReason: coreSchema.claimRevisions.invalidationReason,
      createdAt: coreSchema.claimRevisions.createdAt,
    })
    .from(coreSchema.claims)
    .innerJoin(
      coreSchema.claimRevisions,
      eq(coreSchema.claimRevisions.claimId, coreSchema.claims.id),
    )
    .where(
      and(
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        inArray(coreSchema.claimRevisions.status, ["current", "withdrawn"]),
      ),
    )
    .orderBy(desc(coreSchema.claimRevisions.createdAt));

  const own = `${args.explorationId}/`;
  // A claim with any revision redacted by source deletion is never offered,
  // not even as a "do not use" item: its text must not reach the provider.
  const deleted = new Set(
    rows.filter((row) => row.invalidationReason === "source_deleted").map((row) => row.claimId),
  );
  const others = rows.filter(
    (row) => !row.claimKey.startsWith(own) && !deleted.has(row.claimId) && row.text.trim() !== "",
  );
  const current = others.filter((row) => row.status === "current");
  const currentClaimIds = new Set(current.map((row) => row.claimId));
  const usable = current.filter((row) => row.evidenceStatus === "valid");
  const ranked = rankPriorCandidates(args.queryText, usable);

  const excluded: PriorExcluded[] = [];
  for (const row of current) {
    if (row.evidenceStatus === "valid") continue;
    excluded.push({
      claimId: row.claimId,
      revisionId: row.revisionId,
      text: row.text,
      scope: row.scope,
      reason: row.evidenceStatus === "invalid" ? "evidence_invalid" : "evidence_stale",
      note: row.invalidationReason,
    });
  }
  // Only the latest withdrawn revision of a claim with no current revision.
  const seenWithdrawn = new Set<string>();
  for (const row of others) {
    if (row.status !== "withdrawn" || currentClaimIds.has(row.claimId)) continue;
    if (seenWithdrawn.has(row.claimId)) continue;
    seenWithdrawn.add(row.claimId);
    excluded.push({
      claimId: row.claimId,
      revisionId: row.revisionId,
      text: row.text,
      scope: row.scope,
      reason: "withdrawn",
      note: row.revisionReason,
    });
  }
  const queryExcluded = lexicalScores(
    args.queryText,
    excluded.map((row) => ({ id: row.revisionId, quote: `${row.text}\n${row.scope}` })),
  );
  excluded.sort(
    (a, b) =>
      (queryExcluded.get(b.revisionId)?.score ?? 0) - (queryExcluded.get(a.revisionId)?.score ?? 0),
  );

  return {
    version: PRIOR_SELECTION_VERSION,
    claims: ranked.map((row, index) => ({
      key: `P${index + 1}`,
      claimId: row.claimId,
      claimKind: row.claimKind,
      revisionId: row.revisionId,
      version: row.version,
      mode: row.mode,
      text: row.text,
      scope: row.scope,
      confidenceLevel: row.confidenceLevel,
      confidenceBasis: row.confidenceBasis,
      basis: row.basis,
      score: row.score,
    })),
    excluded: excluded.slice(0, PRIOR_SELECTION_LIMITS.maxExcluded),
    candidateCount: usable.length,
    omittedCount: usable.length - ranked.length,
  };
}

export function hasPriorContext(prior: PriorUnderstanding) {
  return prior.claims.length > 0 || prior.excluded.length > 0;
}

export function priorContextText(prior: PriorUnderstanding) {
  if (!hasPriorContext(prior)) return "";
  return [
    "",
    "PRIOR_UNDERSTANDING (current understanding from OTHER experiences; context only, never evidence for this experience; use only when actually relevant):",
    JSON.stringify(
      prior.claims.map((claim) => ({
        key: claim.key,
        kind: claim.claimKind,
        mode: claim.mode,
        text: claim.text,
        scope: claim.scope,
        confidence_level: claim.confidenceLevel,
        selected_by: claim.basis === "lexical" ? "related_terms" : "recent_only_maybe_unrelated",
      })),
    ),
    "",
    "DO_NOT_USE_AS_PREMISE (withdrawn by the user or no longer supported; do not restate or rely on these):",
    JSON.stringify(
      prior.excluded.map((item) => ({
        text: item.text,
        scope: item.scope,
        reason: item.reason,
      })),
    ),
  ].join("\n");
}

/** Persistable lineage: exactly which revisions were offered to the model. */
export function priorSelectionMeta(prior: PriorUnderstanding) {
  return {
    selection_version: prior.version,
    used: prior.claims.map((claim) => ({
      key: claim.key,
      claim_id: claim.claimId,
      claim_revision_id: claim.revisionId,
      version: claim.version,
      selected_by: claim.basis,
      score: claim.score,
    })),
    excluded: prior.excluded.map((item) => ({
      claim_id: item.claimId,
      claim_revision_id: item.revisionId,
      reason: item.reason,
    })),
    candidate_count: prior.candidateCount,
    omitted_count: prior.omittedCount,
  };
}

/** Deterministic checks for model-proposed effects on prior understanding. */
export function validatePriorUpdates(
  draft: UnderstandingWithPriorDraft,
  prior: PriorUnderstanding,
  rows: EvidenceRow[],
) {
  const issues: string[] = [];
  const priorKeys = new Set(prior.claims.map((claim) => claim.key));
  const evidenceKeys = new Set(rows.map((row) => row.key));
  const seen = new Set<string>();
  for (const update of draft.prior_updates) {
    const key = update.prior_key;
    if (!priorKeys.has(key)) issues.push(`prior_unknown_key:${key}`);
    if (seen.has(key)) issues.push(`prior_duplicate_key:${key}`);
    seen.add(key);
    for (const use of update.evidence)
      if (!evidenceKeys.has(use.evidence_key))
        issues.push(`prior_invalid_evidence_key:${key}:${use.evidence_key}`);
    const revised = update.revised_text !== null || update.revised_scope !== null;
    if (update.effect === "unchanged") {
      if (revised) issues.push(`prior_unchanged_with_revision:${key}`);
      continue;
    }
    if (update.evidence.length === 0) issues.push(`prior_effect_without_evidence:${key}`);
    if (update.effect === "supports") {
      if (revised) issues.push(`prior_support_with_revision:${key}`);
      if (update.evidence.some((use) => use.relation !== "supports"))
        issues.push(`prior_support_relation_mismatch:${key}`);
    }
    if (update.effect === "challenges") {
      if (revised) issues.push(`prior_challenge_with_revision:${key}`);
      if (!update.evidence.some((use) => use.relation === "challenges"))
        issues.push(`prior_challenge_without_challenging_evidence:${key}`);
    }
    if (update.effect === "narrows") {
      if (update.revised_scope === null) issues.push(`prior_narrow_without_scope:${key}`);
      const text = `${update.revised_text ?? ""}\n${update.revised_scope ?? ""}`;
      if (hasUnsafeUnderstandingText(text)) issues.push(`prior_narrow_policy:${key}`);
    }
  }
  return issues;
}

export type PriorEffectResult = {
  prior_key: string;
  claim_id: string;
  from_revision_id: string;
  to_revision_id: string | null;
  effect: PriorUnderstandingUpdate["effect"] | "skipped_stale" | "not_assessed";
  text: string;
  scope: string;
  rationale: string | null;
};

export type ProcessingResult = "revised" | "challenged" | "added" | "supported" | "unknown";

/**
 * The visible outcome of one saved input. Priority mirrors how much the current
 * understanding changed; "unknown" means nothing new could be formed yet.
 */
export function processingResult(args: {
  newClaims: number;
  effects: PriorEffectResult[];
}): ProcessingResult {
  const effects = new Set(args.effects.map((item) => item.effect));
  if (effects.has("narrows")) return "revised";
  if (effects.has("challenges")) return "challenged";
  if (args.newClaims > 0) return "added";
  if (effects.has("supports")) return "supported";
  return "unknown";
}

const LOWER: Record<string, string> = { high: "medium", medium: "low", low: "low" };
const EFFECT_LABEL = {
  supports: "新经历补充支持了这一认识",
  narrows: "新经历收窄了这一认识的适用范围",
  challenges: "新经历对这一认识提出了未解决的挑战",
} as const;

/**
 * Applies validated effects as new ClaimRevisions of the prior claims. Each
 * revision keeps the previous evidence and adds the new experience as an
 * independent group. A revision that changed meanwhile is skipped, not overwritten.
 */
export async function applyPriorUpdates(
  tx: Pick<Db, "select" | "insert" | "update">,
  args: {
    prior: PriorUnderstanding;
    updates: PriorUnderstandingUpdate[];
    rows: EvidenceRow[];
    experienceId: string;
  },
): Promise<PriorEffectResult[]> {
  const results: PriorEffectResult[] = [];
  const byKey = new Map(args.updates.map((update) => [update.prior_key, update]));
  const rowsByKey = new Map(args.rows.map((row) => [row.key, row]));
  for (const claim of args.prior.claims) {
    const update = byKey.get(claim.key);
    const base = {
      prior_key: claim.key,
      claim_id: claim.claimId,
      from_revision_id: claim.revisionId,
      text: claim.text,
      scope: claim.scope,
    };
    if (!update) {
      results.push({ ...base, to_revision_id: null, effect: "not_assessed", rationale: null });
      continue;
    }
    if (update.effect === "unchanged") {
      results.push({
        ...base,
        to_revision_id: null,
        effect: "unchanged",
        rationale: update.rationale,
      });
      continue;
    }
    const [locked] = await tx
      .select()
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.id, claim.revisionId))
      .for("update");
    if (!locked || locked.status !== "current" || locked.evidenceStatus !== "valid") {
      results.push({
        ...base,
        to_revision_id: null,
        effect: "skipped_stale",
        rationale: update.rationale,
      });
      continue;
    }
    const oldEvidence = await tx
      .select()
      .from(coreSchema.claimEvidence)
      .where(eq(coreSchema.claimEvidence.claimRevisionId, locked.id));
    await tx
      .update(coreSchema.claimRevisions)
      .set({ status: "superseded" })
      .where(eq(coreSchema.claimRevisions.id, locked.id));
    const text = update.effect === "narrows" ? (update.revised_text ?? locked.text) : locked.text;
    const scope =
      update.effect === "narrows" ? (update.revised_scope ?? locked.scope) : locked.scope;
    const confidenceLevel =
      update.effect === "challenges"
        ? (LOWER[locked.confidenceLevel] ?? "low")
        : locked.confidenceLevel;
    const reason = `${EFFECT_LABEL[update.effect]}：${update.rationale}`.slice(0, 1600);
    const [revision] = await tx
      .insert(coreSchema.claimRevisions)
      .values({
        claimId: locked.claimId,
        version: locked.version + 1,
        mode: locked.mode,
        text,
        scope,
        status: "current",
        confidenceLevel,
        confidenceBasis: `${locked.confidenceBasis}；${EFFECT_LABEL[update.effect]}。`.slice(
          0,
          1200,
        ),
        revisionReason: reason,
        supersedesRevisionId: locked.id,
      })
      .returning();
    if (!revision) throw new Error("prior_revision_create_failed");
    for (const use of oldEvidence) {
      await tx.insert(coreSchema.claimEvidence).values({
        claimRevisionId: revision.id,
        evidenceSpanId: use.evidenceSpanId,
        relation: use.relation,
        directness: use.directness,
        contribution: use.contribution,
        independenceGroup: use.independenceGroup,
        scopeMatch: use.scopeMatch,
        rationale: use.rationale,
      });
    }
    const added = new Set(oldEvidence.map((use) => `${use.evidenceSpanId}:${use.relation}`));
    for (const use of update.evidence) {
      const row = rowsByKey.get(use.evidence_key);
      if (!row) throw new Error(`evidence_missing:${use.evidence_key}`);
      if (added.has(`${row.spanId}:${use.relation}`)) continue;
      added.add(`${row.spanId}:${use.relation}`);
      await tx.insert(coreSchema.claimEvidence).values({
        claimRevisionId: revision.id,
        evidenceSpanId: row.spanId,
        relation: use.relation,
        directness: use.directness,
        contribution: use.contribution,
        independenceGroup: `experience:${args.experienceId}`,
        scopeMatch: use.scope_match,
        rationale: use.rationale,
      });
    }
    results.push({
      ...base,
      to_revision_id: revision.id,
      effect: update.effect,
      text,
      scope,
      rationale: update.rationale,
    });
  }
  return results;
}

/**
 * Called inside the commit transaction. Locks every revision of the claims
 * whose text was offered to the model; a concurrent hard deletion either waits
 * for this commit (and then redacts it) or has already run, in which case the
 * model output derived from deleted context is rejected.
 */
export async function assertPriorContextIntact(
  tx: Pick<Db, "select">,
  prior: PriorUnderstanding,
  /** "update" when the same transaction will revise these rows (Stop path). */
  mode: "share" | "update" = "share",
  /**
   * The exploration's own claim revisions the output was generated from. They
   * are locked in the same ordered statement and must still be current: a
   * cross-exploration update does not bump this exploration's version.
   */
  local: Array<{ claimId: string; revisionId: string; evidenceStatus?: string }> = [],
) {
  const priorIds = new Set([
    ...prior.claims.map((c) => c.claimId),
    ...prior.excluded.map((e) => e.claimId),
  ]);
  const claimIds = [...new Set([...priorIds, ...local.map((c) => c.claimId)])];
  if (!claimIds.length) return;
  const rows = await tx
    .select({
      id: coreSchema.claimRevisions.id,
      claimId: coreSchema.claimRevisions.claimId,
      status: coreSchema.claimRevisions.status,
      evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
      invalidationReason: coreSchema.claimRevisions.invalidationReason,
    })
    .from(coreSchema.claimRevisions)
    .where(inArray(coreSchema.claimRevisions.claimId, claimIds))
    // One statement in id order for prior and local rows; taking the exclusive
    // lock up front avoids upgrade and cross-order deadlocks between commits.
    .orderBy(coreSchema.claimRevisions.id)
    .for(mode);
  if (rows.some((row) => priorIds.has(row.claimId) && row.invalidationReason === "source_deleted"))
    throw new CoreError("STALE_EXPLORATION_CONTEXT", 409, "参考的已有认识已被删除，请重新处理");
  const current = new Map(
    rows.filter((row) => row.status === "current").map((row) => [row.claimId, row.id]),
  );
  if (local.some((basis) => current.get(basis.claimId) !== basis.revisionId))
    throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");
  // Evidence validity may change without a new revision (a source excluded in
  // another conversation). Output generated from the old state must not commit.
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (
    local.some(
      (basis) =>
        basis.evidenceStatus !== undefined &&
        byId.get(basis.revisionId)?.evidenceStatus !== basis.evidenceStatus,
    ) ||
    prior.claims.some((claim) => {
      const row = byId.get(claim.revisionId);
      return row?.status === "current" && row.evidenceStatus !== "valid";
    })
  )
    throw new CoreError("STALE_EXPLORATION_CONTEXT", 409, "参考的认识依据已经变化，请重新处理");
}

/**
 * The evidence sources a model output was generated from must still be usable
 * at commit: active, currently eligible, same assessment version. Sources are
 * share-locked in id order after the conversation row and before claim
 * revisions, matching source changes (conversations, then sources, then
 * revisions), so an exclusion either waits for this commit and then
 * invalidates its output, or makes this commit fail.
 */
export async function assertEvidenceUsable(
  tx: Pick<Db, "select">,
  ctx: PersonalContext,
  rows: Array<{ sourceItemId: string; assessmentVersion: number | null }>,
) {
  const ids = [...new Set(rows.map((row) => row.sourceItemId))].sort();
  if (!ids.length) return;
  const sources = await tx
    .select({ id: coreSchema.sourceItems.id, usageStatus: coreSchema.sourceItems.usageStatus })
    .from(coreSchema.sourceItems)
    .where(
      and(
        inArray(coreSchema.sourceItems.id, ids),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .orderBy(coreSchema.sourceItems.id)
    .for("share");
  const assessments = await tx
    .select({
      sourceItemId: coreSchema.sourceAssessments.sourceItemId,
      version: coreSchema.sourceAssessments.version,
      eligibility: coreSchema.sourceAssessments.eligibility,
    })
    .from(coreSchema.sourceAssessments)
    .where(
      and(
        inArray(coreSchema.sourceAssessments.sourceItemId, ids),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    );
  const active = new Set(sources.filter((s) => s.usageStatus === "active").map((s) => s.id));
  const current = new Map(assessments.map((a) => [a.sourceItemId, a]));
  for (const row of rows) {
    const assessment = current.get(row.sourceItemId);
    if (
      !active.has(row.sourceItemId) ||
      assessment?.eligibility !== "eligible" ||
      (row.assessmentVersion !== null && assessment.version !== row.assessmentVersion)
    )
      throw new CoreError("STALE_EXPLORATION_CONTEXT", 409, "依据的材料已经变化，请重新处理");
  }
}

/**
 * Eligible evidence already attached to the given revisions but outside the
 * local experience (added by a cross-exploration effect), so a correction can
 * keep citing it. Keys continue after the local rows.
 */
export async function loadLinkedForeignEvidence(
  db: Pick<Db, "select">,
  ctx: PersonalContext,
  revisionIds: string[],
  local: EvidenceRow[],
): Promise<EvidenceRow[]> {
  if (!revisionIds.length) return [];
  const rows = await db
    .select({
      spanId: coreSchema.evidenceSpans.id,
      sourceItemId: coreSchema.sourceItems.id,
      quote: coreSchema.evidenceSpans.quote,
      authorKind: coreSchema.evidenceSpans.authorKind,
      group: coreSchema.claimEvidence.independenceGroup,
      eligibility: coreSchema.sourceAssessments.eligibility,
      assessmentVersion: coreSchema.sourceAssessments.version,
      attributionStatus: coreSchema.sourceAssessments.attributionStatus,
      contextCompleteness: coreSchema.sourceAssessments.contextCompleteness,
      temporalPrecision: coreSchema.sourceAssessments.temporalPrecision,
      rationale: coreSchema.sourceAssessments.rationale,
    })
    .from(coreSchema.claimEvidence)
    .innerJoin(
      coreSchema.evidenceSpans,
      eq(coreSchema.claimEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
    )
    .innerJoin(
      coreSchema.sourceItems,
      eq(coreSchema.sourceItems.id, coreSchema.evidenceSpans.sourceItemId),
    )
    .innerJoin(
      coreSchema.sourceAssessments,
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, coreSchema.sourceItems.id),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .where(
      and(
        inArray(coreSchema.claimEvidence.claimRevisionId, revisionIds),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
        eq(coreSchema.sourceItems.usageStatus, "active"),
        eq(coreSchema.sourceAssessments.eligibility, "eligible"),
      ),
    )
    .orderBy(coreSchema.evidenceSpans.createdAt);
  const known = new Set(local.map((row) => row.spanId));
  const result: EvidenceRow[] = [];
  for (const row of rows) {
    if (known.has(row.spanId)) continue;
    known.add(row.spanId);
    result.push({
      key: `E${local.length + result.length + 1}`,
      spanId: row.spanId,
      sourceItemId: row.sourceItemId,
      quote: row.quote,
      authorKind: row.authorKind,
      eligibility: row.eligibility,
      assessmentVersion: row.assessmentVersion,
      attributionStatus: row.attributionStatus,
      contextCompleteness: row.contextCompleteness,
      temporalPrecision: row.temporalPrecision,
      assessmentRationale: row.rationale,
      independenceGroup: row.group,
    });
  }
  return result;
}

/**
 * An amended input may support revisions of claims owned by other explorations
 * (cross-exploration effects). Mark those current revisions stale like the
 * amended exploration's own claims, so they leave the usable prior context.
 */
export async function staleOtherUsesOfSource(
  tx: Pick<Db, "select" | "update">,
  ctx: PersonalContext,
  args: { sourceId: string; explorationId: string; reason: string },
) {
  const uses = await tx
    .select({ revisionId: coreSchema.claimRevisions.id, claimKey: coreSchema.claims.claimKey })
    .from(coreSchema.claimEvidence)
    .innerJoin(
      coreSchema.evidenceSpans,
      eq(coreSchema.claimEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
    )
    .innerJoin(
      coreSchema.claimRevisions,
      eq(coreSchema.claimRevisions.id, coreSchema.claimEvidence.claimRevisionId),
    )
    .innerJoin(coreSchema.claims, eq(coreSchema.claims.id, coreSchema.claimRevisions.claimId))
    .where(
      and(
        eq(coreSchema.evidenceSpans.sourceItemId, args.sourceId),
        eq(coreSchema.claims.tenantId, ctx.tenantId),
        eq(coreSchema.claims.subjectId, ctx.subjectId),
        eq(coreSchema.claimRevisions.status, "current"),
      ),
    );
  const ids = [
    ...new Set(
      uses
        .filter((use) => !use.claimKey.startsWith(`${args.explorationId}/`))
        .map((use) => use.revisionId),
    ),
  ];
  if (!ids.length) return [];
  await tx
    .update(coreSchema.claimRevisions)
    .set({ evidenceStatus: "stale", invalidatedAt: new Date(), invalidationReason: args.reason })
    .where(
      and(
        inArray(coreSchema.claimRevisions.id, ids),
        eq(coreSchema.claimRevisions.evidenceStatus, "valid"),
      ),
    );
  return ids;
}
