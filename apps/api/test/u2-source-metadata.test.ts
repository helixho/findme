import type { UnderstandingReport } from "@findme/core";
import { describe, expect, it } from "vitest";
import { normalizeReportTimes, validateReport } from "../src/understanding-baseline/policy.js";
import { type Fact, type Selection, selectDomain } from "../src/understanding-baseline/prepare.js";
const t1 = "2026-01-01T00:00:00Z";
const t2 = "2026-02-01T00:00:00Z";
function fixture() {
  const evidence = [t1, t2].map(
    (time, i) =>
      ({
        id: `e${i}`,
        time,
        about: "project",
        content_author: "subject",
        kind: "self_report",
        use: "project_report",
        purpose: "project_report",
        stance: "reported",
        proposition_type: "role",
      }) as Fact,
  );
  const selection = {
    domain: "role_direction",
    evidence,
    omitted: [],
    bytes: 0,
    selected_original_atoms: 2,
    canonical_count: 2,
    scope: "synthetic",
    repair_inputs_unavailable: [],
  } as Selection;
  const finding = {
    key: "f",
    text: "本人报告两个项目情境。",
    scope: "所给材料",
    evidence_ids: ["e0", "e1"],
    counterevidence_ids: [],
    context_ids: [],
    time: t2,
    status: "reported" as const,
  };
  const report: UnderstandingReport = {
    headline: "合成报告",
    current_understanding: finding,
    findings: [],
    resources_conditions_costs: [],
    alternatives: [],
    unknowns: [],
    question: null,
    next_step: null,
    nodes: [],
    links: [],
  };
  return { selection, report };
}
describe("source report metadata is distinct from inferred events and actors", () => {
  it("represents several cited report timestamps without selecting one as the aggregate date", () => {
    const { selection, report } = fixture();
    const normalized = normalizeReportTimes(report, selection);
    expect(normalized.current_understanding?.time).toBeNull();
    expect(report.current_understanding?.time).toBe(t2);
    expect(() => validateReport(normalized, selection)).not.toThrow();
  });
  it("does not erase an invented date to make it pass", () => {
    const { selection, report } = fixture();
    if (report.current_understanding) report.current_understanding.time = "1999-01-01";
    expect(() => validateReport(normalizeReportTimes(report, selection), selection)).toThrow(
      "TIME_SCOPE_MISMATCH",
    );
  });
  it("keeps an unknown reference invalid", () => {
    const { selection, report } = fixture();
    report.current_understanding?.evidence_ids.push("invented");
    expect(() => validateReport(normalizeReportTimes(report, selection), selection)).toThrow(
      "UNKNOWN_REPORT_REFERENCE",
    );
  });
});
describe("project-context report attribution", () => {
  it("allows a reported third-party entity inside subject-authored project context, pending semantic audit", () => {
    const { selection, report } = fixture();
    if (report.current_understanding) report.current_understanding.time = null;
    report.nodes = [
      {
        key: "n",
        type: "role",
        text: "本人报告协作方承担评审职责。",
        actor: "third_party",
        about: "third_party",
        stance: "reported",
        status: "reported",
        evidence_ids: ["e0"],
        scope: "本次项目角色自述；需语义复核实际行为主体",
        time: t1,
      },
    ];
    expect(() => validateReport(report, selection)).not.toThrow();
    required(report.nodes[0]).status = "inferred";
    expect(() => validateReport(report, selection)).toThrow("PROJECT_REPORT_ONLY");
  });
  it("does not generalize the allowance to ordinary self-only evidence", () => {
    const { selection, report } = fixture();
    if (report.current_understanding) report.current_understanding.time = null;
    for (const e of selection.evidence) {
      e.about = "self";
      e.use = "personal_expression";
      e.purpose = "personal_expression";
    }
    report.nodes = [
      {
        key: "n",
        type: "role",
        text: "错误指派",
        actor: "third_party",
        about: "third_party",
        stance: "reported",
        status: "reported",
        evidence_ids: ["e0"],
        scope: "synthetic",
        time: t1,
      },
    ];
    expect(() => validateReport(report, selection)).toThrow("NODE_ATTRIBUTION_MISMATCH");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("SYNTHETIC_FIXTURE_REQUIRED");
  return value;
}

it("separates the speaker of a reported concern from what the concern is about", () => {
  const { selection, report } = fixture();
  if (report.current_understanding) report.current_understanding.time = null;
  for (const e of selection.evidence) {
    e.about = "self";
    e.use = "personal_expression";
    e.purpose = "personal_expression";
  }
  report.nodes = [
    {
      key: "n",
      type: "constraint",
      text: "本人报告担心协作者不能使用工具，不声称未使用已发生。",
      actor: "subject",
      about: "third_party",
      stance: "reported",
      status: "reported",
      evidence_ids: ["e0"],
      scope: "仅限担心，真实行为待核验",
      time: t1,
    },
  ];
  expect(() => validateReport(report, selection)).not.toThrow();
  required(report.nodes[0]).type = "outcome";
  expect(() => validateReport(report, selection)).toThrow("NODE_ATTRIBUTION_MISMATCH");
});

it("does not let recovery-target priority erase existing personal expression coverage", () => {
  const { selection } = fixture();
  const personal = Array.from(
    { length: 12 },
    (_, i) =>
      ({
        ...selection.evidence[0],
        id: `p${i}`,
        canonical_id: `p${i}`,
        root_ids: [`p${i}`],
        quote: `明确个人表达 ${i}`,
        start: 0,
        end: 8,
        scope: "自身",
        project: "main",
        proposition_type: "preference",
        proposition: `偏好 ${i}`,
        purpose: "personal_expression",
        use: "personal_expression",
        kind: "evaluation",
        about: "self",
        provenance: "original",
        time: t1,
      }) as Fact,
  );
  const repaired = Array.from(
    { length: 40 },
    (_, i) =>
      ({
        ...selection.evidence[0],
        id: `r${i}`,
        canonical_id: `r${i}`,
        root_ids: [`r${i}`],
        quote: `项目自述 ${i}`,
        start: 0,
        end: 6,
        scope: "项目",
        project: "main",
        proposition_type: "state",
        proposition: `状态 ${i}`,
        provenance: "reviewed_model",
        time: t1,
      }) as Fact,
  );
  const result = selectDomain(
    "collaboration",
    [...repaired, ...personal],
    new Set(repaired.map((e) => e.canonical_id)),
    12,
  );
  expect(result.evidence.filter((e) => e.use === "personal_expression").length).toBeGreaterThan(0);
  expect(result.selection_version).toBe("u2-domain-selection@2");
  expect(result.omitted.length).toBeGreaterThan(0);
});
