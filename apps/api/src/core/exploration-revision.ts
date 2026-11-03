import { AmendSourceInput, CorrectUnderstandingInput } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  PURPOSEFUL_EXPLORATION_POLICY,
  REVISION_VALIDATOR_VERSION,
  inputFingerprint,
} from "./epistemic-policy.js";
import { CoreError } from "./errors.js";
import { evidenceText, jsonObject, modelClaimKey } from "./exploration-context.js";
import {
  bumpExplorationVersion,
  createSource,
  persistClaimRevision,
  replaceGaps,
  withdrawClaim,
} from "./exploration-persistence.js";
import { buildEvidenceSet, loadCurrentClaimRows, loadExploration } from "./exploration-reading.js";
import {
  type CoreStore,
  type EvidenceRow,
  type PersonalContext,
  directCoreStore,
} from "./exploration-types.js";
import { generateValidatedRevision } from "./exploration-validation.js";
import type { CoreGateway } from "./llm.js";
import { OBSERVATION_MODEL_ROUTE, REVISION_PROMPT_VERSION } from "./llm.js";
import { completeCoreOperation, lockCoreOperation } from "./operations.js";
import { loadLinkedForeignEvidence, staleOtherUsesOfSource } from "./prior-understanding.js";

export async function correctUnderstanding(
  db: Db,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  return correctUnderstandingWith(directCoreStore(db), gateway, ctx, input, operationId);
}

async function readCorrectionBasis(
  db: Db,
  ctx: PersonalContext,
  parsed: ReturnType<typeof CorrectUnderstandingInput.parse>,
) {
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  }

  const oldRevisions = await db
    .select()
    .from(coreSchema.claimRevisions)
    .where(inArray(coreSchema.claimRevisions.id, parsed.claim_revision_ids));
  if (
    oldRevisions.length !== parsed.claim_revision_ids.length ||
    oldRevisions.some((row) => row.status !== "current")
  ) {
    throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");
  }

  const claimIds = [...new Set(oldRevisions.map((row) => row.claimId))];
  const oldClaims = await db
    .select()
    .from(coreSchema.claims)
    .where(inArray(coreSchema.claims.id, claimIds));

  for (const claim of oldClaims) {
    if (
      claim.tenantId !== ctx.tenantId ||
      claim.subjectId !== ctx.subjectId ||
      !claim.claimKey.startsWith(`${exploration.id}/`)
    ) {
      throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本不属于当前探索");
    }
  }

  const oldContext = oldClaims.map((claim) => {
    const revision = oldRevisions.find((row) => row.claimId === claim.id);
    return {
      key: modelClaimKey(exploration.id, claim.claimKey),
      kind: claim.claimKind,
      revision_id: revision?.id,
      text: revision?.text,
      scope: revision?.scope,
      confidence_level: revision?.confidenceLevel,
    };
  });

  const localRows = await buildEvidenceSet(db, ctx, exploration.experienceId);
  // A revision updated from another experience also cites that experience's
  // evidence; offer it so the correction can keep (or drop) it explicitly.
  const foreign = await loadLinkedForeignEvidence(db, ctx, parsed.claim_revision_ids, localRows);
  const existingRows = [...localRows, ...foreign];
  return { exploration, oldClaims, oldContext, existingRows };
}

export async function correctUnderstandingWith(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = CorrectUnderstandingInput.parse(input);
  const { exploration, oldClaims, oldContext, existingRows } = await store.read((db) =>
    readCorrectionBasis(db, ctx, parsed),
  );
  // Treat the correction as pending evidence during generation. Persist it only
  // after the model output has passed schema/evidence/revision validation.
  const pending: EvidenceRow = {
    key: `E${existingRows.length + 1}`,
    spanId: "pending",
    sourceItemId: "pending",
    quote: parsed.correction.note,
    authorKind: "subject",
    eligibility: "eligible",
    assessmentVersion: 1,
    attributionStatus: "confirmed_subject",
    contextCompleteness: "partial",
    temporalPrecision: "unknown",
    assessmentRationale: "用户在 FindMe 原生探索中直接提供。",
  };
  const rows = [...existingRows, pending];

  const revisionInput = [
    "EVIDENCE:",
    evidenceText(rows),
    "",
    "CURRENT_CLAIMS_TO_REVISE (context only, not evidence):",
    JSON.stringify(oldContext),
    "",
    "USER_CORRECTION:",
    JSON.stringify(parsed.correction),
  ].join("\n");

  const oldKeys = oldContext.map((item) => item.key);
  const model = gateway.describe(OBSERVATION_MODEL_ROUTE);
  const generatedRevision = await generateValidatedRevision(gateway, revisionInput, rows, oldKeys);
  const draft = generatedRevision.draft;
  const revisionInputFingerprint = inputFingerprint([
    PURPOSEFUL_EXPLORATION_POLICY.version,
    REVISION_PROMPT_VERSION,
    REVISION_VALIDATOR_VERSION,
    model.route,
    model.model,
    parsed.expected_version,
    generatedRevision.meta.inputText,
  ]);
  const revisionGeneration = {
    policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
    prompt_version: REVISION_PROMPT_VERSION,
    model_route: model.route,
    model_version: model.model,
    validator_version: REVISION_VALIDATOR_VERSION,
    input_fingerprint: revisionInputFingerprint,
    decision_source: "revision" as const,
    revision_latency_ms: generatedRevision.meta.latencyMs,
    attempts: generatedRevision.meta.attempts,
    validator_status: generatedRevision.meta.validatorStatus,
    validation_issues: generatedRevision.meta.validationIssues,
    claim_revision_ids: [] as string[],
  };

  return store.write((db) =>
    db.transaction(async (tx) => {
      // Same order as source deletion: operation row before claim revisions.
      if (operationId) await lockCoreOperation(tx, operationId);
      const nextVersion = await bumpExplorationVersion(
        tx,
        ctx,
        exploration.id,
        parsed.expected_version,
      );

      // Lock the targets through persistence: a concurrent cross-exploration
      // update (which does not bump this exploration) either waits or makes
      // this correction stale, never silently overwritten or duplicated.
      const targets = await tx
        .select({ id: coreSchema.claimRevisions.id, status: coreSchema.claimRevisions.status })
        .from(coreSchema.claimRevisions)
        .where(inArray(coreSchema.claimRevisions.id, parsed.claim_revision_ids))
        .orderBy(coreSchema.claimRevisions.id)
        .for("update");
      const stillCurrent = targets.filter((row) => row.status === "current");
      if (stillCurrent.length !== parsed.claim_revision_ids.length) {
        throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");
      }

      const { source, span } = await createSource(tx, ctx, {
        kind: "guided_response",
        content: parsed.correction.note,
        meta: {
          exploration_id: exploration.id,
          correction_type: parsed.correction.type,
          claim_revision_ids: parsed.claim_revision_ids,
          generation: revisionGeneration,
        },
        contextCompleteness: "partial",
      });
      pending.sourceItemId = source.id;
      pending.spanId = span.id;

      await tx.insert(coreSchema.experienceEvidence).values({
        experienceId: exploration.experienceId,
        evidenceSpanId: span.id,
        relation: "describes",
      });
      await tx.insert(coreSchema.explorationTurns).values({
        explorationId: exploration.id,
        sourceItemId: source.id,
        role: "user",
        turnKind: "correction",
        content: parsed.correction.note,
      });
      for (const targetId of parsed.claim_revision_ids) {
        await tx.insert(coreSchema.feedbackEvents).values({
          tenantId: ctx.tenantId,
          subjectId: ctx.subjectId,
          explorationId: exploration.id,
          targetType: "claim_revision",
          targetId,
          feedbackType: parsed.correction.type,
          note: parsed.correction.note,
          sourceItemId: source.id,
        });
      }

      const persisted = [];
      for (const claim of draft.claims) {
        persisted.push(
          await persistClaimRevision(
            tx,
            ctx,
            exploration.id,
            exploration.experienceId,
            claim,
            rows,
            draft.revision_reason,
          ),
        );
      }
      const withdrawn = [];
      for (const key of draft.withdrawn_claim_keys ?? []) {
        const old = oldClaims.find(
          (claim) => modelClaimKey(exploration.id, claim.claimKey) === key,
        );
        if (old) {
          const revision = await withdrawClaim(tx, old.id, draft.revision_reason);
          if (revision) withdrawn.push(revision);
        }
      }

      const outputClaimRevisionIds = [
        ...persisted.map(({ revision }) => revision.id),
        ...withdrawn.map((revision) => revision.id),
      ];
      await tx
        .update(coreSchema.sourceItems)
        .set({
          sourceMeta: {
            exploration_id: exploration.id,
            correction_type: parsed.correction.type,
            claim_revision_ids: parsed.claim_revision_ids,
            generation: {
              ...revisionGeneration,
              claim_revision_ids: outputClaimRevisionIds,
            },
          },
        })
        .where(eq(coreSchema.sourceItems.id, source.id));

      await replaceGaps(tx, exploration.id, draft);

      const outcome = draft.claims.length > 0 ? "provisional" : "withdrawn";
      const response = jsonObject({
        exploration_id: exploration.id,
        experience_id: exploration.experienceId,
        version: nextVersion,
        outcome,
        change_summary: draft.change_summary,
        revision_reason: draft.revision_reason,
        before: oldContext,
        claims: persisted.map(({ claim, revision }) => ({
          claim_id: claim.id,
          claim_revision_id: revision.id,
          key: modelClaimKey(exploration.id, claim.claimKey),
          kind: claim.claimKind,
          mode: revision.mode,
          text: revision.text,
          scope: revision.scope,
          confidence_level: revision.confidenceLevel,
          confidence_basis: revision.confidenceBasis,
        })),
        withdrawn_claim_keys: draft.withdrawn_claim_keys ?? [],
        gaps: draft.gaps,
        next_question: draft.next_question,
        evidence: rows,
        timing: { revision_ms: generatedRevision.meta.latencyMs },
      });
      if (operationId) await completeCoreOperation(tx, operationId, 201, response);
      return response;
    }),
  );
}

export async function amendExplorationSource(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = AmendSourceInput.parse(input);
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  }

  const [targetSource] = await db
    .select()
    .from(coreSchema.sourceItems)
    .where(
      and(
        eq(coreSchema.sourceItems.id, parsed.target_source_id),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!targetSource) throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "要修改的输入不存在");

  const [linked] = await db
    .select({ spanId: coreSchema.evidenceSpans.id })
    .from(coreSchema.experienceEvidence)
    .innerJoin(
      coreSchema.evidenceSpans,
      eq(coreSchema.experienceEvidence.evidenceSpanId, coreSchema.evidenceSpans.id),
    )
    .where(
      and(
        eq(coreSchema.experienceEvidence.experienceId, exploration.experienceId),
        eq(coreSchema.evidenceSpans.sourceItemId, targetSource.id),
      ),
    )
    .limit(1);
  if (!linked) throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "这条输入不属于当前探索");

  const [currentAssessment] = await db
    .select()
    .from(coreSchema.sourceAssessments)
    .where(
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, targetSource.id),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .limit(1);
  if (!currentAssessment) {
    throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源当前评估不存在");
  }

  return db.transaction(async (tx) => {
    const nextVersion = await bumpExplorationVersion(
      tx,
      ctx,
      exploration.id,
      parsed.expected_version,
    );

    if (parsed.type === "corrects") {
      const [retired] = await tx
        .update(coreSchema.sourceAssessments)
        .set({ isCurrent: false })
        .where(
          and(
            eq(coreSchema.sourceAssessments.id, currentAssessment.id),
            eq(coreSchema.sourceAssessments.isCurrent, true),
          ),
        )
        .returning({ id: coreSchema.sourceAssessments.id });
      if (!retired) {
        throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源评估已经发生变化");
      }
      await tx.insert(coreSchema.sourceAssessments).values({
        sourceItemId: targetSource.id,
        version: currentAssessment.version + 1,
        attributionStatus: currentAssessment.attributionStatus,
        contextCompleteness: currentAssessment.contextCompleteness,
        temporalPrecision: currentAssessment.temporalPrecision,
        eligibility: "excluded",
        rationale: "用户明确更正了这条输入；旧文本保留历史，但停止参与当前分析。",
        isCurrent: true,
        supersedesId: currentAssessment.id,
      });
    }

    const { source, span } = await createSource(tx, ctx, {
      kind: "guided_amendment",
      content: parsed.note,
      meta: {
        exploration_id: exploration.id,
        target_source_id: targetSource.id,
        amendment_type: parsed.type,
      },
      contextCompleteness: "partial",
    });
    await tx.insert(coreSchema.experienceEvidence).values({
      experienceId: exploration.experienceId,
      evidenceSpanId: span.id,
      relation: "describes",
    });
    await tx.insert(coreSchema.sourceLinks).values({
      sourceItemId: source.id,
      targetSourceItemId: targetSource.id,
      relation: parsed.type,
    });
    await tx.insert(coreSchema.explorationTurns).values({
      explorationId: exploration.id,
      sourceItemId: source.id,
      role: "user",
      turnKind: "amendment",
      content: parsed.note,
    });

    await tx
      .update(coreSchema.explorationQuestions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(coreSchema.explorationQuestions.explorationId, exploration.id),
          eq(coreSchema.explorationQuestions.status, "open"),
        ),
      );

    await staleOtherUsesOfSource(tx, ctx, {
      sourceId: targetSource.id,
      explorationId: exploration.id,
      reason: `source_amendment:${source.id}`,
    });
    const currentClaims = await loadCurrentClaimRows(tx, ctx, exploration.id);
    for (const claim of currentClaims) {
      await tx
        .update(coreSchema.claimRevisions)
        .set({
          evidenceStatus: "stale",
          invalidatedAt: new Date(),
          invalidationReason: `source_amendment:${source.id}`,
        })
        .where(eq(coreSchema.claimRevisions.id, claim.revisionId));
    }

    const response = jsonObject({
      exploration_id: exploration.id,
      version: nextVersion,
      phase: "ready_to_plan",
      amendment: {
        type: parsed.type,
        target_source_id: targetSource.id,
        source_id: source.id,
      },
      saved: true,
    });
    if (operationId) await completeCoreOperation(tx, operationId, 201, response);
    return response;
  });
}
