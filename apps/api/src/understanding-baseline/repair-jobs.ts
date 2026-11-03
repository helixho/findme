import type { UseRepairs as Repairs } from "@findme/core";
import type { Inputs } from "./input.js";
import { digest } from "./io.js";
import type { jobRunner } from "./jobs.js";
import { parallelMap } from "./parallel-map.js";
import { type Assigned, UnderstandingAudit, validateAudit } from "./policy.js";
import { type Overlay, type RepairRequest, resolveRepairs } from "./prepare.js";
import { LIMITS } from "./render.js";
import { abstainRejectedRepair, normalizeRepairCandidates } from "./repair-normalize.js";
import { compactRepairSchema, decodeRepairs } from "./repair-transport.js";
function compactRequest(r: RepairRequest) {
  return {
    id: r.id,
    kind: r.kind,
    canonical_id: r.canonical_id,
    windows: r.windows,
    rows: r.rows.map((e) => ({
      id: e.id,
      source_id: e.source_id,
      start: e.start,
      end: e.end,
      quote: e.quote,
      content_author: e.content_author,
      about: e.about,
      kind: e.kind,
      stance: e.stance,
      use: e.use,
      classification_conflict: e.classification_conflict,
    })),
    opinion: r.opinion,
  };
}

export function groupRepairRequests(requests: RepairRequest[]) {
  const groups: RepairRequest[][] = [];
  const oversized: RepairRequest[] = [];
  let group: RepairRequest[] = [];
  for (const r of requests.filter((r) => !r.unavailable)) {
    if (Buffer.byteLength(JSON.stringify(compactRequest(r))) > 28000) {
      oversized.push(r);
      continue;
    }
    if (
      group.length >= 16 ||
      Buffer.byteLength(JSON.stringify([...group, r].map(compactRequest))) > 28000
    ) {
      groups.push(group);
      group = [];
    }
    group.push(r);
  }
  if (group.length) groups.push(group);
  return { groups, oversized };
}

export async function runRepairJobs(
  input: Inputs,
  requests: RepairRequest[],
  jobs: Awaited<ReturnType<typeof jobRunner>>,
) {
  const { groups, oversized } = groupRepairRequests(requests);
  const rejectedRepairProposals: ReturnType<typeof normalizeRepairCandidates>["rejected"] = [];
  const repairResults: {
    requests: string[];
    candidate: Repairs | null;
    audit: unknown;
    overlays: Overlay[];
  }[] = [];
  await parallelMap(groups, async (batch, batchIndex) => {
    const repairPayload = {
      task: "u2_scoped_use_and_variant_mapping",
      protocol: "u2-compact-repairs@1",
      requests: batch.map((r, i) => ({ key: `r${i}`, ...compactRequest(r) })),
      semantic_scope: LIMITS,
    };
    const schema = compactRepairSchema(batch);
    const retained = await jobs.retainedRepair(repairPayload, schema);
    const transport =
      retained ??
      (await jobs.job("repair", repairPayload, schema, (raw) => {
        normalizeRepairCandidates(input, batch, decodeRepairs(raw, batch));
      }));
    const normalized = transport
      ? normalizeRepairCandidates(input, batch, decodeRepairs(transport, batch))
      : undefined;
    let result = normalized?.candidate;
    if (normalized) rejectedRepairProposals.push(...normalized.rejected);
    let audit: unknown = null;
    let applied: Overlay[] = [];
    if (result) {
      const auditCandidate = (
        candidate: Repairs,
        rejected = normalized?.rejected ?? [],
        rejectedAudit?: unknown,
      ) => {
        const proposed = resolveRepairs(input, batch, candidate);
        const assigned: Assigned[] = candidate.repairs.flatMap((r, i) => [
          {
            id: `repair-${i + 1}-${digest(repairPayload).slice(0, 16)}`,
            key: r.request_id,
            category: "repair_decision",
          },
          ...proposed
            .filter((o) => o.request_id === r.request_id)
            .map((o) => ({ id: o.id, key: o.id, category: "proposition" })),
        ]);
        const ids = [
          ...new Set([
            ...batch.flatMap((r) => r.rows.map((e) => e.id)),
            ...proposed.map((o) => o.id),
          ]),
        ];
        const payload = {
          task: "u2_repair_audit",
          analysis_input: repairPayload,
          analysis_input_hash: digest(repairPayload),
          candidate,
          ...(rejected.length
            ? {
                rejected_proposals: rejected,
                qualification_note:
                  "Rejected proposals remain rejected, not repaired. Candidate unknown retains original use; audit should verify the remaining claims and whether this is a faithful abstention, not demand fabricated attribution.",
                audited_assertion_scope:
                  "Only candidate decisions, resolved_propositions and assigned objects are proposed for acceptance. analysis_input.requests[].opinion and rejected_proposals are explicitly untrusted historical/model suggestions, NOT accepted assertions. Do not treat an unsupported opinion from earlier processing as a current claim unless the candidate actually adopts it. Check any adoption and every actual proposition strictly against originals. Unknown/no_change never certifies old opinions or event identity. Reference only current assigned IDs; retired rejected IDs remain rejected, not current findings.",
              }
            : {}),
          ...(rejectedAudit
            ? {
                correction: "u2-audit-abstention@1",
                prior_rejection_issues: (rejectedAudit as { issues?: unknown[] }).issues ?? [],
                rejected_audit_hash: digest(rejectedAudit),
                previous_audit_status: "rejected_reference_only_not_current_assertions",
              }
            : {}),
          resolved_propositions: proposed,
          assigned,
        };
        const validate = (a: Parameters<typeof validateAudit>[0]) =>
          validateAudit(a, digest(repairPayload), assigned, ids);
        return { payload, proposed, assigned, validate };
      };
      const first = auditCandidate(result);
      let rejectedAudit = await jobs.retainedAudit(
        first.payload,
        UnderstandingAudit,
        first.validate,
      );
      if (!rejectedAudit) {
        audit = await jobs.job("audit", first.payload, UnderstandingAudit, first.validate);
        if (!audit)
          rejectedAudit = await jobs.retainedAudit(
            first.payload,
            UnderstandingAudit,
            first.validate,
          );
      }
      if (audit) applied = first.proposed;
      if (rejectedAudit) {
        const correction = abstainRejectedRepair(
          input,
          batch,
          result,
          rejectedAudit,
          digest(repairPayload),
          first.assigned,
          first.proposed,
        );
        if (correction) {
          result = correction.candidate;
          rejectedRepairProposals.push(...correction.rejected);
          const next = auditCandidate(
            result,
            [...(normalized?.rejected ?? []), ...correction.rejected],
            rejectedAudit,
          );
          // Exactly one changed-candidate audit; a second rejection is never auto-corrected.
          audit = await jobs.job("audit", next.payload, UnderstandingAudit, next.validate);
          if (audit) applied = next.proposed;
        }
      }
    }
    repairResults[batchIndex] = {
      requests: batch.map((r) => r.id),
      candidate: result ?? null,
      audit,
      overlays: applied,
    };
  });
  const repairs: Repairs = {
    repairs: repairResults.flatMap((r) => r.candidate?.repairs ?? []),
  };
  const overlays = repairResults.flatMap((r) => r.overlays);
  const repairAudit = repairResults.map((r) => ({ request_ids: r.requests, audit: r.audit }));
  const acceptedRepairIds = new Set(
    repairResults.filter((r) => r.audit).flatMap((r) => r.requests),
  );
  const unavailableRepairs = requests
    .filter((r) => !acceptedRepairIds.has(r.id))
    .map((r) => ({
      request_id: r.id,
      canonical_id: r.canonical_id,
      row_ids: r.rows.map((e) => e.id),
      reason:
        r.unavailable ??
        (oversized.includes(r)
          ? "repair_input_budget_unanalysed"
          : "repair_audit_unavailable_original_use_retained"),
    }));
  const repairsReady = unavailableRepairs.length === 0;
  return {
    rejectedRepairProposals,
    repairResults,
    repairs,
    overlays,
    repairAudit,
    unavailableRepairs,
    repairsReady,
  };
}
