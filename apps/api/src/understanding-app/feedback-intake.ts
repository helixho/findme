import { randomUUID } from "node:crypto";
import {
  type CoreReportSourceBinding,
  UnderstandingFeedbackInput,
  type UnderstandingFeedbackReceipt,
} from "@findme/core";
import { reportObjects } from "../domain/understanding/policy.js";
import { digest, fail } from "../shared/primitives.js";
import { readBaseline } from "./read.js";
import { writeState } from "./state.js";

import { blockedVersions, invalidRoots, redactReceipt } from "./lifecycle.js";

import type { RepositoryAccess } from "./repository-helpers.js";
import { accepted, required } from "./repository-helpers.js";
export async function saveFeedback(
  deps: RepositoryAccess,
  raw: unknown,
  key: string,
  binding?: CoreReportSourceBinding,
): Promise<UnderstandingFeedbackReceipt> {
  const body = UnderstandingFeedbackInput.parse(raw);
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) fail("IDEMPOTENCY_KEY_REQUIRED");
  return deps.locked(async () => {
    const snapshot = await readBaseline(deps.options);
    const s = await deps.verifiedState();
    const prior = s.entries.find((e) => e.key === key);
    if (prior) {
      if (
        prior.body_hash !== digest(body) ||
        digest(prior.receipt.core_source ?? null) !== digest(binding ?? null)
      )
        fail("IDEMPOTENCY_CONFLICT");
      return redactReceipt(s, prior.receipt);
    }
    const shared = binding
      ? s.entries.find(
          (e) =>
            digest(e.receipt.core_source ?? null) === digest(binding) &&
            !invalidRoots(s).has(e.receipt.source_id),
        )?.receipt.source_id
      : undefined;
    if (binding && !shared && s.lifecycle.some((a) => a.source_id === binding.source_id))
      fail("SOURCE_RETIRED_REBIND_REQUIRED");
    const report = accepted(snapshot, s).get(body.domain);
    if (blockedVersions(s).has(report?.version ?? "")) fail("REPORT_SOURCE_BLOCKED");
    if (
      body.baseline_version !== snapshot.version ||
      body.input_hash !== snapshot.input.input_hash ||
      !report ||
      report.version !== body.report_version
    )
      fail("STALE_REPORT_VERSION");
    if (body.finding_key && !reportObjects(report.report).some((o) => o.key === body.finding_key))
      fail("FINDING_NOT_FOUND");
    if (body.context) {
      const question = body.finding_key
        ? reportObjects(report.report).find((o) => o.key === body.finding_key && "text" in o)
        : report.report.question?.text;
      const text =
        typeof question === "object" && question && "text" in question ? question.text : question;
      if (text !== body.context.question) fail("STALE_EXPLORATION_CONTEXT");
    }
    const id = randomUUID();
    const receipt: UnderstandingFeedbackReceipt = {
      id,
      source_id: shared ?? binding?.source_id ?? `u3-feedback:${id}`,
      ...(binding ? { core_source: binding } : {}),
      revision: ++s.revision,
      saved_at: new Date().toISOString(),
      input: body,
      status: body.type === "helpful" ? "saved" : "pending_analysis",
      result_version: null,
      error: null,
    };
    const targetObject = body.finding_key
      ? reportObjects(report.report).find((o) => o.key === body.finding_key)
      : undefined;
    s.entries.push({
      key,
      body_hash: digest(body),
      receipt,
      target_context: {
        question: body.context?.question ?? report.report.question?.text ?? null,
        target_text: targetObject && "text" in targetObject ? targetObject.text : null,
      },
    });
    // Durable original note before any analysis. No model from this method.
    await snapshot.input.fresh();
    if (binding) await required(deps.options.coreBridge).verifySource(binding, body.note);
    await writeState(deps.options, s);
    return receipt;
  });
}
