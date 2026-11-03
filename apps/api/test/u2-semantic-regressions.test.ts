import {
  OldClaimReview,
  type ReasoningEvidence,
  type ReasoningSource,
  type UnderstandingReport as Report,
  UnderstandingAudit,
  UnderstandingReport,
  UseRepairs,
} from "@findme/core";
import { describe, expect, it } from "vitest";
import type { Inputs, OldClaim } from "../src/understanding-baseline/input.js";
import {
  PROMPTS,
  assignReport,
  normalizeReportTimes,
  validateAudit,
  validateOld,
  validateReport,
} from "../src/understanding-baseline/policy.js";
import {
  type Fact,
  type RepairRequest,
  facts,
  repairRequests,
  resolveRepairs,
  selectDomain,
  sourceSafe,
} from "../src/understanding-baseline/prepare.js";
import { abstainRejectedRepair } from "../src/understanding-baseline/repair-normalize.js";
// Only synthetic in-memory originals; no DB, corpus, .env, services or gateway.
const text = "我在示例项目负责规划，目标是完成原型。";
const timestamp = "2026-01-02T00:00:00Z";
function source(
  id = "s1",
  original_text = text,
  patch: Partial<ReasoningSource> = {},
): ReasoningSource {
  return {
    id,
    session_id: `session-${id}`,
    message_id: `message-${id}`,
    source_uuid: null,
    project: "synthetic-project",
    occurred_at: "2020-01-01T00:00:00Z",
    disclosed_at: timestamp,
    group_id: `group-${id}`,
    split: "dev",
    original_text,
    revision: "r1",
    review_revision: 0,
    review_notes: [],
    blocked_ranges: [],
    excluded: false,
    ...patch,
  };
}
function row(id = "e1", s = source(), patch: Partial<ReasoningEvidence> = {}): ReasoningEvidence {
  return {
    id,
    canonical_id: "c1",
    source_id: s.id,
    start: 0,
    end: s.original_text.length,
    quote: s.original_text,
    content_author: "subject",
    about: "project",
    kind: "self_report",
    stance: "reported",
    stance_candidate: "reported",
    provenance: "model_candidate",
    attribution_notes: [],
    use: "context",
    revision: "r1",
    excluded: false,
    stale: false,
    classification_conflict: false,
    ...patch,
  };
}
function inputFor(
  rows: ReasoningEvidence[] = [row()],
  sources: ReasoningSource[] = [source()],
  facet = "goal",
): Inputs {
  const canonical = [...new Set(rows.map((e) => e.canonical_id))].map((id) => {
    const members = rows.filter((e) => e.canonical_id === id);
    return {
      id,
      rows: members.map((e) => ({
        ...e,
        author: e.content_author,
        facet,
        scope: "local synthetic project",
        project: "synthetic-project",
        sessionId: `session-${e.source_id}`,
        messageId: `message-${e.source_id}`,
      })),
      qualified: members,
      split: "dev",
      blocked: false,
      disputed: false,
      eligible: false,
      facets: [facet],
      projects: ["synthetic-project"],
      dates: [],
      final_support: [],
      final_counter: [],
    };
  });
  return {
    inventory: {
      canonical,
      packet: { sources, evidence: rows },
      segments: [],
      batch: { sources: [] },
    },
    review: { sample_review: [], classification_variants: { records: [] }, topic_review: [] },
    samples: [],
    destinations: [],
    old: [],
    input_hash: "synthetic",
    artifacts: [],
  } as unknown as Inputs;
}
function variant(input: Inputs, canonical_id = "c1", subset?: ReasoningEvidence[]): RepairRequest {
  const rows =
    subset ?? input.inventory.packet.evidence.filter((e) => e.canonical_id === canonical_id);
  return {
    id: `variant:${canonical_id}`,
    kind: "variant",
    canonical_id,
    rows,
    windows: rows.map((e) => ({
      source_id: e.source_id,
      start: e.start,
      end: e.end,
      text: e.quote,
    })),
    opinion: { assessment: "compatible_facets" },
    unavailable: null,
  };
}
type Proposition = UseRepairs["repairs"][number]["propositions"][number];
function proposition(e: ReasoningEvidence, patch: Partial<Proposition> = {}): Proposition {
  return {
    evidence_id: e.id,
    source_id: e.source_id,
    quote: e.quote,
    start: e.start,
    end: e.end,
    type: "role",
    stance: e.stance,
    about: "project",
    kind: "self_report",
    purpose: "project_report",
    proposition: "本人报告在示例项目中承担规划角色。",
    scope: "local synthetic project",
    reason: "合成原文局部自述。",
    ...patch,
  };
}
function repairs(request: RepairRequest, propositions: Proposition[]): UseRepairs {
  return UseRepairs.parse({
    repairs: [
      { request_id: request.id, decision: "propositions", reason: "局部命题复核。", propositions },
    ],
  });
}
function overlayFacts(input: Inputs, ps: Proposition[], request = variant(input)) {
  return facts(input, resolveRepairs(input, [request], repairs(request, ps)));
}
function finding(id: string, e: Fact, patch: Record<string, unknown> = {}) {
  return {
    key: id,
    text: "本人在这个局部情境如此报告。",
    evidence_ids: [e.id],
    counterevidence_ids: [],
    context_ids: [],
    scope: e.scope,
    time: e.time,
    status: "reported",
    ...patch,
  };
}
function report(e: Fact): Report {
  return UnderstandingReport.parse({
    headline: "合成局部理解",
    current_understanding: finding("current", e),
    findings: [],
    resources_conditions_costs: [],
    alternatives: [],
    unknowns: [],
    question: null,
    next_step: null,
    nodes: [
      {
        key: "n1",
        type: e.proposition_type,
        actor: "subject",
        about: e.about === "self" ? "subject" : e.about,
        text: e.proposition,
        stance: e.stance,
        evidence_ids: [e.id],
        scope: e.scope,
        time: e.time,
        status: "reported",
      },
    ],
    links: [],
  });
}
describe("U2 whole-canonical stance protection (independent synthetic sources)", () => {
  it.each([
    ["endorsed", "opposed"],
    ["endorsed", "not_endorsed"],
    ["opposed", "not_endorsed"],
  ] as const)("compatible_facets cannot waive %s / %s across aliases", (a, b) => {
    const s1 = source();
    const s2 = source("s2");
    const e1 = row("e1", s1, { stance: a, about: "self" });
    const e2 = row("e2", s2, { stance: b, about: "self" });
    const input = inputFor([e1, e2], [s1, s2]);
    required(input.inventory.canonical[0]).disputed = true;
    // Only one anchor/window is sent in this chunk; the other alias must still protect the canonical.
    const request = variant(input, "c1", [e1]);
    expect(() =>
      resolveRepairs(
        input,
        [request],
        repairs(request, [proposition(e1, { purpose: "personal_expression", about: "self" })]),
      ),
    ).toThrow("CANONICAL_STANCE_CONFLICT");
  });
  it.each(["endorsed", "opposed", "not_endorsed", "reported"] as const)(
    "preserves exact known %s on the same proposition",
    (stance) => {
      const e = row("e1", source(), { stance, about: "self" });
      const input = inputFor([e]);
      const request = variant(input);
      for (const target of ["endorsed", "opposed", "not_endorsed", "reported"] as const) {
        const run = () =>
          resolveRepairs(
            input,
            [request],
            repairs(request, [
              proposition(e, { purpose: "personal_expression", about: "self", stance: target }),
            ]),
          );
        if (target === stance) expect(run()).toHaveLength(1);
        else expect(run).toThrow("STANCE_ESCALATION");
      }
    },
  );
  it.each(["reported", "unknown"] as const)("%s is not silently positive", (stance) => {
    const e = row("e1", source(), { stance, about: "self" });
    const input = inputFor([e]);
    const request = variant(input);
    expect(() =>
      resolveRepairs(
        input,
        [request],
        repairs(request, [
          proposition(e, { purpose: "personal_expression", about: "self", stance: "endorsed" }),
        ]),
      ),
    ).toThrow("STANCE_ESCALATION");
  });
  it.each([
    { content_author: "third_party" },
    { content_author: "unknown" },
    { kind: "quotation" },
    { kind: "system_wrapper" },
  ] as Partial<ReasoningEvidence>[])(
    "hidden incompatible author/history %j stays unpromotable",
    (patch) => {
      const s1 = source();
      const s2 = source("s2");
      const e1 = row("e1", s1);
      const e2 = row("e2", s2, patch);
      const input = inputFor([e1, e2], [s1, s2]);
      required(input.inventory.canonical[0]).disputed = true;
      const request = variant(input, "c1", [e1]);
      expect(() => resolveRepairs(input, [request], repairs(request, [proposition(e1)]))).toThrow(
        "DISPUTED_AUTHOR_NOT_PROMOTABLE",
      );
    },
  );
  it("reported alias cannot become endorsed through another already-endorsed alias", () => {
    const s2 = source("s2");
    const a = row("e1", source(), { stance: "endorsed", about: "self" });
    const b = row("e2", s2);
    const input = inputFor([a, b], [source(), s2]);
    const request = variant(input, "c1", [a]);
    expect(() =>
      resolveRepairs(
        input,
        [request],
        repairs(request, [proposition(a, { about: "self", purpose: "personal_expression" })]),
      ),
    ).toThrow("STANCE_ESCALATION");
  });
});
describe("U2 semantic propositions and source contributions", () => {
  it("keeps role + goal over one original span, prefers overlays and counts one contribution", () => {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    const all = overlayFacts(input, [
      proposition(e),
      proposition(e, { type: "goal", proposition: "本人报告目标是完成原型。" }),
    ]);
    const selection = selectDomain("role_direction", all, new Set(), 1);
    expect(selection.evidence.map((e) => e.proposition_type).sort()).toEqual(["goal", "role"]);
    expect(selection.evidence.map((e) => e.proposition)).toContain("本人报告目标是完成原型。");
    expect(
      selection.evidence.every(
        (f) =>
          f.purpose === "project_report" &&
          f.original_facet === "goal" &&
          f.start === e.start &&
          f.end === e.end &&
          f.quote === e.quote &&
          f.root_ids.includes(e.id),
      ),
    ).toBe(true);
    expect(selection.selected_original_atoms).toBe(1);
    expect(selection.canonical_count).toBe(1);
    expect(selection.omitted).toContainEqual({
      id: e.id,
      reason: "superseded_by_audited_proposition",
    });
  });
  it("deduplicates repeated semantic propositions from independent-source aliases, not role vs goal", () => {
    const s2 = source("s2");
    const a = row();
    const b = row("e2", s2);
    const input = inputFor([a, b], [source(), s2]);
    const goal = { type: "goal" as const, proposition: "本人报告目标是完成原型。" };
    const all = overlayFacts(input, [proposition(a), proposition(a, goal), proposition(b, goal)]);
    const selection = selectDomain("role_direction", all, new Set(), 1);
    expect(selection.evidence).toHaveLength(2);
    expect(selection.selected_original_atoms).toBe(1);
    expect(
      selection.omitted.filter((e) => e.reason === "duplicate_semantic_proposition"),
    ).toHaveLength(1);
    expect(selection.evidence.every((e) => ["s1", "s2"].includes(e.source_id))).toBe(true);
  });
  it("supports a supplied subset without demanding unrelated repair requests", () => {
    const s2 = source("s2");
    const e2 = row("e2", s2, { canonical_id: "c2" });
    const input = inputFor([row(), e2], [source(), s2]);
    const requests = repairRequests(input);
    expect(requests).toHaveLength(2);
    expect(
      resolveRepairs(
        input,
        [required(requests[1])],
        repairs(required(requests[1]), [proposition(e2)]),
      ),
    ).toHaveLength(1);
  });
});
describe("U2 scoped project reports and mixed commands", () => {
  it("uses a repaired completed outcome instead of legacy goal/work_requirement denial", () => {
    const s = source("s1", "我已完成示例项目测试，请检查报告。");
    const e = row("e1", s, { kind: "work_requirement" });
    const input = inputFor([e], [s]);
    const all = overlayFacts(input, [
      proposition(e, {
        type: "outcome",
        quote: "我已完成示例项目测试",
        start: 0,
        end: "我已完成示例项目测试".length,
        proposition: "本人报告完成示例项目测试。",
      }),
    ]);
    const selection = selectDomain("role_direction", all);
    const repaired = required(selection.evidence[0]);
    expect(repaired).toMatchObject({
      original_facet: "goal",
      proposition_type: "outcome",
      kind: "self_report",
      purpose: "project_report",
    });
    expect(() => validateReport(report(repaired), selection)).not.toThrow();
    expect(repaired.time).toBe(timestamp); // Source report time, not the older source event metadata.
  });
  it.each(["role", "goal", "constraint", "choice", "outcome", "state", "evaluation"] as const)(
    "accepts local project %s as reported only",
    (type) => {
      const input = inputFor();
      const e = required(input.inventory.packet.evidence[0]);
      const selection = selectDomain(
        "role_direction",
        overlayFacts(input, [proposition(e, { type })]),
      );
      const r = report(required(selection.evidence[0]));
      expect(() => validateReport(r, selection)).not.toThrow();
      required(r.nodes[0]).status = "inferred";
      expect(() => validateReport(r, selection)).toThrow("PROJECT_REPORT_ONLY");
    },
  );
  it("does not turn an unrepaired plan into an outcome", () => {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    const selection = selectDomain(
      "role_direction",
      overlayFacts(input, [proposition(e, { type: "goal" })]),
    );
    const r = report(required(selection.evidence[0]));
    required(r.nodes[0]).type = "outcome";
    expect(() => validateReport(r, selection)).toThrow("PLAN_IS_NOT_OUTCOME");
  });
  it.each(["project", "third_party"] as const)(
    "retains explicit subject evaluation/choice ABOUT %s",
    (about) => {
      for (const kind of ["evaluation", "choice"] as const) {
        const e = row("e1", source(), { about, kind });
        const input = inputFor([e]);
        const selection = selectDomain(
          "judgment_learning",
          overlayFacts(input, [
            proposition(e, { about, kind, type: kind, purpose: "personal_expression" }),
          ]),
        );
        const r = report(required(selection.evidence[0]));
        expect(r.nodes[0]).toMatchObject({ actor: "subject", about });
        expect(() => validateReport(r, selection)).not.toThrow();
      }
    },
  );
  it("does not universally promote commands; explicit scoped goals stay scoped", () => {
    const s = source("s1", "请按既定清单操作；这次我的目标是完成示例。");
    const e = row("e1", s, { kind: "work_requirement" });
    const input = inputFor([e], [s]);
    const request = variant(input);
    expect(() =>
      resolveRepairs(
        input,
        [request],
        repairs(request, [
          proposition(e, { about: "self", type: "preference", purpose: "personal_expression" }),
        ]),
      ),
    ).toThrow("COMMAND_IS_NOT_PREFERENCE");
    const q = "这次我的目标是完成示例";
    const start = s.original_text.indexOf(q);
    const overlays = resolveRepairs(
      input,
      [request],
      repairs(request, [
        proposition(e, {
          about: "self",
          type: "goal",
          purpose: "personal_expression",
          quote: q,
          start,
          end: start + q.length,
        }),
      ]),
    );
    expect(overlays[0]).toMatchObject({
      scope: "local synthetic project",
      type: "goal",
      root_ids: [e.id],
    });
  });
});
describe("U2 complete safe project-report review pool", () => {
  it("enumerates generic groups once with exact canonical/row IDs and no prequalification", () => {
    const s2 = source("s2");
    const s3 = source("s3", "我报告另一个示例项目的局部约束。");
    const a = row();
    const b = row("e2", s2);
    const c = row("e3", s3, { canonical_id: "c2" });
    const input = inputFor([a, b, c], [source(), s2, s3], "background");
    const requests = repairRequests(input);
    expect(requests.map((r) => r.id)).toEqual(["project:c1", "project:c2"]);
    expect(requests[0]).toMatchObject({
      kind: "project_report",
      canonical_id: "c1",
      unavailable: null,
    });
    expect(required(requests[0]).rows.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(required(requests[0]).windows).toHaveLength(1);
    expect(JSON.stringify(required(requests[0]).opinion)).toContain("undecided");
  });
  it("does not add a root already covered by sample or variant", () => {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    const s = required(input.inventory.packet.sources[0]);
    input.samples = [
      {
        id: "sample1",
        canonical_id: "c1",
        source_id: s.id,
        session_id: s.session_id,
        message_id: s.message_id,
        segment_id: "seg1",
        windows: [{ start: 0, end: e.end, text: e.quote }],
        result: null,
      },
    ];
    input.review.sample_review = [
      {
        sample_id: "sample1",
        adjudication: "propose_scoped_use_repair",
        category: "background",
        reason: "review",
      },
    ];
    input.inventory.segments = [
      { id: "seg1", sessionId: s.session_id, messageId: s.message_id, start: 0, end: e.end },
    ] as Inputs["inventory"]["segments"];
    input.inventory.batch.sources = [
      { id: s.id, sessionId: s.session_id, originalMessageId: s.message_id },
    ] as Inputs["inventory"]["batch"]["sources"];
    expect(repairRequests(input).map((r) => r.id)).toEqual(["sample:sample1"]);
    input.review.sample_review = [];
    input.review.classification_variants.records = [
      { canonical_id: "c1", row_ids: [e.id], assessment: "compatible_facets", reason: "review" },
    ];
    expect(repairRequests(input).map((r) => r.id)).toEqual(["variant:c1"]);
  });
  it.each([
    { kind: "quotation" },
    { kind: "system_wrapper" },
    { kind: "unknown" },
    { content_author: "unknown" },
    { content_author: "third_party" },
    { excluded: true },
    { stale: true },
  ] as Partial<ReasoningEvidence>[])("excludes unsafe project anchors %j", (patch) => {
    expect(repairRequests(inputFor([row("e1", source(), patch)]))).toEqual([]);
  });
  it("holdout, excluded source, blocked canonical and exclusion ranges cannot enter the pool", () => {
    for (const patch of [
      { split: "holdout" },
      { excluded: true },
      { blocked_ranges: [{ start: 0, end: 2 }] },
    ] as Partial<ReasoningSource>[]) {
      const s = source("s1", text, patch);
      expect(repairRequests(inputFor([row("e1", s)], [s]))).toEqual([]);
    }
    const input = inputFor();
    required(input.inventory.canonical[0]).split = "holdout";
    expect(repairRequests(input)).toEqual([]);
    required(input.inventory.canonical[0]).split = "dev";
    required(input.inventory.canonical[0]).blocked = true;
    expect(repairRequests(input)).toEqual([]);
  });
  it("keeps safe neighbours within 160 UTF16 units and trims unsafe adjacent context", () => {
    const prefix = "前".repeat(200);
    const quote = "我报告示例项目目标。";
    const suffix = "后".repeat(200);
    const s = source("s1", prefix + quote + suffix);
    const e = row("e1", s, { start: prefix.length, end: prefix.length + quote.length, quote });
    const input = inputFor([e], [s]);
    const w = required(required(repairRequests(input)[0]).windows[0]);
    expect(w.start).toBe(e.start - 160);
    expect(w.end).toBe(e.end + 160);
    expect(s.original_text.slice(w.start, w.end)).toBe(w.text);
    const blocked = row("excluded", s, {
      canonical_id: "blocked",
      start: e.end + 1,
      end: e.end + 3,
      quote: s.original_text.slice(e.end + 1, e.end + 3),
      excluded: true,
    });
    const unsafe = inputFor([e, blocked], [s]);
    expect(required(repairRequests(unsafe)[0]).windows[0]).toEqual({
      source_id: s.id,
      start: e.start,
      end: e.end,
      text: quote,
    });
    const quoted = { ...blocked, excluded: false, kind: "quotation" as const };
    expect(required(required(repairRequests(inputFor([e, quoted], [s]))[0]).windows[0]).text).toBe(
      quote,
    );
  });
  it("overlapping quoted/excluded anchors cannot hide outside a project's canonical", () => {
    const a = row();
    const b = { ...row("e2"), canonical_id: "other", kind: "quotation" as const };
    expect(repairRequests(inputFor([a, b]))).toEqual([]);
  });
  it("a current reviewed source is safe when its exact row is neither stale nor excluded", () => {
    const s = source("s1", text, { review_revision: 2 });
    const e = row("e1", s);
    const input = inputFor([e], [s]);
    expect(sourceSafe(s, 0, e.end)).toBe(true);
    expect(repairRequests(input)).toHaveLength(1);
    expect(facts(input, [])).toHaveLength(1);
    expect(repairRequests(inputFor([{ ...e, stale: true }], [s]))).toHaveLength(0);
    expect(facts(inputFor([{ ...e, stale: true }], [s]), [])).toHaveLength(0);
  });
});
describe("U2 report roles, attribution, time and practical schemas", () => {
  function selected() {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    return selectDomain("role_direction", overlayFacts(input, [proposition(e)]));
  }
  it("allows zero findings and an empty report without fabricated counts", () => {
    const empty = UnderstandingReport.parse({
      headline: "资料不足",
      current_understanding: null,
      findings: [],
      resources_conditions_costs: [],
      alternatives: [],
      unknowns: ["当前选材不足。"],
      question: null,
      next_step: null,
      nodes: [],
      links: [],
    });
    expect(() => validateReport(empty, selectDomain("unresolved", []))).not.toThrow();
    const selection = selected();
    const r = report(required(selection.evidence[0]));
    expect(r.findings).toHaveLength(0);
    expect(() => validateReport(r, selection)).not.toThrow();
    r.current_understanding = null;
    expect(() => validateReport(r, selection)).toThrow("CURRENT_UNDERSTANDING_REQUIRED");
  });
  it("requires explicit actor/about and evidence role arrays in model output", () => {
    const selection = selected();
    const r = report(required(selection.evidence[0]));
    const missing = JSON.parse(JSON.stringify(r));
    missing.current_understanding.counterevidence_ids = undefined;
    expect(UnderstandingReport.safeParse(missing).success).toBe(false);
    const missingActor = JSON.parse(JSON.stringify(r));
    missingActor.nodes[0].actor = undefined;
    expect(UnderstandingReport.safeParse(missingActor).success).toBe(false);
    const missingAbout = JSON.parse(JSON.stringify(r));
    missingAbout.nodes[0].about = undefined;
    expect(UnderstandingReport.safeParse(missingAbout).success).toBe(false);
    const missingContext = JSON.parse(JSON.stringify(r));
    missingContext.current_understanding.context_ids = undefined;
    expect(UnderstandingReport.safeParse(missingContext).success).toBe(false);
  });
  it("allows context_ids as background, never support/challenge, and rejects role overlaps or unknown refs", () => {
    const selection = selected();
    const s2 = source("s2", "请按示例清单操作。");
    const context = required(
      facts(
        inputFor([row("ctx", s2, { canonical_id: "ctx", kind: "work_requirement" })], [s2]),
        [],
      )[0],
    );
    selection.evidence.push(context);
    const r = report(required(selection.evidence[0]));
    required(r.current_understanding).context_ids = [context.id];
    required(r.current_understanding).time = null;
    expect(() => validateReport(r, selection)).not.toThrow();
    required(r.current_understanding).counterevidence_ids = [context.id];
    required(r.current_understanding).context_ids = [];
    expect(() => validateReport(r, selection)).toThrow("CONTEXT_IS_NOT_PERSONAL_PROOF");
    required(r.current_understanding).counterevidence_ids = required(
      r.current_understanding,
    ).evidence_ids;
    expect(() => validateReport(r, selection)).toThrow("DUPLICATE_EVIDENCE_ROLE");
    required(r.current_understanding).counterevidence_ids = [];
    required(r.current_understanding).context_ids = ["not-supplied"];
    expect(() => validateReport(r, selection)).toThrow("UNKNOWN_REPORT_REFERENCE");
  });
  it("permits unknown findings with context but no fabricated personal supports", () => {
    const s = source("s1", "请按示例清单操作。");
    const input = inputFor([row("e1", s, { kind: "work_requirement" })], [s]);
    const selection = selectDomain("unresolved", facts(input, []));
    const r = UnderstandingReport.parse({
      headline: "信息不足",
      current_understanding: finding("unknown", required(selection.evidence[0]), {
        status: "unknown",
        evidence_ids: [],
        context_ids: ["e1"],
      }),
      findings: [],
      resources_conditions_costs: [],
      alternatives: [],
      unknowns: ["这里只有任务情境。"],
      question: null,
      next_step: null,
      nodes: [],
      links: [],
    });
    expect(() => validateReport(r, selection)).not.toThrow();
  });
  it("preserves report time or null, and rejects an inferred event date", () => {
    const selection = selected();
    const r = report(required(selection.evidence[0]));
    expect(required(r.nodes[0]).time).toBe(timestamp);
    required(r.nodes[0]).time = "2020-01-01T00:00:00Z";
    expect(() => validateReport(r, selection)).toThrow("TIME_SCOPE_MISMATCH");
    required(r.nodes[0]).time = null;
    expect(() => validateReport(r, selection)).not.toThrow();
  });
  it("rejects structurally inconsistent attribution and leaves semantic attribution to audit", () => {
    const e = row("e1", source(), {
      about: "self",
      kind: "evaluation",
      use: "personal_expression",
    });
    const input = inputFor([e], [source()], "evaluation");
    const selection = selectDomain("judgment_learning", facts(input, []));
    const r = report(required(selection.evidence[0]));
    required(r.nodes[0]).actor = "project";
    expect(() => validateReport(r, selection)).toThrow("NODE_ATTRIBUTION_MISMATCH");
    required(r.nodes[0]).actor = "subject";
    required(r.nodes[0]).about = "third_party";
    // A self-only report does not establish another actor's ROLE. A reported
    // first-person concern about another object has separate coverage below.
    required(r.nodes[0]).type = "role";
    expect(() => validateReport(r, selection)).toThrow("NODE_ATTRIBUTION_MISMATCH");
  });
  it("preserves explicit third-party actor on a project-reported outcome", () => {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    const selection = selectDomain(
      "role_direction",
      overlayFacts(input, [
        proposition(e, { type: "outcome", proposition: "本人报告示例项目中供应方完成交付。" }),
      ]),
    );
    const r = report(required(selection.evidence[0]));
    required(r.nodes[0]).actor = "third_party";
    expect(() => validateReport(r, selection)).not.toThrow();
  });
  it("limits repair propositions to 3, nodes and links to 8, findings to 4 without quotas", () => {
    const input = inputFor();
    const request = variant(input);
    const p = proposition(required(input.inventory.packet.evidence[0]));
    expect(() =>
      repairs(
        request,
        Array.from({ length: 4 }, () => p),
      ),
    ).toThrow();
    const selection = selected();
    const r = report(required(selection.evidence[0]));
    expect(
      UnderstandingReport.safeParse({ ...r, nodes: Array.from({ length: 9 }, () => r.nodes[0]) })
        .success,
    ).toBe(false);
    expect(
      UnderstandingReport.safeParse({
        ...r,
        findings: Array.from({ length: 5 }, () => r.current_understanding),
      }).success,
    ).toBe(false);
    expect(
      UnderstandingReport.safeParse({
        ...r,
        links: Array.from({ length: 9 }, (_, i) => ({
          key: `l${i}`,
          type: "related_context",
          from: "n1",
          to: "n2",
          evidence_ids: [required(selection.evidence[0]).id],
          scope: "local",
          time: null,
          status: "reported",
        })),
      }).success,
    ).toBe(false);
    expect(PROMPTS.topic + PROMPTS.overall + PROMPTS.audit).not.toMatch(
      /O1\.\.O8|E1\.\.E3|2-4 findings|presented_problem|revision_checks/,
    );
    expect(PROMPTS.repair).toContain("no private chain of thought");
  });
});
describe("U2 old kind correction and complete isolated audit", () => {
  function oldFixture() {
    const input = inputFor();
    const e = required(input.inventory.packet.evidence[0]);
    const evidence = selectDomain("old_claims", overlayFacts(input, [proposition(e)])).evidence;
    const old = [
      {
        id: "old1",
        text: "合成旧认识：两项条件构成冲突。",
        scope: "local synthetic project",
        kind: "tension",
        evidence_ids: [e.id],
        counterevidence_ids: [],
      },
    ] as (OldClaim & {
      kind: string;
    })[];
    const disposition = {
      old_id: "old1",
      disposition: "reclassified",
      text: required(old[0]).text,
      scope: required(old[0]).scope,
      new_kind: "compatible_conditions",
      evidence_ids: [required(evidence[0]).id],
      reason: "分类更正，不表示本人变化。",
      shared_context: null,
      incompatibility: null,
    };
    return { old, evidence, disposition };
  }
  it("explicitly changes tension to compatible_conditions while preserving original text and input kind", () => {
    const f = oldFixture();
    const result = OldClaimReview.parse({ dispositions: [f.disposition] });
    expect(() => validateOld(result, f.old, f.evidence)).not.toThrow();
    expect(required(f.old[0]).kind).toBe("tension");
    expect(required(result.dispositions[0]).text).toBe(required(f.old[0]).text);
    for (const new_kind of [null, "tension"])
      expect(() =>
        validateOld(
          OldClaimReview.parse({ dispositions: [{ ...f.disposition, new_kind }] }),
          f.old,
          f.evidence,
        ),
      ).toThrow("RECLASSIFICATION_KIND_REQUIRED");
  });
  it("unchanged preserves exact text/scope/kind, null new_kind retains original", () => {
    const f = oldFixture();
    const result = OldClaimReview.parse({
      dispositions: [{ ...f.disposition, disposition: "unchanged", new_kind: null }],
    });
    expect(() => validateOld(result, f.old, f.evidence)).not.toThrow();
    required(result.dispositions[0]).new_kind = "observation";
    expect(() => validateOld(result, f.old, f.evidence)).toThrow("OLD_CLAIM_KIND_CHANGED");
    required(result.dispositions[0]).new_kind = "tension";
    required(result.dispositions[0]).text += "改写";
    expect(() => validateOld(result, f.old, f.evidence)).toThrow("UNCHANGED_TEXT_MUST_BE_EXACT");
    required(result.dispositions[0]).text = required(f.old[0]).text;
    required(result.dispositions[0]).scope += "扩大";
    expect(() => validateOld(result, f.old, f.evidence)).toThrow("UNCHANGED_TEXT_MUST_BE_EXACT");
  });
  it("accepts coordinator's original type alias but never missing kind for a reclassification", () => {
    const f = oldFixture();
    const { kind, ...old } = required(f.old[0]);
    const result = OldClaimReview.parse({ dispositions: [f.disposition] });
    expect(() =>
      validateOld(result, [{ ...old, type: kind } as OldClaim], f.evidence),
    ).not.toThrow();
    expect(() => validateOld(result, [old], f.evidence)).toThrow("RECLASSIFICATION_KIND_REQUIRED");
    const missing = { ...f.disposition } as Record<string, unknown>;
    missing.new_kind = undefined;
    expect(OldClaimReview.safeParse({ dispositions: [missing] }).success).toBe(false);
  });
  it("requires all assigned IDs and exact input hash; any correctness warning rejects", () => {
    const f = oldFixture();
    const r = report(required(f.evidence[0]));
    const assigned = assignReport(r, "a".repeat(64));
    const hash = "b".repeat(64);
    const audit = UnderstandingAudit.parse({
      input_hash: hash,
      checks: assigned.map((a) => ({
        id: a.id,
        checked: true,
        rationale: "逐项核对合成输入。",
        same_context: false,
        concrete_incompatibility: false,
      })),
      issues: [],
    });
    expect(() =>
      validateAudit(
        audit,
        hash,
        assigned,
        f.evidence.map((e) => e.id),
      ),
    ).not.toThrow();
    expect(() =>
      validateAudit({ ...audit, checks: audit.checks.slice(1) }, hash, assigned, []),
    ).toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
    expect(() => validateAudit(audit, "c".repeat(64), assigned, [])).toThrow(
      "INCOMPLETE_SAME_INPUT_AUDIT",
    );
    audit.issues = [
      {
        code: "unrecognized_semantic_error",
        target_id: required(assigned[0]).id,
        evidence_ids: [],
        severity: "warning",
        rationale: "缺乏原文支持。",
      },
    ];
    expect(() => validateAudit(audit, hash, assigned, [])).toThrow("SEMANTIC_AUDIT_REJECTED");
    required(audit.issues[0]).evidence_ids = ["not-supplied"];
    expect(() => validateAudit(audit, hash, assigned, [])).toThrow("UNKNOWN_AUDIT_REFERENCE");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}

describe("U2 rejected proposals remain unknown without losing other requests", () => {
  it("never publishes an invalid author promotion; retains it for review and keeps safe siblings", async () => {
    const { normalizeRepairCandidates } = await import(
      "../src/understanding-baseline/repair-normalize.js"
    );
    const s1 = source();
    const s2 = source("s2");
    const invalid = row("e1", s1, { content_author: "unknown" });
    const valid = row("e2", s2, { canonical_id: "c2" });
    const input = inputFor([invalid, valid], [s1, s2]);
    const r1 = variant(input, "c1", [invalid]);
    const r2 = variant(input, "c2", [valid]);
    const original = {
      repairs: [
        ...repairs(r1, [proposition(invalid)]).repairs,
        ...repairs(r2, [proposition(valid)]).repairs,
      ],
    };
    const result = normalizeRepairCandidates(input, [r1, r2], original);
    expect(result.rejected).toHaveLength(1);
    expect(result.candidate.repairs[0]).toMatchObject({ decision: "unknown", propositions: [] });
    expect(result.candidate.repairs[1]?.decision).toBe("propositions");
    expect(original.repairs[0]?.decision).toBe("propositions");
    expect(resolveRepairs(input, [r1, r2], result.candidate)).toHaveLength(1);
  });
  it("does not downgrade missing requests or unknown identities into fake completed decisions", async () => {
    const { normalizeRepairCandidates } = await import(
      "../src/understanding-baseline/repair-normalize.js"
    );
    const input = inputFor();
    const r = variant(input);
    expect(() => normalizeRepairCandidates(input, [r], { repairs: [] })).toThrow(
      "INCOMPLETE_REPAIR_DECISIONS",
    );
    expect(() =>
      normalizeRepairCandidates(input, [r], {
        repairs: [
          { request_id: "invented", decision: "unknown", reason: "not examined", propositions: [] },
        ],
      }),
    ).toThrow("UNKNOWN_REPAIR_REQUEST");
  });
});

describe("U2 narrow report transport normalization", () => {
  it("converts only exact time null literals and preserves originals, dates and semantics", () => {
    const input = inputFor();
    const e = required(
      overlayFacts(input, [proposition(row())]).find((e) => e.use === "project_report"),
    );
    const draft = report(e);
    required(draft.current_understanding).time = "null";
    draft.findings = [{ ...required(draft.current_understanding), key: "f", time: " null" }];
    draft.resources_conditions_costs = [
      { ...required(draft.current_understanding), key: "r", time: "NULL" },
    ];
    draft.links = [];
    draft.headline = "null";
    const copy = normalizeReportTimes(draft);
    expect(required(copy.current_understanding).time).toBeNull();
    expect(required(copy.findings[0]).time).toBe(" null");
    expect(required(copy.resources_conditions_costs[0]).time).toBe("NULL");
    expect(copy.headline).toBe("null");
    expect(copy.nodes).toEqual(draft.nodes);
    expect(required(draft.current_understanding).time).toBe("null");
    expect(() => validateReport(copy, selectDomain("role_direction", [e]))).toThrow(
      "TIME_SCOPE_MISMATCH",
    );
    copy.findings = [];
    copy.resources_conditions_costs = [];
    expect(() => validateReport(copy, selectDomain("role_direction", [e]))).not.toThrow();
    required(copy.nodes[0]).time = "2026-01-03T00:00:00Z";
    expect(() =>
      validateReport(normalizeReportTimes(copy), selectDomain("role_direction", [e])),
    ).toThrow("TIME_SCOPE_MISMATCH");
  });
});
describe("U2 bounded semantic abstention by assigned IDs", () => {
  function rejected() {
    const s1 = source("s1", "配置同步被忘记了。");
    const s2 = source("s2", "我在示例项目负责规划。");
    const e1 = row("e1", s1);
    const e2 = row("e2", s2, { canonical_id: "c2" });
    const input = inputFor([e1, e2], [s1, s2]);
    const requests = [variant(input), variant(input, "c2")];
    const candidate = UseRepairs.parse({
      repairs: [
        ...repairs(required(requests[0]), [
          proposition(e1, { proposition: "本人经常忘记同步配置。" }),
        ]).repairs,
        ...repairs(required(requests[1]), [proposition(e2)]).repairs,
      ],
    });
    const proposed = resolveRepairs(input, requests, candidate);
    const assigned = [
      { id: "arbitrary-decision-A", key: required(requests[0]).id, category: "repair_decision" },
      { id: "arbitrary-decision-B", key: required(requests[1]).id, category: "repair_decision" },
      ...proposed.map((p, i) => ({
        id: `arbitrary-proposition-${i}`,
        key: p.id,
        category: "proposition",
      })),
    ];
    const audit = UnderstandingAudit.parse({
      input_hash: "a".repeat(64),
      checks: assigned.map((a) => ({
        id: a.id,
        checked: true,
        rationale: "合成复核",
        same_context: false,
        concrete_incompatibility: false,
      })),
      issues: [
        {
          code: "false_actor",
          target_id: "arbitrary-proposition-0",
          evidence_ids: [e1.id],
          severity: "warning",
          rationale: "原文未指定遗忘者；也不支持经常。",
        },
      ],
    });
    const run = () =>
      abstainRejectedRepair(input, requests, candidate, audit, "a".repeat(64), assigned, proposed);
    return { input, requests, candidate, proposed, assigned, audit, run };
  }
  it("withdraws the affected request, keeps siblings and original use, and retains rejection", () => {
    const f = rejected();
    const corrected = required(f.run());
    expect(corrected.candidate.repairs[0]).toMatchObject({ decision: "unknown", propositions: [] });
    expect(corrected.candidate.repairs[1]).toEqual(f.candidate.repairs[1]);
    expect(required(required(corrected.rejected[0]).original.propositions[0]).proposition).toBe(
      "本人经常忘记同步配置。",
    );
    expect(required(required(corrected.rejected[0]).issues[0]).severity).toBe("warning");
    expect(required(f.candidate.repairs[0]).decision).toBe("propositions");
    const overlays = resolveRepairs(f.input, f.requests, corrected.candidate);
    expect(overlays.every((o) => o.request_id !== required(f.requests[0]).id)).toBe(true);
    expect(required(facts(f.input, overlays).find((e) => e.root_ids.includes("e1"))).use).toBe(
      "context",
    );
    expect(() => validateAudit(f.audit, "a".repeat(64), f.assigned, ["e1"])).toThrow(
      "SEMANTIC_AUDIT_REJECTED",
    );
  });
  it("does not withdraw global issues or unknown/missing targets", () => {
    const f = rejected();
    required(f.audit.issues[0]).target_id = null;
    expect(f.run()).toBeUndefined();
    required(f.audit.issues[0]).target_id = "unassigned";
    expect(f.run).toThrow("UNKNOWN_AUDIT_REFERENCE");
    const { target_id: _removedTarget, ...missingTarget } = required(f.audit.issues[0]);
    f.audit.issues[0] = missingTarget as (typeof f.audit.issues)[number];
    expect(f.run).toThrow("UNKNOWN_AUDIT_REFERENCE");
  });
  it("rejects wrong input hash, missing checks, and bad evidence without severity bypass", () => {
    const f = rejected();
    f.audit.input_hash = "b".repeat(64);
    expect(f.run).toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
    f.audit.input_hash = "a".repeat(64);
    required(f.audit.issues[0]).evidence_ids = ["absent"];
    expect(f.run).toThrow("UNKNOWN_AUDIT_REFERENCE");
    f.audit.checks.pop();
    expect(f.run).toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
  });
});
