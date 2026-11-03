import { type UnderstandingAudit, UseRepairs } from "@findme/core";
import type { Inputs } from "./input.js";
import { type Assigned, validateAudit } from "./policy.js";
import { type Overlay, type RepairRequest, resolveRepairs } from "./prepare.js";

const SAFE_DOWNGRADES = new Set([
  "REPAIR_AUTHOR_OR_USE_ESCALATION",
  "PROJECT_REPORT_PURPOSE_REQUIRED",
  "COMMAND_IS_NOT_PREFERENCE",
  "STANCE_ESCALATION",
  "CANONICAL_STANCE_CONFLICT",
  "DISPUTED_AUTHOR_NOT_PROMOTABLE",
  "REPAIR_EXACT_SPAN_INVALID",
  "REPAIR_ANCHOR_INVALID",
]);
/** Reject an unusable proposal, not the entire batch. Unknown never grants a new use. */
export function normalizeRepairCandidates(
  input: Inputs,
  requests: RepairRequest[],
  value: UseRepairs,
) {
  const rows = UseRepairs.parse(value);
  if (
    rows.repairs.length !== requests.length ||
    new Set(rows.repairs.map((r) => r.request_id)).size !== requests.length
  )
    throw new Error("INCOMPLETE_REPAIR_DECISIONS");
  const rejected: {
    request_id: string;
    reason: string;
    original: UseRepairs["repairs"][number];
  }[] = [];
  const normalized = rows.repairs.map((row) => {
    const request = requests.find((r) => r.id === row.request_id);
    if (!request) throw new Error("UNKNOWN_REPAIR_REQUEST");
    try {
      resolveRepairs(input, [request], { repairs: [row] });
      return row;
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNKNOWN";
      if (!SAFE_DOWNGRADES.has(code)) throw error;
      rejected.push({ request_id: row.request_id, reason: code, original: row });
      return {
        request_id: row.request_id,
        decision: "unknown" as const,
        propositions: [],
        reason: `用途恢复未通过来源/命题校验（${code}）；保留原用途，不能作为新增个人证据。`,
      };
    }
  });
  return { candidate: UseRepairs.parse({ repairs: normalized }), rejected };
}

/** One bounded abstention by assigned identity; global issues never qualify. */
export function abstainRejectedRepair(
  input: Inputs,
  requests: RepairRequest[],
  candidate: UseRepairs,
  audit: UnderstandingAudit,
  inputHash: string,
  assigned: Assigned[],
  proposed: Overlay[],
) {
  try {
    validateAudit(audit, inputHash, assigned, [
      ...requests.flatMap((r) => r.rows.map((e) => e.id)),
      ...proposed.map((p) => p.id),
    ]);
    throw new Error("ABSTENTION_REQUIRES_REJECTED_AUDIT");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SEMANTIC_AUDIT_REJECTED") throw error;
  }
  const affected = new Set<string>();
  for (const issue of audit.issues) {
    if (!issue.target_id) return undefined;
    const target = assigned.find((a) => a.id === issue.target_id);
    const requestId =
      target?.category === "repair_decision"
        ? target.key
        : target?.category === "proposition"
          ? proposed.find((p) => p.id === target.key)?.request_id
          : undefined;
    if (!requestId || !requests.some((r) => r.id === requestId))
      throw new Error("UNKNOWN_AUDIT_REFERENCE");
    // Only withdraw actual new proposals; do not hide an issue about existing/global uses.
    if (candidate.repairs.find((r) => r.request_id === requestId)?.decision !== "propositions")
      return undefined;
    affected.add(requestId);
  }
  const rejected = candidate.repairs
    .filter((r) => affected.has(r.request_id))
    .map((original) => ({
      request_id: original.request_id,
      original,
      reason: "SEMANTIC_AUDIT_REJECTED",
      issues: audit.issues.filter((issue) => {
        const target = assigned.find((a) => a.id === issue.target_id);
        return (
          target?.key === original.request_id ||
          proposed.some((p) => p.id === target?.key && p.request_id === original.request_id)
        );
      }),
    }));
  const changed = UseRepairs.parse({
    repairs: candidate.repairs.map((r) =>
      affected.has(r.request_id)
        ? {
            request_id: r.request_id,
            decision: "unknown",
            propositions: [],
            reason: "语义复核拒绝该新增命题；保留原用途与未知归属，等待独立复核。",
          }
        : r,
    ),
  });
  resolveRepairs(input, requests, changed);
  return { candidate: changed, rejected };
}
