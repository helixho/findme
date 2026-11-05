import { ContinueExplorationInput, CoreReportTarget, type ExplorationPlan } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { eq } from "drizzle-orm";
import { markUnderstandingProcessed } from "./conversation.js";
import {
  PLAN_VALIDATOR_VERSION,
  PURPOSEFUL_EXPLORATION_POLICY,
  UNDERSTANDING_VALIDATOR_VERSION,
  buildPlannerContext,
  deterministicStopPlan,
  inputFingerprint,
  plannerGate,
} from "./epistemic-policy.js";
import { CoreError } from "./errors.js";
import {
  evidenceText,
  jsonObject,
  modelClaimKey,
  outcomeForUnderstanding,
} from "./exploration-context.js";
import {
  bumpExplorationVersion,
  persistClaimRevision,
  replaceGaps,
} from "./exploration-persistence.js";
import {
  buildEvidenceSet,
  loadCurrentClaimRows,
  loadExploration,
  loadExplorationSteps,
  loadOpenQuestion,
} from "./exploration-reading.js";
import { type CoreStore, type PersonalContext, directCoreStore } from "./exploration-types.js";
import {
  generateValidatedExplorationPlan,
  generateValidatedUnderstanding,
} from "./exploration-validation.js";
import type { CoreGateway } from "./llm.js";
import {
  EXPLORATION_PLAN_PROMPT_VERSION,
  OBSERVATION_MODEL_ROUTE,
  UNDERSTANDING_PRIOR_PROMPT_VERSION,
  UNDERSTANDING_PROMPT_VERSION,
} from "./llm.js";
import { completeCoreOperation, lockCoreOperation } from "./operations.js";
import {
  PRIOR_VALIDATOR_VERSION,
  applyPriorUpdates,
  assertPriorContextIntact,
  hasPriorContext,
  loadLinkedForeignEvidence,
  loadPriorUnderstanding,
  priorContextText,
  priorSelectionMeta,
  processingResult,
} from "./prior-understanding.js";

export async function continueExploration(
  db: Db,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  return continueExplorationWith(directCoreStore(db), gateway, ctx, input, operationId);
}

export async function continueExplorationWith(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = ContinueExplorationInput.parse(input);
  const read = await store.read((db) => readContinueBasis(db, ctx, parsed));
  return generateAndCommitContinue(store, gateway, ctx, parsed, read, operationId);
}

async function readContinueBasis(
  db: Db,
  ctx: PersonalContext,
  parsed: ReturnType<typeof ContinueExplorationInput.parse>,
) {
  const exploration = await loadExploration(db, ctx, parsed.exploration_id);
  if (exploration.version !== parsed.expected_version) {
    throw new CoreError("STALE_VERSION", 409, "探索已经发生变化", {
      current_version: exploration.version,
    });
  }

  const openQuestion = await loadOpenQuestion(db, exploration.id);
  if (openQuestion) {
    throw new CoreError("QUESTION_NOT_OPEN", 409, "当前还有一个待回答的问题");
  }

  const [experience] = await db
    .select()
    .from(coreSchema.experiences)
    .where(eq(coreSchema.experiences.id, exploration.experienceId))
    .limit(1);
  if (!experience) throw new Error("experience_not_found");

  const [claims, questions, steps, localRows, turns] = await Promise.all([
    loadCurrentClaimRows(db, ctx, exploration.id),
    db
      .select()
      .from(coreSchema.explorationQuestions)
      .where(eq(coreSchema.explorationQuestions.explorationId, exploration.id))
      .orderBy(coreSchema.explorationQuestions.sequence),
    loadExplorationSteps(db, exploration.id),
    buildEvidenceSet(db, ctx, exploration.experienceId),
    db
      .select()
      .from(coreSchema.explorationTurns)
      .where(eq(coreSchema.explorationTurns.explorationId, exploration.id))
      .orderBy(coreSchema.explorationTurns.createdAt),
  ]);

  // Evidence another experience attached to this exploration's current claims
  // (cross-exploration effects) stays citable so persistence does not drop it.
  const rows = [
    ...localRows,
    ...(await loadLinkedForeignEvidence(
      db,
      ctx,
      claims.map((claim) => claim.revisionId),
      localRows,
    )),
  ];
  const userText = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .join("\n");
  const prior = await loadPriorUnderstanding(db, ctx, {
    explorationId: exploration.id,
    queryText: `${experience.summary}\n${userText}`,
  });
  return { exploration, experience, claims, questions, steps, rows, turns, prior };
}

async function generateAndCommitContinue(
  store: CoreStore,
  gateway: CoreGateway,
  ctx: PersonalContext,
  parsed: ReturnType<typeof ContinueExplorationInput.parse>,
  basis: Awaited<ReturnType<typeof readContinueBasis>>,
  operationId?: string,
) {
  const { exploration, experience, claims, questions, steps, rows, turns, prior } = basis;
  const questionCount = questions.length;
  const latestUserTurn = [...turns].reverse().find((turn) => turn.role === "user") ?? null;
  const lastStep = steps.at(-1) ?? null;
  const gate = plannerGate({
    questionCount,
    forceDeeper: parsed.force_deeper,
  });
  const model = gateway.describe(OBSERVATION_MODEL_ROUTE);

  const plannerContext =
    buildPlannerContext({
      experience: experience.summary,
      evidenceText: evidenceText(rows),
      currentClaims: claims.map((claim) => ({
        key: claim.key,
        text: claim.text,
        scope: claim.scope,
        evidence_status: claim.evidenceStatus,
      })),
      questions: questions.map((question) => ({
        sequence: question.sequence,
        question: question.question,
        intent: question.intent,
        status: question.status,
      })),
      lastStep: lastStep
        ? {
            current_reading: lastStep.currentReading,
            key_uncertainty: lastStep.keyUncertainty,
            decision: lastStep.decision,
          }
        : null,
      questionCount,
      forceDeeper: parsed.force_deeper,
    }) +
    (exploration.ext?.report_target
      ? `\nREPORT_TARGET_CONTEXT_ONLY (not user evidence; never cite as support):\n${JSON.stringify(CoreReportTarget.parse(exploration.ext.report_target))}`
      : "") +
    priorContextText(prior);
  const priorMeta = priorSelectionMeta(prior);

  let plan: ExplorationPlan;
  let plannerMeta: {
    attempts: number;
    latencyMs: number;
    validatorStatus: "passed" | "fallback_stop" | "gate_stop";
    validationIssues: string[];
    inputText: string;
  };
  let decisionSource: "deterministic_gate" | "semantic_planner";

  if (gate.action === "stop") {
    plan = deterministicStopPlan({
      gate,
      fallbackReading: lastStep?.currentReading,
      fallbackUncertainty: lastStep?.keyUncertainty,
    });
    plannerMeta = {
      attempts: 0,
      latencyMs: 0,
      validatorStatus: "gate_stop",
      validationIssues: [],
      inputText: plannerContext,
    };
    decisionSource = "deterministic_gate";
  } else {
    const generated = await generateValidatedExplorationPlan(gateway, plannerContext, {
      previousQuestions: questions.map((question) => question.question),
      questionCount,
      forceDeeper: parsed.force_deeper,
      fallbackReading: lastStep?.currentReading,
      fallbackUncertainty: lastStep?.keyUncertainty,
    });
    plan = generated.plan;
    plannerMeta = generated.meta;
    decisionSource = "semantic_planner";
  }

  const plannerInputFingerprint = inputFingerprint([
    PURPOSEFUL_EXPLORATION_POLICY.version,
    EXPLORATION_PLAN_PROMPT_VERSION,
    PLAN_VALIDATOR_VERSION,
    model.route,
    model.model,
    parsed.expected_version,
    plannerMeta.inputText,
  ]);

  const plannerModelMeta = {
    policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
    policy_profile: PURPOSEFUL_EXPLORATION_POLICY.profile,
    prompt_version: EXPLORATION_PLAN_PROMPT_VERSION,
    model_route: model.route,
    model_version: model.model,
    validator_version: PLAN_VALIDATOR_VERSION,
    input_fingerprint: plannerInputFingerprint,
    decision_source: decisionSource,
    planner_attempts: plannerMeta.attempts,
    planner_latency_ms: plannerMeta.latencyMs,
    validator_status: plannerMeta.validatorStatus,
    validation_issues: plannerMeta.validationIssues,
    prior_understanding: priorMeta,
  };

  const stepSequence = steps.reduce((max, step) => Math.max(max, step.sequence), 0) + 1;
  const nextQuestionSequence =
    questions.reduce((max, question) => Math.max(max, question.sequence), 0) + 1;

  if (plan.decision === "ask") {
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
        const existingOpen = await loadOpenQuestion(tx, exploration.id);
        await assertPriorContextIntact(tx, prior);
        if (existingOpen) {
          throw new CoreError("QUESTION_NOT_OPEN", 409, "当前还有一个待回答的问题");
        }

        const [question] = await tx
          .insert(coreSchema.explorationQuestions)
          .values({
            explorationId: exploration.id,
            sequence: nextQuestionSequence,
            question: plan.question ?? "",
            intent: plan.intent,
            quickOptions: plan.quick_options,
            status: "open",
            modelMeta: plannerModelMeta,
          })
          .returning();
        if (!question) throw new Error("question_create_failed");

        await tx.insert(coreSchema.explorationTurns).values({
          explorationId: exploration.id,
          questionId: question.id,
          role: "assistant",
          turnKind: "question",
          content: plan.question ?? "",
        });
        await tx.insert(coreSchema.explorationSteps).values({
          explorationId: exploration.id,
          sequence: stepSequence,
          basisVersion: parsed.expected_version,
          inputTurnId: latestUserTurn?.id,
          currentReading: plan.current_reading,
          keyUncertainty: plan.key_uncertainty,
          decision: "ask",
          intent: plan.intent,
          questionId: question.id,
          modelMeta: plannerModelMeta,
        });

        const response = jsonObject({
          exploration_id: exploration.id,
          experience_id: exploration.experienceId,
          version: nextVersion,
          phase: "awaiting_answer",
          reading: {
            current_reading: plan.current_reading,
            key_uncertainty: plan.key_uncertainty,
            intent: plan.intent,
          },
          question: {
            id: question.id,
            sequence: question.sequence,
            status: question.status,
            question: plan.question,
            intent: plan.intent,
            quick_options: plan.quick_options,
          },
          question_budget: {
            asked: questionCount + 1,
            default_budget: PURPOSEFUL_EXPLORATION_POLICY.defaultQuestionBudget,
            hard_cap: PURPOSEFUL_EXPLORATION_POLICY.hardQuestionCap,
            policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
          },
          timing: { planner_ms: plannerMeta.latencyMs },
          prior_understanding: priorMeta,
        });
        if (operationId) await completeCoreOperation(tx, operationId, 201, response);
        return response;
      }),
    );
  }

  const understandingInput =
    [
      "EVIDENCE:",
      evidenceText(rows),
      "",
      "CURRENT_CLAIMS (context only; reuse key for the same understanding):",
      JSON.stringify(
        claims.map((claim) => ({
          key: claim.key,
          kind: claim.claimKind,
          mode: claim.mode,
          text: claim.text,
          scope: claim.scope,
          evidence_status: claim.evidenceStatus,
        })),
      ),
    ].join("\n") + priorContextText(prior);
  const usesPrior = hasPriorContext(prior);
  const synthesisPromptVersion = usesPrior
    ? UNDERSTANDING_PRIOR_PROMPT_VERSION
    : UNDERSTANDING_PROMPT_VERSION;
  const generatedUnderstanding = await generateValidatedUnderstanding(
    gateway,
    understandingInput,
    rows,
    prior,
  );
  const draft = generatedUnderstanding.draft;
  const synthesisLatencyMs = generatedUnderstanding.meta.latencyMs;
  const synthesisInputFingerprint = inputFingerprint([
    PURPOSEFUL_EXPLORATION_POLICY.version,
    synthesisPromptVersion,
    UNDERSTANDING_VALIDATOR_VERSION,
    model.route,
    model.model,
    parsed.expected_version,
    generatedUnderstanding.meta.inputText,
  ]);

  const finalReading =
    decisionSource === "deterministic_gate"
      ? (draft.claims[0]?.text ?? plan.current_reading)
      : plan.current_reading;
  const finalUncertainty =
    decisionSource === "deterministic_gate"
      ? (draft.gaps[0]?.question ?? plan.key_uncertainty)
      : plan.key_uncertainty;
  const stopModelMeta = {
    ...plannerModelMeta,
    synthesis_prompt_version: synthesisPromptVersion,
    ...(usesPrior ? { prior_validator_version: PRIOR_VALIDATOR_VERSION } : {}),
    synthesis_model_route: model.route,
    synthesis_model_version: model.model,
    synthesis_validator_version: UNDERSTANDING_VALIDATOR_VERSION,
    synthesis_input_fingerprint: synthesisInputFingerprint,
    synthesis_attempts: generatedUnderstanding.meta.attempts,
    synthesis_validator_status: generatedUnderstanding.meta.validatorStatus,
    synthesis_validation_issues: generatedUnderstanding.meta.validationIssues,
    synthesis_latency_ms: synthesisLatencyMs,
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
      const existingOpen = await loadOpenQuestion(tx, exploration.id);
      await assertPriorContextIntact(
        tx,
        prior,
        "update",
        claims.map((claim) => ({ claimId: claim.claimId, revisionId: claim.revisionId })),
      );
      if (existingOpen) {
        throw new CoreError("QUESTION_NOT_OPEN", 409, "当前还有一个待回答的问题");
      }
      // The version check above guarantees this synthesis read every saved input.
      await markUnderstandingProcessed(tx, ctx, exploration.id);

      const priorEffects = await applyPriorUpdates(tx, {
        prior,
        updates: draft.prior_updates,
        rows,
        experienceId: exploration.experienceId,
      });
      const processing = {
        result: processingResult({ newClaims: draft.claims.length, effects: priorEffects }),
        new_claims: draft.claims.length,
        prior_effects: priorEffects,
        saved_input_turn_id: latestUserTurn?.id ?? null,
      };

      await tx.insert(coreSchema.explorationSteps).values({
        explorationId: exploration.id,
        sequence: stepSequence,
        basisVersion: parsed.expected_version,
        inputTurnId: latestUserTurn?.id,
        currentReading: finalReading,
        keyUncertainty: finalUncertainty,
        decision: "stop",
        intent: plan.intent,
        stopReason: plan.stop_reason,
        modelMeta: { ...stopModelMeta, processing },
      });

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
          ),
        );
      }
      await replaceGaps(tx, exploration.id, draft);

      const outcome = outcomeForUnderstanding(draft);
      const response = jsonObject({
        exploration_id: exploration.id,
        experience_id: exploration.experienceId,
        version: nextVersion,
        phase:
          outcome === "insufficient" && processing.result === "unknown" ? "insufficient" : "review",
        outcome,
        reading: {
          current_reading: finalReading,
          key_uncertainty: finalUncertainty,
          intent: plan.intent,
          stop_reason: plan.stop_reason,
        },
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
        gaps: draft.gaps,
        next_question: null,
        evidence: rows,
        question_budget: {
          asked: questionCount,
          default_budget: PURPOSEFUL_EXPLORATION_POLICY.defaultQuestionBudget,
          hard_cap: PURPOSEFUL_EXPLORATION_POLICY.hardQuestionCap,
          policy_version: PURPOSEFUL_EXPLORATION_POLICY.version,
        },
        timing: {
          planner_ms: plannerMeta.latencyMs,
          synthesis_ms: synthesisLatencyMs,
        },
        processing,
        prior_understanding: priorMeta,
      });
      if (operationId) await completeCoreOperation(tx, operationId, 201, response);
      return response;
    }),
  );
}
