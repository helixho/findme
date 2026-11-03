import { UseRepair, UseRepairs } from "@findme/core";
import { z } from "zod";
import { fail } from "./io.js";
import type { RepairRequest } from "./prepare.js";

// Transport compression never changes source identity, quote validation or permitted use.
const Proposition = UseRepair.shape.propositions.element
  .omit({ evidence_id: true, source_id: true, start: true, end: true, reason: true })
  .extend({ anchor_index: z.number().int().nonnegative(), quote: z.string().min(1).nullable() });
const Decision = z
  .object({
    decision: UseRepair.shape.decision,
    reason: z.string().min(1).max(600),
    propositions: z.array(Proposition).max(3),
  })
  .strict();
export function compactRepairSchema(requests: RepairRequest[]) {
  return z
    .object({
      assignments: z
        .object(Object.fromEntries(requests.map((_, i) => [`r${i}`, Decision])))
        .strict(),
    })
    .strict();
}
export function decodeRepairs(
  value: z.infer<ReturnType<typeof compactRepairSchema>>,
  requests: RepairRequest[],
) {
  return UseRepairs.parse({
    repairs: requests.map((request, index) => {
      const decision = value.assignments[`r${index}`];
      if (!decision) fail("COMPACT_REPAIR_MISSING_REQUEST");
      return {
        request_id: request.id,
        decision: decision.decision,
        reason: decision.reason,
        propositions: decision.propositions.map((p) => {
          const anchor = request.rows[p.anchor_index];
          if (!anchor) fail("COMPACT_REPAIR_UNKNOWN_ANCHOR");
          const { anchor_index: _, quote, ...fields } = p;
          return {
            ...fields,
            evidence_id: anchor.id,
            source_id: anchor.source_id,
            quote: quote ?? anchor.quote,
            start: null,
            end: null,
            reason: decision.reason,
          };
        }),
      };
    }),
  });
}
