import { randomUUID } from "node:crypto";
import {
  CoreReportSourceBinding,
  type CoreReportTarget,
  type UnderstandingAppView,
  type UnderstandingExactEvidence,
  UnderstandingFeedbackInput,
  type UnderstandingFeedbackReceipt,
  UnderstandingOverallRequest,
  UnderstandingRecoveryRequest,
  type UnderstandingReportHistory,
  UnderstandingSourceAction,
  UnderstandingSourceRebind,
  type UnderstandingVersionView,
} from "@findme/core";
import { BatchStore } from "../dogfood/store.js";
import type { createCodexGateway } from "../llm/codex-cli.js";
import { digest, fail } from "../shared/primitives.js";
import { type PrivateUnderstandingPaths, readBaseline } from "./read.js";
import { type FeedbackState, prepareState, readState, writeState } from "./state.js";

import { validateReportTarget } from "../core/report-bridge.js";
import { qualificationStatus } from "./qualification.js";

import {
  attachInvalidity,
  blockedVersions,
  checkLifecycleIntegrity,
  invalidRoots,
  redactReceipt,
} from "./lifecycle.js";

import { saveFeedback } from "./feedback-intake.js";
import { processJob } from "./job-processing.js";
import {
  type RepositoryAccess,
  accepted,
  evidences,
  history,
  read,
  version as readVersion,
  required,
  validateCoreTarget,
} from "./repository-helpers.js";
type Gateway = Pick<ReturnType<typeof createCodexGateway>, "extract">;
export type UnderstandingRepositoryOptions = PrivateUnderstandingPaths & {
  gateway?: Gateway;
  feedbackMaxCalls?: number;
  providerTimeoutMs?: number;
  /** Node private adapter must have exactly one configured Core owner and a live verifier. */
  coreBridge?: {
    owner: { tenantId: string; subjectId: string };
    verifySource: (binding: CoreReportSourceBinding, note: string) => Promise<void>;
  };
};
export class PrivateUnderstandingRepository {
  private access(): RepositoryAccess {
    return {
      options: this.options,
      locked: (fn) => this.locked(fn),
      verifiedState: () => this.verifiedState(),
      readFrontier: (state) => this.readFrontier(state),
    };
  }
  constructor(readonly options: UnderstandingRepositoryOptions) {
    const n = options.feedbackMaxCalls ?? 0;
    const timeout = options.providerTimeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 180000)
      fail("PROVIDER_TIMEOUT_INVALID");
    if (!Number.isSafeInteger(n) || n < 0 || n > 100) fail("FEEDBACK_BUDGET_INVALID");
  }
  private async locked<T>(fn: () => Promise<T>) {
    await prepareState(this.options);
    return new BatchStore(this.options.stateDir).locked(fn);
  }
  private async verifiedState(): Promise<FeedbackState> {
    const state = await readState(this.options);
    const invalid = new Map<string, string>();
    if (state.lifecycle.length && !this.options.coreBridge) fail("CORE_SOURCE_LIFECYCLE_REQUIRED");
    if (this.options.coreBridge) checkLifecycleIntegrity(state, this.options.coreBridge.owner);
    for (const { receipt } of state.entries) {
      if (!receipt.core_source) continue;
      const configured = this.options.coreBridge;
      if (!configured) fail("CORE_SOURCE_LIFECYCLE_REQUIRED");
      const binding = receipt.core_source;
      const rebound = state.lifecycle.some(
        (a) =>
          state.entries.find((e) => e.receipt.id === a.replacement_id)?.receipt.source_id ===
          receipt.source_id,
      );
      if (
        binding.tenant_id !== configured.owner.tenantId ||
        binding.subject_id !== configured.owner.subjectId ||
        (receipt.source_id !== binding.source_id && !rebound)
      )
        fail("REPORT_OWNER_MISMATCH");
      if (state.lifecycle.some((a) => a.source_id === receipt.source_id)) continue;
      try {
        await configured.verifySource(binding, receipt.input.note);
      } catch (e) {
        const error = e as { code?: string; message?: string; details?: { source_state?: string } };
        const code =
          error.code === "REPORT_SOURCE_INELIGIBLE"
            ? error.details?.source_state
            : (error.code ?? error.message);
        if (
          ![
            "STALE_REPORT_SOURCE",
            "REPORT_SOURCE_EXCLUDED",
            "REPORT_SOURCE_DELETED",
            "REPORT_SOURCE_REPLACED",
          ].includes(code ?? "")
        )
          throw e;
        invalid.set(receipt.source_id, required(code));
      }
    }
    attachInvalidity(state, invalid);
    return state;
  }
  private async readFrontier(state: FeedbackState) {
    const current = await this.verifiedState();
    if (
      state.lifecycle.length !== current.lifecycle.length ||
      digest([...invalidRoots(state)].sort()) !== digest([...invalidRoots(current)].sort())
    )
      fail("REVISION_SOURCE_RACE");
  }
  async read(): Promise<UnderstandingAppView> {
    return read(this.access());
  }
  async history(domain: string, limit = 30): Promise<UnderstandingReportHistory> {
    return history(this.access(), domain, limit);
  }
  async version(domain: string, version: string): Promise<UnderstandingVersionView> {
    return readVersion(this.access(), domain, version);
  }
  async retireSource(raw: unknown): Promise<UnderstandingAppView> {
    await this.sourceAction(UnderstandingSourceAction.parse(raw));
    return this.read();
  }
  /** Trusted server-fetched replacement only; public routes never pass client content here. */
  async rebindSource(
    raw: unknown,
    rawBinding: CoreReportSourceBinding,
    note: string,
  ): Promise<UnderstandingAppView> {
    const input = UnderstandingSourceRebind.parse(raw);
    const binding = CoreReportSourceBinding.parse(rawBinding);
    if (
      binding.exploration_id !== input.exploration_id ||
      binding.source_id !== input.new_source_id
    )
      fail("SOURCE_REBIND_INTEGRITY");
    await this.sourceAction(input, { binding, note, target: input.target });
    return this.read();
  }
  private async sourceAction(
    input: UnderstandingSourceAction,
    replacement?: { binding: CoreReportSourceBinding; note: string; target: CoreReportTarget },
  ) {
    const configured = this.options.coreBridge;
    if (!configured) fail("CORE_SOURCE_LIFECYCLE_REQUIRED");
    return this.locked(async () => {
      const state = await this.verifiedState();
      const requestHash = digest([input, replacement ?? null]);
      const prior = state.lifecycle.find((a) => a.key === input.idempotency_key);
      if (prior) {
        if (prior.request_hash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
        return;
      }
      if (input.expected_lifecycle_revision !== state.lifecycle.length)
        fail("SOURCE_LIFECYCLE_CONFLICT");
      const receipts = state.entries
        .filter((e) => e.receipt.source_id === input.source_id)
        .map((e) => e.receipt);
      if (!receipts.length || receipts.some((f) => !f.core_source)) fail("REPORT_SOURCE_NOT_FOUND");
      if (!replacement && state.lifecycle.some((a) => a.source_id === input.source_id))
        fail("SOURCE_ALREADY_RETIRED");
      let replacementId: string | null = null;
      if (replacement) {
        const { binding, note, target } = replacement;
        if (
          binding.tenant_id !== configured.owner.tenantId ||
          binding.subject_id !== configured.owner.subjectId
        )
          fail("REPORT_OWNER_MISMATCH");
        if (!note.trim() || note.length > 2400) fail("FEEDBACK_INPUT_BOUND_EXCEEDED");
        await configured.verifySource(binding, note);
        const snapshot = await readBaseline(this.options);
        const report = accepted(snapshot, state).get(target.domain);
        const blocked = blockedVersions(state).has(report?.version ?? "");
        validateReportTarget(
          {
            baseline_version: snapshot.version,
            input_hash: snapshot.input.input_hash,
            overall: { version: report?.version ?? "", report: report?.report ?? null },
            topics: [
              {
                domain: target.domain,
                version: report?.version ?? "",
                report: report?.report ?? null,
              },
            ],
          },
          target,
        );
        if (blocked && (target.finding_key || target.question)) fail("REPORT_SOURCE_BLOCKED");
        replacementId = randomUUID();
        const shared = state.entries.find(
          (e) =>
            e.receipt.source_id !== input.source_id &&
            digest(e.receipt.core_source ?? null) === digest(binding) &&
            !invalidRoots(state).has(e.receipt.source_id),
        );
        const root =
          shared?.receipt.source_id ??
          `core-rebind:${digest([binding, input.source_id, state.lifecycle.length + 1])}`;
        if (state.lifecycle.some((a) => a.source_id === root))
          fail("SOURCE_RETIRED_REBIND_REQUIRED");
        const body: UnderstandingFeedbackInput = {
          baseline_version: target.baseline_version,
          input_hash: target.input_hash,
          domain: target.domain,
          report_version: target.report_version,
          type: "supplement",
          note,
          ...(target.finding_key ? { finding_key: target.finding_key } : {}),
          ...(target.question ? { context: { question: target.question } } : {}),
        };
        state.entries.push({
          key: `source-rebind:${replacementId}`,
          body_hash: digest(body),
          receipt: {
            id: replacementId,
            source_id: root,
            revision: ++state.revision,
            saved_at: new Date().toISOString(),
            input: body,
            status: "pending_analysis",
            result_version: null,
            error: null,
            core_source: binding,
            replaces_source_id: input.source_id,
          },
          target_context: {
            question: blocked ? null : (target.question ?? report?.report.question?.text ?? null),
            target_text: null,
          },
        });
        await snapshot.input.fresh();
        await configured.verifySource(binding, note);
      }
      state.lifecycle.push({
        revision: state.lifecycle.length + 1,
        kind: replacement ? "rebind" : "retire",
        source_id: input.source_id,
        actor: configured.owner,
        binding_fingerprints: [...new Set(receipts.map((f) => digest(f.core_source)))].sort(),
        source_fingerprints: [...new Set(receipts.map((f) => digest(f.input.note)))].sort(),
        expected_lifecycle_revision: input.expected_lifecycle_revision,
        reason: input.reason,
        key: input.idempotency_key,
        request_hash: requestHash,
        saved_at: new Date().toISOString(),
        replacement_id: replacementId,
        replacement_binding_fingerprint: replacement ? digest(replacement.binding) : null,
        replacement_source_fingerprint: replacement ? digest(replacement.note) : null,
      });
      await writeState(this.options, state);
    });
  }
  async recoverTopic(
    domain: string,
    version: string,
    recovery: unknown = {},
  ): Promise<UnderstandingAppView> {
    if (domain === "overall") fail("TOPIC_RECOVERY_REQUIRED");
    await this.processJob(
      { topic: { domain, version } },
      UnderstandingRecoveryRequest.parse(recovery),
    );
    return this.read();
  }
  async validateCoreTarget(raw: CoreReportTarget): Promise<CoreReportTarget> {
    return validateCoreTarget(this.access(), raw);
  }
  async evidence(domain: string, version: string, id: string): Promise<UnderstandingExactEvidence> {
    return required((await this.evidences(domain, version, [id]))[0]);
  }
  async evidences(
    domain: string,
    version: string,
    requestedIds: string[],
  ): Promise<UnderstandingExactEvidence[]> {
    return evidences(this.access(), domain, version, requestedIds);
  }
  async save(raw: unknown, key: string): Promise<UnderstandingFeedbackReceipt> {
    return saveFeedback(this.access(), raw, key);
  }
  async saveCore(
    raw: unknown,
    key: string,
    rawBinding: CoreReportSourceBinding,
  ): Promise<UnderstandingFeedbackReceipt> {
    const binding = CoreReportSourceBinding.parse(rawBinding);
    const configured = this.options.coreBridge;
    if (!configured) fail("CORE_SOURCE_LIFECYCLE_REQUIRED");
    if (
      binding.tenant_id !== configured.owner.tenantId ||
      binding.subject_id !== configured.owner.subjectId
    )
      fail("REPORT_OWNER_MISMATCH");
    await configured.verifySource(binding, UnderstandingFeedbackInput.parse(raw).note);
    return saveFeedback(this.access(), raw, key, binding);
  }
  async processOverall(raw: unknown, recovery: unknown = {}): Promise<UnderstandingAppView> {
    const request = UnderstandingOverallRequest.parse(raw);
    await this.processJob({ overall: request }, UnderstandingRecoveryRequest.parse(recovery));
    return this.read();
  }
  async process(id: string, recovery: unknown = {}): Promise<UnderstandingFeedbackReceipt> {
    const s = await this.verifiedState();
    const existing = s.entries.find((e) => e.receipt.id === id)?.receipt;
    if (existing && invalidRoots(s).has(existing.source_id)) fail("REPORT_SOURCE_BLOCKED");
    if (existing?.status === "accepted") {
      await this.read();
      return { ...redactReceipt(s, existing), qualification: qualificationStatus(s, existing) };
    }
    await this.processJob({ id }, UnderstandingRecoveryRequest.parse(recovery));
    const next = await this.verifiedState();
    const receipt = required(next.entries.find((e) => e.receipt.id === id)).receipt;
    return {
      ...redactReceipt(next, receipt),
      qualification: invalidRoots(next).has(receipt.source_id)
        ? "pending"
        : qualificationStatus(next, receipt),
    };
  }
  /** Bounded qualification/audit checkpoint, then report/audit in the cumulative U3 budget. */
  private async processJob(
    targetRequest: Parameters<typeof processJob>[1],
    recovery: UnderstandingRecoveryRequest,
  ) {
    return processJob(this.access(), targetRequest, recovery);
  }
}
