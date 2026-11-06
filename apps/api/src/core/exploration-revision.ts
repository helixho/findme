import { AmendSourceInput, CorrectUnderstandingInput } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ProcessCorrectionInput, saveCorrectionTx } from "./conversation.js";
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
import { type CoreStore, type PersonalContext, directCoreStore } from "./exploration-types.js";
import { generateValidatedRevision } from "./exploration-validation.js";
import type { CoreGateway } from "./llm.js";
import { OBSERVATION_MODEL_ROUTE, REVISION_PROMPT_VERSION } from "./llm.js";
import { completeCoreOperation, lockCoreOperation } from "./operations.js";
import {
  assertEvidenceUsable,
  loadLinkedForeignEvidence,
  staleOtherUsesOfSource,
} from "./prior-understanding.js";

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
  parsed: { exploration_id: string; expected_version: number; claim_revision_ids: string[] },
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
      interaction_preference: revision?.details?.interaction_preference,
    };
  });

  const localRows = await buildEvidenceSet(db, ctx, exploration.experienceId);
  // A revision updated from another experience also cites that experience's
  // evidence; offer it so the correction can keep (or drop) it explicitly.
  const foreign = await loadLinkedForeignEvidence(db, ctx, parsed.claim_revision_ids, localRows);
  const existingRows = [...localRows, ...foreign];
  return { exploration, oldClaims, oldRevisions, oldContext, existingRows };
}

type SavedCorrection = {
  sourceId: string;
  correction: { type: string; note: string };
  claimRevisionIds: string[];
  meta: Record<string, unknown>;
};

async function readSavedCorrection(
  db: Db,
  ctx: PersonalContext,
  explorationId: string,
  sourceId: string,
): Promise<SavedCorrection> {
  const [source] = await db
    .select()
    .from(coreSchema.sourceItems)
    .where(
      and(
        eq(coreSchema.sourceItems.id, sourceId),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  const meta = (source?.sourceMeta ?? {}) as Record<string, unknown>;
  if (!source || meta.exploration_id !== explorationId)
    throw new CoreError("CORRECTION_NOT_FOUND", 404, "这条纠正不存在");
  if (meta.correction_status !== "pending")
    throw new CoreError("CORRECTION_NOT_PENDING", 409, "这条纠正已经处理过");
  return {
    sourceId: source.id,
    correction: { type: String(meta.correction_type ?? "other"), note: source.content },
    claimRevisionIds: Array.isArray(meta.claim_revision_ids)
      ? (meta.claim_revision_ids as string[])
      : [],
    meta,
  };
}

/**
 * Corrections are saved before any model work. The legacy body
 * (`claim_revision_ids` + `correction`) saves first and then processes; a
 * retry of the same operation reuses the correction it already saved.
 * `correction_source_id` processes a correction saved earlier.
 */
export async function correctUnderstandingWith(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  let target: { exploration_id: string; expected_version: number; correction_source_id: string };
  if (input && typeof input === "object" && "correction_source_id" in input) {
    target = ProcessCorrectionInput.parse(input);
  } else {
    const legacy = CorrectUnderstandingInput.parse(input);
    const reused = operationId
      ? await store.read(async (db) => {
          const [row] = await db
            .select({ id: coreSchema.sourceItems.id })
            .from(coreSchema.sourceItems)
            .where(
              and(
                eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
                eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
                sql`${coreSchema.sourceItems.sourceMeta}->>'correction_operation_id' = ${operationId}`,
              ),
            )
            .limit(1);
          if (!row) return null;
          const exploration = await loadExploration(db, ctx, legacy.exploration_id);
          return { id: row.id, version: exploration.version };
        })
      : null;
    if (reused) {
      target = {
        exploration_id: legacy.exploration_id,
        expected_version: reused.version,
        correction_source_id: reused.id,
      };
    } else {
      const saved = await store.write((db) =>
        db.transaction((tx) =>
          saveCorrectionTx(
            tx as unknown as Db,
            ctx,
            legacy,
            operationId ? { correction_operation_id: operationId } : {},
          ),
        ),
      );
      target = {
        exploration_id: legacy.exploration_id,
        expected_version: saved.version,
        correction_source_id: saved.sourceId,
      };
    }
  }
  return processSavedCorrection(store, gateway, ctx, target, operationId);
}

async function processSavedCorrection(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  parsed: { exploration_id: string; expected_version: number; correction_source_id: string },
  operationId?: string,
) {
  const { saved, exploration, oldClaims, oldRevisions, oldContext, existingRows } =
    await store.read(async (db) => {
      const saved = await readSavedCorrection(
        db,
        ctx,
        parsed.exploration_id,
        parsed.correction_source_id,
      );
      const basis = await readCorrectionBasis(db, ctx, {
        exploration_id: parsed.exploration_id,
        expected_version: parsed.expected_version,
        claim_revision_ids: saved.claimRevisionIds,
      });
      return { saved, ...basis };
    });
  const correctionRow = existingRows.find((row) => row.sourceItemId === saved.sourceId);
  if (!correctionRow)
    throw new CoreError("CORRECTION_NOT_ELIGIBLE", 409, "这条纠正已不再参与当前分析");
  // Keep the correction as the last evidence key, as before it was saved first.
  const rows = [...existingRows.filter((row) => row !== correctionRow), correctionRow].map(
    (row, index) => ({ ...row, key: `E${index + 1}` }),
  );

  const revisionInput = [
    "EVIDENCE:",
    evidenceText(rows),
    "",
    "CURRENT_CLAIMS_TO_REVISE (context only, not evidence):",
    JSON.stringify(oldContext),
    "",
    "USER_CORRECTION:",
    JSON.stringify(saved.correction),
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
        { reopen: true },
      );
      await assertEvidenceUsable(tx, ctx, rows);

      // Lock the targets through persistence: a concurrent cross-exploration
      // update (which does not bump this exploration) either waits or makes
      // this correction stale, never silently overwritten or duplicated.
      const targets = await tx
        .select({
          id: coreSchema.claimRevisions.id,
          status: coreSchema.claimRevisions.status,
          evidenceStatus: coreSchema.claimRevisions.evidenceStatus,
        })
        .from(coreSchema.claimRevisions)
        .where(inArray(coreSchema.claimRevisions.id, saved.claimRevisionIds))
        .orderBy(coreSchema.claimRevisions.id)
        .for("update");
      const stillCurrent = targets.filter(
        (row) =>
          row.status === "current" &&
          row.evidenceStatus === oldRevisions.find((old) => old.id === row.id)?.evidenceStatus,
      );
      if (stillCurrent.length !== saved.claimRevisionIds.length) {
        throw new CoreError("STALE_CLAIM_REVISION", 409, "认识版本已经发生变化");
      }
      // The saved correction must still be pending (no concurrent processing).
      const [current] = await tx
        .select({ meta: coreSchema.sourceItems.sourceMeta })
        .from(coreSchema.sourceItems)
        .where(eq(coreSchema.sourceItems.id, saved.sourceId))
        .for("update");
      if ((current?.meta as Record<string, unknown> | null)?.correction_status !== "pending")
        throw new CoreError("CORRECTION_NOT_PENDING", 409, "这条纠正已经处理过");

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
            ...saved.meta,
            correction_status: "processed",
            generation: {
              ...revisionGeneration,
              claim_revision_ids: outputClaimRevisionIds,
            },
          },
        })
        .where(eq(coreSchema.sourceItems.id, saved.sourceId));

      await replaceGaps(tx, exploration.id, draft);

      const outcome = draft.claims.length > 0 ? "provisional" : "withdrawn";
      const response = jsonObject({
        exploration_id: exploration.id,
        experience_id: exploration.experienceId,
        version: nextVersion,
        correction_source_id: saved.sourceId,
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
