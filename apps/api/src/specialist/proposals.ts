import { type Db, specialistSchema } from "@findme/db";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ConfirmInput, DecisionInput, ProposalInput } from "./contracts.js";
import { contentBasis, optionKinds } from "./policy.js";
import { ownedProposal, ownedSession } from "./repository.js";
import { type PublishedClaimResolver, type PublishedContentLister, result } from "./types.js";
export async function listCandidates(
  db: Db,
  ctx: PersonalContext,
  id: string,
  listContent: PublishedContentLister,
) {
  const session = await ownedSession(db, ctx, id);
  if (!session) return result({ error: "session_not_found" }, 404);
  if (session.status !== "open") return result({ status: "session_paused", items: [] });
  const missing = [
    !session.goal && "goal",
    !session.difficulty &&
      session.difficultyCategories.length === 0 &&
      !session.environment &&
      "difficulty_or_environment",
    !session.setting && !session.environment && "setting_or_environment",
  ].filter(Boolean);
  if (missing.length)
    return result({ status: "insufficient_personal_context", missing, items: [] });
  const selectedKeys = new Set([...session.difficultyCategories, ...session.environmentCategories]);
  const items = listContent().flatMap((version) =>
    version.claims.flatMap((claim) => {
      const typedClaim = claim as typeof claim & {
        applicability_keys: string[];
        burdens: string[];
        costs: string[];
        unknowns: string[];
        not_applicable_keys: string[];
        candidate_options: string[];
      };
      const matched = (typedClaim.applicability_keys ?? []).filter((key) => selectedKeys.has(key));
      const excluded = (typedClaim.not_applicable_keys ?? []).filter((key) =>
        session.scopeFlags.includes(key),
      );
      if (
        matched.length === 0 ||
        excluded.length > 0 ||
        !typedClaim.burdens?.length ||
        !typedClaim.costs?.length ||
        !typedClaim.unknowns?.length
      )
        return [];
      return [
        {
          content_id: version.content_id,
          version: version.version,
          title: version.title,
          claim_id: claim.id,
          claim_text: claim.text,
          candidate_options: typedClaim.candidate_options,
          applicable_when: claim.applicable_when,
          not_applicable_when: claim.not_applicable_when,
          limits: claim.limits,
          sources: version.sources,
          evidence_chunks: version.evidence_chunks.filter((chunk) =>
            claim.evidence_chunk_ids.includes(chunk.id),
          ),
          eligibility: { matched_keys: matched, excluded_by: excluded },
          burdens: typedClaim.burdens,
          costs: typedClaim.costs,
          unknowns: typedClaim.unknowns,
        },
      ];
    }),
  );
  return result({ status: items.length ? "ready" : "no_applicable_published_content", items });
}

export async function createProposal(
  db: Db,
  ctx: PersonalContext,
  id: string,
  body: ProposalInput,
  idempotencyKey: string | null,
  selectClaim: PublishedClaimResolver,
) {
  const session = await ownedSession(db, ctx, id);
  if (!session) return result({ error: "session_not_found" }, 404);
  if (session.status !== "open") return result({ error: "session_paused" }, 409);
  if (
    !session.goal ||
    (!session.difficulty && session.difficultyCategories.length === 0 && !session.environment) ||
    (!session.setting && !session.environment)
  ) {
    return result(
      {
        error: "insufficient_personal_basis",
        required: ["goal", "setting_or_environment", "difficulty_or_environment"],
      },
      422,
    );
  }
  if (!idempotencyKey) return result({ error: "idempotency_key_required" }, 400);
  const [existing] = await db
    .select()
    .from(specialistSchema.specialistProposals)
    .where(
      and(
        eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistProposals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return result({ proposal: existing, replayed: true });
  const selected = selectClaim(body.content_id, body.claim_id);
  if (!selected || selected.version.version !== body.content_version)
    return result({ error: "published_claim_unavailable_or_stale" }, 409);
  const typedClaim = selected.claim as typeof selected.claim & {
    applicability_keys: string[];
    not_applicable_keys: string[];
    candidate_options: string[];
    burdens: string[];
    costs: string[];
    unknowns: string[];
  };
  const selectedKeys = new Set([...session.difficultyCategories, ...session.environmentCategories]);
  const matched = typedClaim.applicability_keys.filter((key) => selectedKeys.has(key));
  const matchedKeySet = new Set<string>(matched);
  const excluded = typedClaim.not_applicable_keys.filter((key) => session.scopeFlags.includes(key));
  if (
    !matched.length ||
    excluded.length ||
    body.applicability_confirmed.some((key) => !matchedKeySet.has(key))
  ) {
    return result(
      { error: "claim_not_applicable_to_context", matched_keys: matched, excluded_by: excluded },
      422,
    );
  }
  if (!typedClaim.burdens.length || !typedClaim.costs.length || !typedClaim.unknowns.length)
    return result({ error: "published_claim_missing_limits" }, 409);
  if (
    body.evidence_mode === "content_supported" &&
    !typedClaim.candidate_options.includes(body.action_text)
  ) {
    return result(
      {
        error: "action_must_be_selected_from_published_options",
        candidate_options: typedClaim.candidate_options,
      },
      422,
    );
  }
  if (
    body.evidence_mode === "content_supported" &&
    !optionKinds(body.action_text).has(body.adjustment_kind)
  ) {
    return result({ error: "adjustment_kind_does_not_match_published_option" }, 422);
  }
  const basis = contentBasis(selected.version, selected.claim);
  const [proposal] = await db
    .insert(specialistSchema.specialistProposals)
    .values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      sessionId: session.id,
      idempotencyKey,
      adjustmentKind: body.adjustment_kind,
      actionText: body.action_text,
      burden: typedClaim.burdens.join("\n"),
      cost: typedClaim.costs.join("\n"),
      unknowns: typedClaim.unknowns.join("\n"),
      personalBasis: {
        session_id: session.id,
        pathway: session.pathway,
        goal: session.goal,
        setting: session.setting,
        difficulty: session.difficulty,
        difficulty_categories: session.difficultyCategories,
        environment: session.environment,
        environment_categories: session.environmentCategories,
        existing_supports: session.existingSupports,
      },
      applicability: {
        matched_keys: matched,
        user_confirmed: body.applicability_confirmed,
        excluded_by: excluded,
      },
      contentBasis: basis,
      evidenceMode: body.evidence_mode,
    })
    .returning();
  return result({ proposal }, 201);
}

export async function listProposals(db: Db, ctx: PersonalContext, id: string) {
  if (!(await ownedSession(db, ctx, id))) return result({ error: "session_not_found" }, 404);
  const items = await db
    .select()
    .from(specialistSchema.specialistProposals)
    .where(
      and(
        eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistProposals.sessionId, id),
      ),
    )
    .orderBy(desc(specialistSchema.specialistProposals.createdAt));
  return result({ items });
}

export async function confirmProposal(
  db: Db,
  ctx: PersonalContext,
  id: string,
  body: ConfirmInput,
  selectClaim: PublishedClaimResolver,
) {
  const proposal = await ownedProposal(db, ctx, id);
  if (!proposal) return result({ error: "proposal_not_found" }, 404);
  if (proposal.status === "accepted") {
    const [trial] = await db
      .select()
      .from(specialistSchema.specialistTrials)
      .where(
        and(
          eq(specialistSchema.specialistTrials.tenantId, ctx.tenantId),
          eq(specialistSchema.specialistTrials.subjectId, ctx.subjectId),
          eq(specialistSchema.specialistTrials.proposalId, proposal.id),
        ),
      )
      .limit(1);
    if (trial) return result({ proposal, trial, replayed: true });
  }
  if (proposal.version !== body.expected_version)
    return result({ error: "version_conflict", current_version: proposal.version }, 409);
  if (proposal.status !== "proposed")
    return result({ error: "proposal_not_open", status: proposal.status }, 409);
  const savedContent = proposal.contentBasis as {
    content_id?: string;
    version?: string;
    claim?: { id?: string };
  };
  const currentClaim =
    savedContent.content_id && savedContent.claim?.id
      ? selectClaim(savedContent.content_id, savedContent.claim.id)
      : null;
  if (!currentClaim || currentClaim.version.version !== savedContent.version) {
    return result({ error: "published_content_changed_review_again" }, 409);
  }
  const saved = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(specialistSchema.specialistProposals)
      .set({
        status: "accepted",
        version: proposal.version + 1,
        decidedAt: new Date(),
        decisionNote: body.modified_action_text
          ? "用户确认并调整了行动文本；该改写作为探索性尝试记录"
          : null,
        ...(body.modified_action_text
          ? { actionText: body.modified_action_text, evidenceMode: "exploratory" }
          : {}),
      })
      .where(
        and(
          eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
          eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
          eq(specialistSchema.specialistProposals.id, proposal.id),
          eq(specialistSchema.specialistProposals.version, body.expected_version),
          eq(specialistSchema.specialistProposals.status, "proposed"),
        ),
      )
      .returning();
    if (!updated) return null;
    const [trial] = await tx
      .insert(specialistSchema.specialistTrials)
      .values({
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        proposalId: proposal.id,
        sessionId: proposal.sessionId,
        acceptedAction: updated.actionText,
        acceptedProposalVersion: updated.version,
      })
      .returning();
    return { proposal: updated, trial };
  });
  if (!saved) return result({ error: "version_conflict" }, 409);
  return result(saved, 201);
}

export async function decideProposal(
  db: Db,
  ctx: PersonalContext,
  id: string,
  body: DecisionInput,
  decision: "reject" | "pause",
) {
  const proposal = await ownedProposal(db, ctx, id);
  if (!proposal) return result({ error: "proposal_not_found" }, 404);
  if (proposal.version !== body.expected_version)
    return result({ error: "version_conflict", current_version: proposal.version }, 409);
  if (proposal.status !== "proposed")
    return result({ error: "proposal_not_open", status: proposal.status }, 409);
  const [updated] = await db
    .update(specialistSchema.specialistProposals)
    .set({
      status: decision === "reject" ? "rejected" : "paused",
      version: proposal.version + 1,
      decidedAt: new Date(),
      decisionNote: body.reason ?? null,
    })
    .where(
      and(
        eq(specialistSchema.specialistProposals.tenantId, ctx.tenantId),
        eq(specialistSchema.specialistProposals.subjectId, ctx.subjectId),
        eq(specialistSchema.specialistProposals.id, proposal.id),
        eq(specialistSchema.specialistProposals.version, body.expected_version),
        eq(specialistSchema.specialistProposals.status, "proposed"),
      ),
    )
    .returning();
  return updated ? result({ proposal: updated }) : result({ error: "version_conflict" }, 409);
}
