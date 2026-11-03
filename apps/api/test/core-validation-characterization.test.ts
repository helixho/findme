import { DiagnosticRun } from "@findme/core";
import { describe, expect, it } from "vitest";
import { createRun } from "../../app/src/diagnostic-preview/scenarios";

function cases(): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];
  const add = (name: string, change: (run: DiagnosticRun) => void) => {
    const run = createRun("zero");
    change(run);
    result.push([name, run]);
  };
  result.push(["valid", createRun("zero")]);
  add("duplicate-identities", (r) => {
    r.sources.push(structuredClone(r.sources[0]!));
    r.evidence.push(structuredClone(r.evidence[0]!));
    r.assessments.push(structuredClone(r.assessments[0]!));
    r.reports.push(structuredClone(r.reports[0]!));
    r.method.required_evidence_ids = ["missing", "missing"];
  });
  add("citation-and-assessment", (r) => {
    r.assessments[0]!.source_id = "missing";
    r.evidence[0]!.quote = "inexact";
    r.evidence[1]!.source_version = 999;
    r.evidence[2]!.end = r.evidence[2]!.start;
    r.method.required_evidence_ids = ["missing"];
  });
  add("history-and-targets", (r) => {
    r.current_report_id = "missing";
    const p = r.reports[0]!;
    p.run_id = "other";
    p.previous_report_id = "missing";
    p.summary.targets = [
      { finding_id: "missing", version: 1 },
      { finding_id: "missing", version: 2 },
    ];
    for (const q of p.questions) {
      q.targets = p.summary.targets;
      q.branches[1]!.id = q.branches[0]!.id;
    }
    for (const a of p.proposals) a.targets = p.summary.targets;
    r.feedback.push({
      id: "bad",
      report_id: "missing",
      targets: p.summary.targets,
      kind: "contested",
      text: "",
      analysis_status: "recorded",
      created_at: "now",
    });
  });
  add("resource-coverage-scope", (r) => {
    for (const a of r.assessments) a.eligibility = "excluded";
    const p = r.reports[0]!;
    p.resources.push({ text: "missing", evidence_ids: ["missing"], status: "available" });
    p.coverage.push({ area: "empty", coverage: "observed", note: "test", evidence_ids: [] });
    p.coverage.push({
      area: "invalid",
      coverage: "partial",
      note: "test",
      evidence_ids: ["missing", r.evidence[0]!.id],
    });
  });
  add("stale-assessment-unavailable", (r) => {
    r.assessments.push({ ...r.assessments[0]!, version: 2 });
    r.sources[1]!.availability = "unavailable";
    r.reports[0]!.source_refs.push({ source_id: "missing", version: 1, assessment_version: 1 });
  });
  add("finding-evidence-order", (r) => {
    const f = r.reports[0]!.findings[0]!;
    f.method_id = "missing";
    f.evidence = [
      { evidence_id: "missing", relation: "supports" },
      { evidence_id: "missing", relation: "challenges" },
    ];
    f.required_evidence_ids = ["required", "required"];
    f.evidence_sufficiency = "sufficient_for_scope";
    f.framework_grade = { framework_id: "bad", protocol_version: "bad", value: "bad" };
  });
  add("no-support-stale-summary-proposal", (r) => {
    const p = r.reports[0]!;
    for (const f of p.findings) {
      f.status = "needs_review";
      f.evidence_sufficiency = "sufficient_for_scope";
      for (const e of f.evidence) e.relation = "contextualizes";
    }
    p.summary.status = "current";
    for (const a of p.proposals) a.status = "offered";
  });
  for (const relation of ["supports", "challenges", "contextualizes"] as const) {
    add(`context-only-${relation}`, (r) => {
      r.reports[0]!.findings[0]!.evidence = [{ evidence_id: "Z4-quote", relation }];
    });
  }
  for (const mode of ["native", "original_protocol", "historical_adaptation"] as const) {
    for (const complete of [false, true]) {
      add(`grade-${mode}-${complete}`, (r) => {
        r.method.adaptation = mode;
        r.method.input_complete = complete;
        r.method.grading = { allowed_values: ["A"], allows_historical_adaptation: false };
        const f = r.reports[0]!.findings[0]!;
        f.evidence_sufficiency = "sufficient_for_scope";
        f.framework_grade = {
          framework_id: r.method.id,
          protocol_version: r.method.protocol_version,
          value: "A",
        };
      });
    }
  }
  add("allowed-historical-grade", (r) => {
    r.method.adaptation = "historical_adaptation";
    r.method.input_complete = true;
    r.method.grading = { allowed_values: ["A"], allows_historical_adaptation: true };
    const f = r.reports[0]!.findings[0]!;
    f.evidence_sufficiency = "sufficient_for_scope";
    f.framework_grade = {
      framework_id: r.method.id,
      protocol_version: r.method.protocol_version,
      value: "A",
    };
  });
  for (const field of ["scope", "relation", "grade"] as const) {
    const r = createRun("zero");
    const f = r.reports[0]!.findings[0]!;
    if (field === "scope") (f as unknown as Record<string, unknown>).scope = 42;
    if (field === "relation")
      (f.evidence[0] as unknown as Record<string, unknown>).relation = "invalid";
    if (field === "grade") (f as unknown as Record<string, unknown>).framework_grade = { value: 1 };
    result.push([`malformed-${field}`, r]);
  }
  return result;
}
function outcome(input: unknown) {
  const parsed = DiagnosticRun.safeParse(input);
  return parsed.success ? { success: true } : { success: false, issues: parsed.error.issues };
}

// Captured from the pre-extraction schema; compare complete Zod issues, including order.
const expected = {
  valid: {
    success: true,
  },
  "duplicate-identities": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Duplicate source snapshots",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate evidence IDs",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate citation locations",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate assessments",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate report IDs",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate report versions",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate method required evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Missing method evidence missing",
        path: [],
      },
      {
        code: "custom",
        message: "Missing method evidence missing",
        path: [],
      },
    ],
  },
  "citation-and-assessment": {
    success: false,
    issues: [
      {
        code: "too_small",
        minimum: 0,
        type: "number",
        inclusive: false,
        exact: false,
        message: "Number must be greater than 0",
        path: ["evidence", 2, "end"],
      },
      {
        code: "custom",
        message: "Unknown assessment source missing",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid exact citation Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid exact citation Z2-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid exact citation Z3-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing method evidence missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown source/assessment reference Z1",
        path: [],
      },
      {
        code: "custom",
        message: "Stale current source assessment Z1",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z2-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z1-quote",
        path: [],
      },
    ],
  },
  "history-and-targets": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Invalid current report",
        path: [],
      },
      {
        code: "custom",
        message: "Report belongs to another run",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid report history chain",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate finding targets",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate finding targets",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate answer branches",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate finding targets",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate answer branches",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate finding targets",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown finding version missing",
        path: [],
      },
      {
        code: "custom",
        message: "Feedback references unknown report/finding version",
        path: [],
      },
    ],
  },
  "resource-coverage-scope": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Coverage needs evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid coverage evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid coverage evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z2-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z4-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z3-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z4-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z3-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z1-quote",
        path: [],
      },
    ],
  },
  "stale-assessment-unavailable": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Stale current source assessment Z1",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown source/assessment reference missing",
        path: [],
      },
      {
        code: "custom",
        message: "Stale current source assessment missing",
        path: [],
      },
      {
        code: "custom",
        message: "Invalid resource evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z2-quote",
        path: [],
      },
    ],
  },
  "finding-evidence-order": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Unknown method missing",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate finding evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Duplicate required finding evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence missing",
        path: [],
      },
      {
        code: "custom",
        message: "Unknown or inadmissible evidence missing",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence required",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence required",
        path: [],
      },
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "no-support-stale-summary-proposal": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Sufficient finding needs supporting evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Sufficient finding needs supporting evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Sufficient finding needs supporting evidence",
        path: [],
      },
      {
        code: "custom",
        message: "Summary cannot validate a stale finding",
        path: [],
      },
      {
        code: "custom",
        message: "Stale proposal cannot be offered",
        path: [],
      },
    ],
  },
  "context-only-supports": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z4-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence Z2-quote",
        path: [],
      },
    ],
  },
  "context-only-challenges": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Unknown or inadmissible evidence Z4-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence Z2-quote",
        path: [],
      },
    ],
  },
  "context-only-contextualizes": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Missing required evidence Z1-quote",
        path: [],
      },
      {
        code: "custom",
        message: "Missing required evidence Z2-quote",
        path: [],
      },
    ],
  },
  "grade-native-false": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "grade-native-true": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "grade-original_protocol-false": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "grade-original_protocol-true": {
    success: true,
  },
  "grade-historical_adaptation-false": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "grade-historical_adaptation-true": {
    success: false,
    issues: [
      {
        code: "custom",
        message: "Grade requires complete compatible protocol and required evidence",
        path: [],
      },
    ],
  },
  "allowed-historical-grade": {
    success: true,
  },
  "malformed-scope": {
    success: false,
    issues: [
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["reports", 0, "findings", 0, "scope"],
        message: "Expected string, received number",
      },
    ],
  },
  "malformed-relation": {
    success: false,
    issues: [
      {
        received: "invalid",
        code: "invalid_enum_value",
        options: ["supports", "challenges", "contextualizes"],
        path: ["reports", 0, "findings", 0, "evidence", 0, "relation"],
        message:
          "Invalid enum value. Expected 'supports' | 'challenges' | 'contextualizes', received 'invalid'",
      },
    ],
  },
  "malformed-grade": {
    success: false,
    issues: [
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["reports", 0, "findings", 0, "framework_grade", "framework_id"],
        message: "Required",
      },
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["reports", 0, "findings", 0, "framework_grade", "protocol_version"],
        message: "Required",
      },
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["reports", 0, "findings", 0, "framework_grade", "value"],
        message: "Expected string, received number",
      },
    ],
  },
};
describe("Core diagnostic validation characterization", () => {
  it.each(cases())("preserves %s", (name, input) => {
    expect(outcome(input)).toEqual(expected[name as keyof typeof expected]);
  });
});
