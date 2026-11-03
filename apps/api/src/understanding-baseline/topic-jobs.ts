import type { UnderstandingReport as Report } from "@findme/core";
import { digest } from "./io.js";
import type { jobRunner } from "./jobs.js";
import { type Assigned, POLICY, UnderstandingReport, validateReport } from "./policy.js";
import { type Domain, type Fact, type navigation, selectDomain } from "./prepare.js";
import { type RecoveryProof, replayRecovery } from "./recovery.js";
import { LIMITS, type TopicResult, modelSelection } from "./render.js";
import type { runRepairJobs } from "./repair-jobs.js";
import type { reportReviewer } from "./report-review.js";
export async function runTopic(context: {
  out: string;
  inputHash: string;
  model: string;
  topic?: Domain;
  domain: Domain;
  nav: ReturnType<typeof navigation>;
  allFacts: Fact[];
  targetCanonicals: Set<string>;
  unavailableRepairs: Awaited<ReturnType<typeof runRepairJobs>>["unavailableRepairs"];
  jobs: Awaited<ReturnType<typeof jobRunner>>;
  auditedReport: ReturnType<typeof reportReviewer>;
}) {
  const {
    out,
    inputHash,
    model,
    topic: selectedTopic,
    domain,
    nav,
    allFacts,
    targetCanonicals,
    unavailableRepairs,
    jobs,
    auditedReport,
  } = context;
  const members = new Set(nav.filter((n) => n.domains.includes(domain)).map((n) => n.canonical_id));
  let selection = selectDomain(
    domain,
    allFacts.filter((e) => members.has(e.canonical_id)),
    targetCanonicals,
  );
  selection.repair_inputs_unavailable = unavailableRepairs
    .filter((r) =>
      r.canonical_id
        ? members.has(r.canonical_id)
        : r.row_ids.some((id) =>
            nav.some((n) => members.has(n.canonical_id) && n.row_ids.includes(id)),
          ),
    )
    .map((r) => r.request_id);
  let candidate: Report | undefined;
  let audit: unknown = null;
  let assigned: Assigned[] = [];
  let recovery: RecoveryProof | undefined;
  const selected = !selectedTopic || selectedTopic === domain;
  const payload = {
    task: "u2_domain_understanding",
    selection: modelSelection(selection),
    topics: nav
      .filter((n) => members.has(n.canonical_id))
      .flatMap((n) => n.topics)
      .filter((t, i, a) => a.indexOf(t) === i),
    semantic_scope: LIMITS,
  };
  if (selected && domain !== "unresolved" && selection.evidence.length) {
    const recovered = await replayRecovery(out, inputHash, model, selection, jobs);
    if (recovered) {
      ({ candidate, assigned, audit, selection } = recovered);
      recovery = recovered.proof;
    } else {
      candidate = await jobs.job("topic", payload, UnderstandingReport, (r) =>
        validateReport(r, selection),
      );
      if (candidate) {
        const reviewed = await auditedReport(
          "topic",
          "u2_domain_audit",
          payload,
          selection,
          candidate,
        );
        candidate = reviewed.candidate;
        assigned = reviewed.assigned;
        audit = reviewed.audit;
      }
    }
  }
  const status = !selected
    ? "not_selected"
    : domain === "unresolved"
      ? "context_required"
      : !selection.evidence.length
        ? "no_evidence"
        : audit
          ? "ready_candidate"
          : "partial";
  const pending = jobs.reasonsForDomain(domain);
  const stageReason = pending.some((p) => p.reason === "cumulative_call_budget_exhausted")
    ? "调用预算已耗尽（budget），剩余阶段未执行；这不表示原文不足。"
    : candidate
      ? "已有候选稿，独立审核失败或未执行（audit_failed）；具体原因见未决任务。"
      : jobs.errorsForDomain(domain).length > 0
        ? "候选生成或结构校验失败（candidate_failed），尚无合格稿。"
        : "候选生成阶段尚未执行；具体原因见未决任务。";
  const version = digest([
    inputHash,
    POLICY,
    model,
    domain,
    selection,
    candidate ?? null,
    audit ?? null,
    status,
  ]);
  const topic: TopicResult = {
    domain,
    status,
    version,
    selection,
    candidate: candidate ?? null,
    assigned,
    audit: audit ?? null,
    ...(recovery ? { recovery } : {}),
  };
  return { topic, stageReason };
}
