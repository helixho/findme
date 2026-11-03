import type { z } from "zod";
import type {
  DiagnosticEvidenceSnapshot,
  DiagnosticFeedback,
  DiagnosticFinding,
  DiagnosticMethod,
  DiagnosticSourceAssessment,
  DiagnosticSourceSnapshot,
  FindingVersionRef,
  ReportRevision,
} from "./diagnostic.js";

type ValidationRun = {
  id: string;
  method: z.infer<typeof DiagnosticMethod>;
  sources: DiagnosticSourceSnapshot[];
  assessments: z.infer<typeof DiagnosticSourceAssessment>[];
  evidence: DiagnosticEvidenceSnapshot[];
  reports: ReportRevision[];
  current_report_id: string;
  feedback: DiagnosticFeedback[];
};
type Fail = (message: string) => void;
type Unique = (keys: string[], name: string) => void;
type Sources = Map<string, DiagnosticSourceSnapshot>;
type Evidence = Map<string, DiagnosticEvidenceSnapshot>;
const sourceKey = (id: string, version: number) => `${id}@${version}`;

function checkUniqueIdentities(run: ValidationRun, unique: Unique) {
  unique([...run.sources.map((s) => sourceKey(s.id, s.version))], "source snapshots");
  unique(
    run.evidence.map((e) => e.id),
    "evidence IDs",
  );
  unique(
    run.evidence.map((e) => `${sourceKey(e.source_id, e.source_version)}:${e.start}:${e.end}`),
    "citation locations",
  );
  unique(
    run.assessments.map((a) => `${sourceKey(a.source_id, a.source_version)}@${a.version}`),
    "assessments",
  );
  unique(
    run.reports.map((r) => r.id),
    "report IDs",
  );
  unique(
    run.reports.map((r) => String(r.version)),
    "report versions",
  );
  unique(
    run.feedback.map((f) => f.id),
    "feedback IDs",
  );
  unique(run.method.required_evidence_ids, "method required evidence");
}

function checkSourceEvidence(run: ValidationRun, sources: Sources, evidence: Evidence, fail: Fail) {
  for (const a of run.assessments) {
    if (!sources.has(sourceKey(a.source_id, a.source_version)))
      fail(`Unknown assessment source ${a.source_id}`);
  }
  for (const e of run.evidence) {
    const s = sources.get(sourceKey(e.source_id, e.source_version));
    if (
      !s ||
      e.end <= e.start ||
      e.end > s.original_text.length ||
      s.original_text.slice(e.start, e.end) !== e.quote
    ) {
      fail(`Invalid exact citation ${e.id}`);
    }
  }
  for (const id of run.method.required_evidence_ids)
    if (!evidence.has(id)) fail(`Missing method evidence ${id}`);
}

function checkCurrentReport(run: ValidationRun, fail: Fail) {
  const current = run.reports.find((r) => r.id === run.current_report_id);
  if (
    !current ||
    current.version !== Math.max(...run.reports.map((r) => r.version)) ||
    current.status === "superseded"
  )
    fail("Invalid current report");
}

function checkReportIdentity(run: ValidationRun, r: ReportRevision, fail: Fail, unique: Unique) {
  if (r.run_id !== run.id) fail("Report belongs to another run");
  const previous = run.reports.find((p) => p.id === r.previous_report_id);
  if (
    r.version === 1
      ? r.previous_report_id !== null
      : !previous || previous.version !== r.version - 1
  )
    fail("Invalid report history chain");
  unique(
    r.findings.map((f) => f.id),
    "finding IDs",
  );
  unique(
    r.source_refs.map((s) => sourceKey(s.source_id, s.version)),
    "report source references",
  );
  unique(
    r.questions.map((q) => q.id),
    "question IDs",
  );
  unique(
    r.proposals.map((p) => p.id),
    "proposal IDs",
  );
}

function reportAdmissibility(run: ValidationRun, r: ReportRevision, sources: Sources, fail: Fail) {
  const admissible = new Set<string>();
  const contextAdmissible = new Set<string>();
  for (const ref of r.source_refs) {
    const s = sources.get(sourceKey(ref.source_id, ref.version));
    const a = run.assessments.find(
      (a) =>
        a.source_id === ref.source_id &&
        a.source_version === ref.version &&
        a.version === ref.assessment_version,
    );
    if (!s || !a) fail(`Unknown source/assessment reference ${ref.source_id}`);
    if (a?.eligibility === "eligible" && s?.availability !== "unavailable")
      admissible.add(sourceKey(ref.source_id, ref.version));
    if (
      a &&
      ["eligible", "context_only"].includes(a.eligibility) &&
      s?.availability !== "unavailable"
    )
      contextAdmissible.add(sourceKey(ref.source_id, ref.version));
    if (r.id === run.current_report_id) {
      const latest = Math.max(
        ...run.assessments
          .filter((a) => a.source_id === ref.source_id && a.source_version === ref.version)
          .map((a) => a.version),
      );
      if (ref.assessment_version !== latest)
        fail(`Stale current source assessment ${ref.source_id}`);
    }
  }

  return { admissible, contextAdmissible };
}

function checkResourceEvidence(
  r: ReportRevision,
  evidence: Evidence,
  admissible: Set<string>,
  fail: Fail,
) {
  for (const resource of r.resources)
    for (const id of resource.evidence_ids) {
      const e = evidence.get(id);
      if (
        !e ||
        (resource.status === "available" &&
          !admissible.has(sourceKey(e.source_id, e.source_version)))
      )
        fail("Invalid resource evidence");
    }
}

function checkCoverageEvidence(
  r: ReportRevision,
  evidence: Evidence,
  admissible: Set<string>,
  fail: Fail,
) {
  for (const area of r.coverage) {
    if (area.coverage !== "unknown" && !area.evidence_ids.length) fail("Coverage needs evidence");
    for (const id of area.evidence_ids) {
      const e = evidence.get(id);
      if (
        !e ||
        (area.coverage !== "unknown" && !admissible.has(sourceKey(e.source_id, e.source_version)))
      )
        fail("Invalid coverage evidence");
    }
  }
}

function checkReportTargets(r: ReportRevision, fail: Fail, unique: Unique) {
  const checkTargets = (targets: z.infer<typeof FindingVersionRef>[]) => {
    unique(
      targets.map((t) => t.finding_id),
      "finding targets",
    );
    for (const t of targets)
      if (!r.findings.some((f) => f.id === t.finding_id && f.version === t.version))
        fail(`Unknown finding version ${t.finding_id}`);
  };

  checkTargets(r.summary.targets);
  for (const q of r.questions) {
    checkTargets(q.targets);
    unique(
      q.branches.map((b) => b.id),
      "answer branches",
    );
  }
  for (const p of r.proposals) checkTargets(p.targets);
}

function checkFindingEvidence(
  run: ValidationRun,
  f: DiagnosticFinding,
  evidence: Evidence,
  admissible: Set<string>,
  contextAdmissible: Set<string>,
  fail: Fail,
  unique: Unique,
) {
  if (f.method_id !== run.method.id) fail(`Unknown method ${f.method_id}`);
  unique(
    f.evidence.map((e) => e.evidence_id),
    "finding evidence",
  );
  unique(f.required_evidence_ids, "required finding evidence");
  for (const ref of f.evidence) {
    const e = evidence.get(ref.evidence_id);
    if (
      !e ||
      !(ref.relation === "contextualizes" ? contextAdmissible : admissible).has(
        sourceKey(e.source_id, e.source_version),
      )
    )
      fail(`Unknown or inadmissible evidence ${ref.evidence_id}`);
  }
  for (const id of f.required_evidence_ids)
    if (!f.evidence.some((e) => e.evidence_id === id)) fail(`Missing required evidence ${id}`);
  if (
    f.evidence_sufficiency === "sufficient_for_scope" &&
    !f.evidence.some((e) => e.relation === "supports")
  )
    fail("Sufficient finding needs supporting evidence");
}

function checkFindingGrade(run: ValidationRun, f: DiagnosticFinding, fail: Fail) {
  if (
    f.framework_grade &&
    (!run.method.input_complete ||
      run.method.adaptation === "native" ||
      !run.method.grading?.allowed_values.includes(f.framework_grade.value) ||
      (run.method.adaptation === "historical_adaptation" &&
        !run.method.grading?.allows_historical_adaptation) ||
      f.evidence_sufficiency !== "sufficient_for_scope" ||
      f.framework_grade.framework_id !== run.method.id ||
      f.framework_grade.protocol_version !== run.method.protocol_version ||
      run.method.required_evidence_ids.some((id) => !f.evidence.some((e) => e.evidence_id === id)))
  )
    fail("Grade requires complete compatible protocol and required evidence");
}

function checkReportFreshness(r: ReportRevision, fail: Fail) {
  if (r.summary.status === "current" || r.summary.status === "candidate") {
    if (
      r.summary.targets.some(
        (t) => r.findings.find((f) => f.id === t.finding_id)?.status === "needs_review",
      )
    )
      fail("Summary cannot validate a stale finding");
  }
  for (const p of r.proposals)
    if (
      p.status === "offered" &&
      p.targets.some(
        (t) => r.findings.find((f) => f.id === t.finding_id)?.status === "needs_review",
      )
    )
      fail("Stale proposal cannot be offered");
}

function checkFeedbackTargets(run: ValidationRun, fail: Fail) {
  for (const f of run.feedback) {
    const r = run.reports.find((r) => r.id === f.report_id);
    if (
      !r ||
      f.targets.some(
        (t) => !r.findings.some((x) => x.id === t.finding_id && x.version === t.version),
      )
    )
      fail("Feedback references unknown report/finding version");
  }
}

// Keep the original phase and collection iteration order: it defines Zod issue order.
export function validateDiagnosticRun(run: ValidationRun, ctx: z.RefinementCtx) {
  const fail: Fail = (message) => ctx.addIssue({ code: "custom", message });
  const unique: Unique = (keys, name) => {
    if (new Set(keys).size !== keys.length) fail(`Duplicate ${name}`);
  };
  const sources = new Map(run.sources.map((s) => [sourceKey(s.id, s.version), s]));
  checkUniqueIdentities(run, unique);
  const evidence = new Map(run.evidence.map((e) => [e.id, e]));
  checkSourceEvidence(run, sources, evidence, fail);
  checkCurrentReport(run, fail);
  for (const r of run.reports) {
    checkReportIdentity(run, r, fail, unique);
    const { admissible, contextAdmissible } = reportAdmissibility(run, r, sources, fail);
    checkResourceEvidence(r, evidence, admissible, fail);
    checkCoverageEvidence(r, evidence, admissible, fail);
    checkReportTargets(r, fail, unique);
    for (const f of r.findings) {
      checkFindingEvidence(run, f, evidence, admissible, contextAdmissible, fail, unique);
      checkFindingGrade(run, f, fail);
    }
    checkReportFreshness(r, fail);
  }
  checkFeedbackTargets(run, fail);
}
