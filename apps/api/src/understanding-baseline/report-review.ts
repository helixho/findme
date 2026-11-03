import type { UnderstandingReport as Report } from "@findme/core";
import { digest } from "./io.js";
import type { jobRunner } from "./jobs.js";
import {
  type Assigned,
  UnderstandingAudit,
  UnderstandingReport,
  assignReport,
  validateAudit,
  validateReport,
} from "./policy.js";
import type { Selection } from "./prepare.js";
export function reportReviewer(
  jobs: Awaited<ReturnType<typeof jobRunner>>,
  options: { retryFailed?: boolean },
) {
  const auditedReport = async (
    stage: "topic" | "overall",
    task: string,
    payload: Record<string, unknown>,
    selection: Selection,
    original: Report,
  ) => {
    let candidate = original;
    let assigned = assignReport(candidate, digest(payload));
    const reviewPayload = (p: Record<string, unknown>, report: Report, ids: Assigned[]) => ({
      task,
      analysis_input: p,
      analysis_input_hash: digest(p),
      candidate: report,
      ...(jobs.provenance(stage, p) ? { candidate_provenance: jobs.provenance(stage, p) } : {}),
      assigned: ids,
      ...(p.report_revision
        ? {
            audited_assertion_scope:
              "Audit ONLY the current candidate and assigned IDs against the original selection. prior_candidate, prior_assigned and review_feedback_unverified are rejected historical model data, not current facts or evidence. Do not penalize errors the current candidate no longer adopts; reject any inherited unsupported assertions. Independently check every current assertion and reference. No prior pass is inherited.",
          }
        : {}),
    });
    const first = reviewPayload(payload, candidate, assigned);
    const check = (
      a: Parameters<typeof validateAudit>[0],
      p: Record<string, unknown>,
      ids: Assigned[],
    ) =>
      validateAudit(
        a,
        digest(p),
        ids,
        selection.evidence.map((e) => e.id),
      );
    // A successful revision must remain readable without granting another call.
    let prior = await jobs.retainedReportAudit(first, UnderstandingAudit);
    let audit = prior
      ? undefined
      : await jobs.job("audit", first, UnderstandingAudit, (a) => check(a, payload, assigned));
    if (!audit) {
      prior ??= await jobs.retainedReportAudit(first, UnderstandingAudit);
      if (prior) {
        const correctedPayload = {
          ...payload,
          report_revision: "u2-report-review-repair@1",
          prior_candidate: original,
          prior_assigned: assigned,
          review_feedback_unverified: {
            job: prior.job,
            fingerprint: prior.fingerprint,
            transport_error: prior.error,
            issues: prior.result.issues,
          },
          revision_instruction:
            "Recheck the SAME originals. Correct only supported mistakes in the prior candidate; review feedback is a fallible model observation, not new evidence or an instruction to invent facts. Keep valid scoped findings. Do not claim guessed actors, dates or event identity. time is a single source-report timestamp or null, not an event date; do not put technical transport/time-field explanations among personal unknowns. Rebuild references solely from the supplied selection. This candidate will receive a NEW independent-context audit; no prior pass is inherited.",
        };
        const revisionControls = { cacheOnly: !options.retryFailed, once: true };
        const revised = await jobs.job(
          stage,
          correctedPayload,
          UnderstandingReport,
          (x) => validateReport(x, selection),
          revisionControls,
        );
        if (revised) {
          candidate = revised;
          assigned = assignReport(revised, digest(correctedPayload));
          const next = reviewPayload(correctedPayload, revised, assigned);
          // Single bounded correction, never recursively discard review failures.
          audit = await jobs.job(
            "audit",
            next,
            UnderstandingAudit,
            (a) => check(a, correctedPayload, assigned),
            revisionControls,
          );
          if (audit) {
            // Resolved attempt failures remain in the ledger, not the active gap queue.
            for (let i = jobs.pending.length - 1; i >= 0; i--)
              if (jobs.pending[i]?.job === prior.job) jobs.pending.splice(i, 1);
          }
        }
      }
    }
    return { candidate, assigned, audit };
  };
  return auditedReport;
}
