import type {
  FrameworkAssertion,
  FrameworkAudit,
  FrameworkCandidate,
  FrameworkDefinition,
  FrameworkDomainAssessment,
  FrameworkRef,
} from "@findme/core";
import { hash } from "./definition.js";
import type { Run } from "./schema.js";

export function assertions(candidate: FrameworkCandidate): FrameworkAssertion[] {
  const result: FrameworkAssertion[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if ("id" in v && "text" in v && "refs" in v) {
      result.push(v as FrameworkAssertion);
      return;
    }
    for (const item of Object.values(v))
      if (Array.isArray(item)) {
        for (const child of item) visit(child);
      } else visit(item);
  };
  visit(candidate);
  return result;
}
export function validateRef(run: Run, ref: FrameworkRef, domain?: string) {
  const source = run.answers.find((a) => a.id === ref.source_id && a.status === "valid");
  if (
    !source ||
    (domain && source.domain !== domain) ||
    ref.start < 0 ||
    ref.end <= ref.start ||
    ref.end > source.text.length ||
    source.text.slice(ref.start, ref.end) !== ref.quote
  )
    throw new Error("INVALID_EXACT_EVIDENCE");
}
function assessmentPolicy(run: Run, d: FrameworkDefinition, a: FrameworkDomainAssessment) {
  if (!d.domains.some((x) => x.key === a.domain)) throw new Error("UNKNOWN_DOMAIN");
  if (a.level && !d.levels.some((x) => x.key === a.level)) throw new Error("UNDEFINED_LEVEL");
  if (a.phase && !d.phases.some((x) => x.key === a.phase)) throw new Error("UNDEFINED_PHASE");
  if (a.evidence_status === "not_asked" && run.questions.some((x) => x.domain === a.domain))
    throw new Error("ASKED_DOMAIN_CANNOT_BE_NOT_ASKED");
  if (
    a.evidence_status !== "supported" &&
    (a.level ||
      a.phase ||
      a.rationale ||
      [a.strengths, a.limitations, a.practice_mismatch, a.regression, a.channels].some(
        (x) => x.length,
      ))
  )
    throw new Error("UNSUPPORTED_ASSESSMENT");
  if (a.evidence_status === "supported" && (!a.rationale || !a.level || !a.phase))
    throw new Error("ASSESSMENT_RATIONALE_REQUIRED");
  for (const t of [a.knowledge, a.experience, a.skill]) {
    if (
      (t.status === "supported") !== (t.assessment !== null) ||
      (t.status !== "supported" && !t.reason)
    )
      throw new Error("TRAIT_EVIDENCE_REQUIRED");
  }
  for (const claim of assertions({ kind: "evaluation", assessment: a }))
    for (const ref of claim.refs) validateRef(run, ref, a.domain);
}
export function validateCandidate(run: Run, candidate: FrameworkCandidate, stage: string) {
  const d = run.definition;
  const domain = d.domains[run.domain_index];
  const count = run.answers.filter((a) => a.status === "valid" && a.domain === domain?.key).length;
  const asked = run.questions.filter((q) => q.domain === domain?.key).length;
  if (candidate.kind === "question") {
    if (
      !["question", "adaptive"].includes(stage) ||
      !domain ||
      candidate.domain !== domain.key ||
      asked >= domain.max_answers ||
      run.open_question
    )
      throw new Error("QUESTION_PROTOCOL_VIOLATION");
    for (const ref of candidate.intent.refs) validateRef(run, ref, domain.key);
    if (
      run.questions.some((q) => q.domain === domain.key && q.text.trim() === candidate.text.trim())
    )
      throw new Error("DUPLICATE_QUESTION");
  } else if (candidate.kind === "evaluation") {
    if (
      !["evaluation", "adaptive"].includes(stage) ||
      !domain ||
      candidate.assessment.domain !== domain.key ||
      (count < domain.min_answers && asked < domain.max_answers)
    )
      throw new Error("DOMAIN_MINIMUM_NOT_MET");
    assessmentPolicy(run, d, candidate.assessment);
  } else {
    if (stage !== "synthesis" || run.assessments.length !== d.domains.length)
      throw new Error("SYNTHESIS_PRECONDITION");
    const s = candidate.synthesis;
    if (
      s.plans.length !== d.plan_horizons.length ||
      new Set(s.plans.map((p) => p.horizon)).size !== s.plans.length ||
      s.plans.some((p) => !d.plan_horizons.includes(p.horizon))
    )
      throw new Error("UNDEFINED_PLAN_HORIZON");
    for (const link of s.cross_domain_links) {
      if (
        new Set(link.domains).size !== link.domains.length ||
        link.domains.some((k) => !d.domains.some((x) => x.key === k)) ||
        link.domains.some(
          (k) =>
            !link.assessment.refs.some((r) =>
              run.answers.some(
                (a) => a.id === r.source_id && a.domain === k && a.status === "valid",
              ),
            ),
        ) ||
        link.assessment.basis !== "hypothesis"
      )
        throw new Error("CROSS_DOMAIN_EVIDENCE_REQUIRED");
    }
    if (
      s.core_problem.basis !== "hypothesis" ||
      s.plans.some((p) => p.proposals.some((a) => a.basis !== "hypothesis")) ||
      s.glitch_risks.some((a) => a.basis !== "hypothesis")
    )
      throw new Error("PROPOSAL_HYPOTHESIS_REQUIRED");
  }
  const allocated = assertions(candidate);
  if (new Set(allocated.map((a) => a.id)).size !== allocated.length)
    throw new Error("DUPLICATE_ASSERTION_ID");
  for (const a of allocated) for (const ref of a.refs) validateRef(run, ref);
}
export function validateAudit(
  run: Run,
  candidate: FrameworkCandidate,
  audit: FrameworkAudit,
  inputHash: string,
) {
  const allocated = assertions(candidate);
  const ids = run.answers
    .filter((a) => a.status === "valid")
    .map((a) => a.id)
    .sort();
  if (
    audit.input_hash !== inputHash ||
    audit.candidate_hash !== hash(candidate) ||
    hash([...audit.source_ids].sort()) !== hash(ids) ||
    audit.checks.length !== allocated.length ||
    new Set(audit.checks.map((c) => c.assertion_id)).size !== allocated.length ||
    allocated.some((a) => !audit.checks.some((c) => c.assertion_id === a.id)) ||
    audit.findings.length ||
    audit.checks.some((c) => !c.supported || !c.safe || c.findings.length)
  )
    throw new Error("AUDIT_REJECTED");
}
export function semanticInput(run: Run, stage: string) {
  return {
    definition: run.definition,
    mode: run.mode,
    stage,
    domain_index: run.domain_index,
    answers: run.answers.filter((a) => a.status === "valid"),
    skipped_questions: run.skipped_questions,
    questions: run.questions.filter((q) =>
      q.input_source_ids.every((id) =>
        run.answers.some((a) => a.id === id && a.status === "valid"),
      ),
    ),
    assessments: run.assessments,
  };
}
