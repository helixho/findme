import type {
  ExplorationPlan,
  UnderstandingDraft,
  UnderstandingWithPriorDraft,
} from "@findme/core";
import { validateExplorationPlan, validateUnderstandingPolicy } from "./epistemic-policy.js";
import type { EvidenceRow } from "./exploration-types.js";
import type { CoreGateway } from "./llm.js";
import {
  generateExplorationPlan,
  generateRevision,
  generateUnderstanding,
  generateUnderstandingWithPrior,
} from "./llm.js";
import {
  type PriorUnderstanding,
  hasPriorContext,
  validatePriorUpdates,
} from "./prior-understanding.js";

export function validateClaimEvidence(draft: UnderstandingDraft, rows: EvidenceRow[]) {
  const allowed = new Set(rows.map((row) => row.key));
  const claimKeys = draft.claims.map((claim) => claim.key);
  if (new Set(claimKeys).size !== claimKeys.length) {
    throw new Error("duplicate_claim_key");
  }
  for (const claim of draft.claims) {
    for (const evidence of claim.evidence) {
      if (!allowed.has(evidence.evidence_key)) {
        throw new Error(`invalid_evidence_key:${evidence.evidence_key}`);
      }
    }
    const preference = claim.interaction_preference;
    if (preference) {
      const use = claim.evidence.find((item) => item.evidence_key === preference.evidence_key);
      const row = rows.find((item) => item.key === preference.evidence_key);
      if (claim.kind !== "value" || claim.mode !== "self_report")
        throw new Error(`invalid_preference_classification:${claim.key}`);
      if (
        !use ||
        use.relation !== "supports" ||
        use.directness !== "direct" ||
        !row ||
        row.authorKind !== "subject" ||
        row.attributionStatus !== "confirmed_subject" ||
        row.eligibility !== "eligible" ||
        row.assessmentVersion === null ||
        !row.quote.includes(preference.original_text)
      )
        throw new Error(`invalid_preference_evidence:${claim.key}`);
    }
  }
}

export function validateRevisionCoverage(
  oldKeys: string[],
  revisedKeys: string[],
  withdrawnKeys: string[],
) {
  const old = new Set(oldKeys);
  const revised = new Set(revisedKeys);
  const withdrawn = new Set(withdrawnKeys);

  for (const key of [...revised, ...withdrawn]) {
    if (!old.has(key)) throw new Error(`revision_unknown_claim_key:${key}`);
  }
  for (const key of revised) {
    if (withdrawn.has(key)) throw new Error(`revision_conflicting_claim_key:${key}`);
  }
  for (const key of old) {
    if (!revised.has(key) && !withdrawn.has(key)) {
      throw new Error(`revision_omitted_claim_key:${key}`);
    }
  }
}

export async function generateValidatedExplorationPlan(
  gateway: CoreGateway,
  input: string,
  args: {
    previousQuestions: string[];
    questionCount: number;
    forceDeeper: boolean;
    fallbackReading?: string | null;
    fallbackUncertainty?: string | null;
  },
) {
  const startedAt = Date.now();
  let lastIssues: string[] = [];
  let lastInput = input;

  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix =
      attempt === 0
        ? ""
        : `\n\nRETRY_CONSTRAINT: 上一次候选被 deterministic validator 拒绝：${lastIssues.join(
            ", ",
          )}。不要重复已问问题；如果没有新的高价值 uncertainty，必须 stop。`;
    const attemptInput = input + suffix;
    lastInput = attemptInput;
    const plan = await generateExplorationPlan(gateway, attemptInput);
    const issues = validateExplorationPlan(plan, {
      previousQuestions: args.previousQuestions,
      questionCount: args.questionCount,
      forceDeeper: args.forceDeeper,
    });
    if (issues.length === 0) {
      return {
        plan,
        meta: {
          attempts: attempt + 1,
          latencyMs: Date.now() - startedAt,
          validatorStatus: "passed" as const,
          validationIssues: lastIssues,
          inputText: attemptInput,
        },
      };
    }
    lastIssues = issues;
  }

  const fallback: ExplorationPlan = {
    current_reading:
      args.fallbackReading?.trim() ||
      "目前没有形成一个不重复、且足以改变理解的新问题，先整理已经得到的材料。",
    key_uncertainty: args.fallbackUncertainty?.trim() || null,
    decision: "stop",
    question: null,
    intent: "新的候选问题没有通过当前认识形成策略的确定性校验，因此不继续增加追问。",
    quick_options: [],
    stop_reason: "没有找到一个通过当前策略校验的高价值新问题，先停止追问并整理已有材料。",
  };

  return {
    plan: fallback,
    meta: {
      attempts: 2,
      latencyMs: Date.now() - startedAt,
      validatorStatus: "fallback_stop" as const,
      validationIssues: lastIssues,
      inputText: lastInput,
    },
  };
}

export async function generateValidatedUnderstanding(
  gateway: CoreGateway,
  input: string,
  rows: EvidenceRow[],
  prior?: PriorUnderstanding,
): Promise<{
  draft: UnderstandingWithPriorDraft;
  meta: {
    attempts: number;
    latencyMs: number;
    validatorStatus: "passed";
    validationIssues: string[];
    inputText: string;
  };
}> {
  const withPrior = prior !== undefined && hasPriorContext(prior);
  let lastError: unknown;
  let lastIssues: string[] = [];
  const allowedEvidence = rows.map((row) => row.key).join(", ");
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix =
      attempt === 0
        ? ""
        : `\n\nRETRY_CONSTRAINT: 上一次候选被 deterministic validator 拒绝：${lastIssues.join(
            ", ",
          )}。evidence_key 只能从 [${allowedEvidence}] 中选择，必须严格满足 JSON 契约。`;
    const attemptInput = input + suffix;
    const draft: UnderstandingWithPriorDraft = withPrior
      ? await generateUnderstandingWithPrior(gateway, attemptInput)
      : { ...(await generateUnderstanding(gateway, attemptInput)), prior_updates: [] };
    try {
      validateClaimEvidence(draft, rows);
      if (withPrior) {
        const priorIssues = validatePriorUpdates(draft, prior, rows);
        if (priorIssues.length > 0)
          throw new Error(`prior_update_validation_failed:${priorIssues.join(",")}`);
      }
      const policyIssues = validateUnderstandingPolicy(draft);
      if (policyIssues.length > 0) {
        throw new Error(`understanding_policy_failed:${policyIssues.join(",")}`);
      }
      if (
        draft.claims.length === 0 &&
        draft.gaps.length === 0 &&
        !draft.prior_updates.some((update) => update.effect !== "unchanged")
      ) {
        throw new Error("understanding_empty");
      }
      return {
        draft,
        meta: {
          attempts: attempt + 1,
          latencyMs: Date.now() - startedAt,
          validatorStatus: "passed" as const,
          validationIssues: lastIssues,
          inputText: attemptInput,
        },
      };
    } catch (error) {
      lastError = error;
      lastIssues = [error instanceof Error ? error.message : "understanding_validation_failed"];
    }
  }
  throw lastError instanceof Error ? lastError : new Error("understanding_validation_failed");
}

export async function generateValidatedRevision(
  gateway: CoreGateway,
  input: string,
  rows: EvidenceRow[],
  oldKeys: string[],
) {
  let lastError: unknown;
  let lastIssues: string[] = [];
  const startedAt = Date.now();
  const allowedEvidence = rows.map((row) => row.key).join(", ");
  const allowedClaims = oldKeys.join(", ");
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix =
      attempt === 0
        ? ""
        : `\n\nRETRY_CONSTRAINT: 上一次候选被 deterministic validator 拒绝：${lastIssues.join(
            ", ",
          )}。claims[].key 与 withdrawn_claim_keys 只能使用 [${allowedClaims}]；每个旧 key 必须被修订或撤回；evidence_key 只能使用 [${allowedEvidence}]。`;
    const attemptInput = input + suffix;
    const draft = await generateRevision(gateway, attemptInput);
    try {
      validateClaimEvidence(draft, rows);
      const policyIssues = validateUnderstandingPolicy(draft);
      if (policyIssues.length > 0) {
        throw new Error(`revision_policy_failed:${policyIssues.join(",")}`);
      }
      validateRevisionCoverage(
        oldKeys,
        draft.claims.map((claim) => claim.key),
        draft.withdrawn_claim_keys ?? [],
      );
      return {
        draft,
        meta: {
          attempts: attempt + 1,
          latencyMs: Date.now() - startedAt,
          validatorStatus: "passed" as const,
          validationIssues: lastIssues,
          inputText: attemptInput,
        },
      };
    } catch (error) {
      lastError = error;
      lastIssues = [error instanceof Error ? error.message : "revision_validation_failed"];
    }
  }
  throw lastError instanceof Error ? lastError : new Error("revision_validation_failed");
}
