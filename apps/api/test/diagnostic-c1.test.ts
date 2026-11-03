import { DiagnosticRun } from "@findme/core";
import { describe, expect, it } from "vitest";
import { CASE_IDS, createRun, required } from "../../app/src/diagnostic-preview/scenarios";
import {
  applyCommand,
  createPreviewState,
  currentReport,
  latestAssessment,
  parsePreviewState,
  reportHistory,
} from "../../app/src/diagnostic-preview/state";
import type { Action, PreviewState } from "../../app/src/diagnostic-preview/state";
import {
  StorageWriteError,
  commitPreview,
  exportPreview,
  loadPreview,
  resetPreview,
  storageKey,
} from "../../app/src/diagnostic-preview/storage";
let counter = 0;
const command = (s: PreviewState, action: Action, id = `op-${++counter}`) => ({
  id,
  expectedVersion: s.run.version,
  report_id: currentReport(s).id,
  action,
});
const apply = (s: PreviewState, a: Action) => applyCommand(s, command(s, a));
class MemoryStore {
  values = new Map<string, string>();
  fail = false;
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw new Error("quota");
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
describe("C1 diagnostic source and grading contract", () => {
  it.each(CASE_IDS)("validates %s without fabricated grades", (id) => {
    const run = createRun(id);
    expect(DiagnosticRun.safeParse(run).success).toBe(true);
    expect(run.reports.flatMap((r) => r.findings).every((f) => f.framework_grade === null)).toBe(
      true,
    );
  });
  it("rejects inexact source quotes and missing references", () => {
    const r = createRun("zero");
    required(r.evidence[0]).quote += "invented";
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
    const other = createRun("zero");
    required(other.reports[0]).findings[0].evidence.push({
      evidence_id: "missing",
      relation: "supports",
    });
    expect(DiagnosticRun.safeParse(other).success).toBe(false);
  });
  it("allows context-only text only for contextualizes", () => {
    const r = createRun("zero");
    expect(required(r.assessments.find((a) => a.source_id === "Z4")).eligibility).toBe(
      "context_only",
    );
    expect(DiagnosticRun.safeParse(r).success).toBe(true);
    required(
      required(r.reports[0]).findings[0].evidence.find((e) => e.evidence_id === "Z4-quote"),
    ).relation = "supports";
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
  });
  it("rejects native/arbitrary grades even with claimed complete input", () => {
    const r = createRun("zero");
    r.method.input_complete = true;
    const f = required(r.reports[0]).findings[0];
    f.evidence_sufficiency = "sufficient_for_scope";
    f.framework_grade = {
      framework_id: r.method.id,
      protocol_version: r.method.protocol_version,
      value: "Invented-L999",
    };
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
    r.method.adaptation = "original_protocol";
    r.method.grading = { allowed_values: ["defined-A"], allows_historical_adaptation: false };
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
    f.framework_grade.value = "defined-A";
    expect(DiagnosticRun.safeParse(r).success).toBe(true);
    r.method.input_complete = false;
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
  });
  it("rejects duplicate evidence identities", () => {
    const r = createRun("zero");
    r.evidence.push(structuredClone(required(r.evidence[0])));
    expect(DiagnosticRun.safeParse(r).success).toBe(false);
  });
});
describe("C1 actual revision and correction", () => {
  it.each(CASE_IDS)("changes %s main judgment and preserves history", (id) => {
    const s = createPreviewState(id);
    const initial = JSON.stringify(s);
    const next = apply(s, { type: "branch" });
    expect(currentReport(next).version).toBe(2);
    expect(currentReport(next).summary.text).not.toBe(currentReport(s).summary.text);
    expect(JSON.stringify(s)).toBe(initial);
    expect(reportHistory(next)[0].display_status).toBe("superseded");
    expect(apply(next, { type: "branch" })).toBe(next);
  });
  it("exclusion removes only dependent support and invalidates resources", () => {
    const s = createPreviewState("zero");
    const f1 = structuredClone(currentReport(s).findings[0]);
    const next = apply(s, {
      type: "source_correction",
      source_id: "Z3",
      kind: "excluded",
      text: "exclude source",
    });
    expect(currentReport(next).findings[0]).toEqual(f1);
    expect(currentReport(next).findings[1].status).toBe("needs_review");
    expect(currentReport(next).resources.filter((r) => r.status === "needs_review")).toHaveLength(
      2,
    );
    expect(latestAssessment(next.run, "Z3").eligibility).toBe("excluded");
    const revised = apply(next, { type: "branch" });
    expect(
      currentReport(revised)
        .findings.flatMap((f) => f.evidence)
        .some((e) => e.evidence_id === "Z3-quote"),
    ).toBe(false);
    expect(revised.run.sources).toContainEqual(required(s.run.sources.find((x) => x.id === "Z3")));
  });
  it("does not reoffer a declined proposal after a correction", () => {
    let s = apply(createPreviewState("zero"), {
      type: "decline_proposal",
      proposal_id: "zero-experiment",
    });
    s = apply(s, {
      type: "source_correction",
      source_id: "Z2",
      kind: "not_mine",
      text: "not the subject",
    });
    expect(currentReport(s).proposals[0].status).toBe("declined");
    expect(currentReport(s).summary.status).toBe("needs_review");
  });
  it("keeps helpful and disagreement separate from evidence truth", () => {
    let s = createPreviewState("fire");
    const before = structuredClone(currentReport(s).findings[0]);
    s = apply(s, {
      type: "finding_feedback",
      finding_id: "fire-f1",
      kind: "helpful",
      text: "useful",
    });
    expect(currentReport(s).findings[0]).toEqual(before);
    s = apply(s, {
      type: "finding_feedback",
      finding_id: "fire-f1",
      kind: "contested",
      text: "another interpretation",
    });
    expect(currentReport(s).findings[0].status).toBe("contested");
    expect(currentReport(s).findings[0].evidence).toEqual(before.evidence);
  });
  it("free text stays verbatim pending and does not become a scripted source", () => {
    const s = createPreviewState("zero");
    const text = "  我的补充不是预写分支\n请保留原话。";
    const n = apply(s, { type: "answer", question_id: "zero-q1", kind: "free_text", text });
    expect(n.run.feedback[0].text).toBe(text);
    expect(n.run.feedback[0].analysis_status).toBe("pending");
    expect(n.run.sources).toEqual(s.run.sources);
    expect(currentReport(n).summary.status).toBe("needs_review");
    expect(currentReport(apply(n, { type: "branch" })).summary.status).toBe("needs_review");
  });
  it.each(["skip", "unknown"] as const)("%s does not create a trait or score", (kind) => {
    const s = createPreviewState("zero");
    const n = apply(s, { type: "answer", question_id: "zero-q1", kind });
    expect(n.run.reports).toEqual(s.run.reports);
    expect(n.answered["zero-q1"]).toBe(kind);
  });
  it("different explicit example answers give distinct conditional reports", () => {
    const s = createPreviewState("zero");
    const a = apply(s, {
      type: "answer",
      question_id: "zero-q1",
      kind: "sample_answer",
      branch_id: "room",
    });
    const b = apply(s, {
      type: "answer",
      question_id: "zero-q1",
      kind: "sample_answer",
      branch_id: "no-room",
    });
    expect(currentReport(a).summary.text).not.toBe(currentReport(b).summary.text);
    expect(a.run.feedback[0].analysis_status).toBe("scripted");
  });
  it("changed-now preserves the source and historical time", () => {
    const s = createPreviewState("rich");
    const n = apply(s, {
      type: "finding_feedback",
      finding_id: "rich-f1",
      kind: "changed_now",
      text: "now different",
    });
    expect(n.run.sources).toEqual(s.run.sources);
    expect(n.run.reports[0]).toEqual(s.run.reports[0]);
    expect(currentReport(n).findings[0].status).toBe("needs_review");
  });
  it("rejects stale, unknown and colliding commands but retries idempotently", () => {
    const s = createPreviewState("zero");
    const cmd = command(s, { type: "branch" }, "same");
    const n = applyCommand(s, cmd);
    expect(applyCommand(n, cmd)).toBe(n);
    expect(() => applyCommand(n, { ...cmd, action: { type: "finish" } })).toThrow("同一操作编号");
    expect(() => applyCommand(n, { ...command(s, { type: "finish" }), id: "new" })).toThrow(
      "另一处更新",
    );
    expect(() =>
      apply(s, {
        type: "finding_feedback",
        finding_id: "other-case",
        kind: "helpful",
        text: "bad",
      }),
    ).toThrow("不属于");
  });
  it("source exclusion downgrades dependent domain coverage", () => {
    const s = apply(createPreviewState("rich"), {
      type: "source_correction",
      source_id: "H9",
      kind: "excluded",
      text: "remove",
    });
    expect(currentReport(s).coverage.find((c) => c.area === "身体与精力")?.coverage).toBe(
      "unknown",
    );
    expect(currentReport(s).coverage.find((c) => c.area === "工作与协作")?.coverage).toBe(
      "observed",
    );
  });
});
describe("C1 local persistence and recovery", () => {
  it("detects tampered original text even when its quote is changed too", () => {
    const s = createPreviewState("zero");
    s.run.sources[0].original_text = "fake";
    s.run.evidence[0].quote = "fake";
    s.run.evidence[0].end = 4;
    expect(() => parsePreviewState(s, "zero")).toThrow("损坏");
  });
  it("does not overwrite corrupt data", () => {
    const m = new MemoryStore();
    m.values.set(storageKey("zero"), "{broken");
    expect(loadPreview(m, "zero").kind).toBe("corrupt");
    const s = createPreviewState("zero");
    expect(() => commitPreview(m, s, command(s, { type: "branch" }))).toThrow("损坏");
    expect(m.getItem(storageKey("zero"))).toBe("{broken");
  });
  it("reports write failure and allows the same uncommitted command to retry", () => {
    const m = new MemoryStore();
    const s = createPreviewState("zero");
    const cmd = command(s, { type: "branch" });
    m.fail = true;
    expect(() => commitPreview(m, s, cmd)).toThrow(StorageWriteError);
    expect(m.getItem(storageKey("zero"))).toBe(null);
    m.fail = false;
    const n = commitPreview(m, s, cmd);
    expect(currentReport(n).version).toBe(2);
    expect(commitPreview(m, n, cmd)).toEqual(n);
  });
  it("rereads latest state before applying an old tab command", () => {
    const m = new MemoryStore();
    const s = createPreviewState("zero");
    commitPreview(m, s, command(s, { type: "branch" }));
    expect(() => commitPreview(m, s, command(s, { type: "finish" }))).toThrow("另一处更新");
  });
  it("isolates reset and export from other cases and credentials", () => {
    const m = new MemoryStore();
    m.values.set("access-token", "never-export");
    const f = createPreviewState("fire");
    commitPreview(m, f, command(f, { type: "branch" }));
    const before = m.getItem(storageKey("fire"));
    resetPreview(m, "zero");
    expect(m.getItem(storageKey("fire"))).toBe(before);
    expect(m.getItem("access-token")).toBe("never-export");
    expect(exportPreview(createPreviewState("zero"))).not.toContain("never-export");
  });
  it("persists drafts and parsed state without network", () => {
    const m = new MemoryStore();
    const s = createPreviewState("zero");
    commitPreview(m, s, command(s, { type: "draft", question_id: "zero-q1", text: "未提交草稿" }));
    const read = loadPreview(m, "zero");
    expect(read.kind).toBe("ready");
    if (read.kind === "ready") expect(read.state.drafts["zero-q1"]).toBe("未提交草稿");
  });
});

describe("C1 coherent counterexample continuation", () => {
  it.each(CASE_IDS)("updates %s scope, next question, proposal and falsifier together", (id) => {
    const initial = createPreviewState(id);
    const old = structuredClone(currentReport(initial));
    const next = apply(initial, { type: "branch" });
    const report = currentReport(next);
    expect(report.findings[0].scope).not.toBe(old.findings[0].scope);
    expect(report.findings[0].would_change).not.toBe(old.findings[0].would_change);
    expect(report.questions[0].id).toBe(`${id}-q-after-counterexample`);
    expect(report.questions[0].text).not.toBe(old.questions[0].text);
    expect(report.proposals[0].step).not.toBe(old.proposals[0].step);
    expect(report.proposals[0].interpretation).not.toBe(old.proposals[0].interpretation);
    expect(next.run.reports[0]).toEqual(old);
    expect(() =>
      apply(next, {
        type: "answer",
        question_id: `${id}-q1`,
        kind: "sample_answer",
        branch_id: old.questions[0].branches[0].id,
      }),
    ).toThrow("不属于");
  });
  it.each(CASE_IDS)("keeps %s counterevidence after a new followup answer and reload", (id) => {
    const prior = apply(createPreviewState(id), { type: "branch" });
    const question = currentReport(prior).questions[0];
    const next = apply(prior, {
      type: "answer",
      question_id: question.id,
      kind: "sample_answer",
      branch_id: question.branches[0].id,
    });
    expect(currentReport(next).summary.text).toBe(currentReport(prior).summary.text);
    expect(currentReport(next).findings[0].text).toContain(currentReport(prior).findings[0].text);
    expect(
      currentReport(next).findings[0].evidence.filter((e) => e.relation === "challenges"),
    ).toEqual(currentReport(prior).findings[0].evidence.filter((e) => e.relation === "challenges"));
    expect(currentReport(next).proposals[0].status).toBe("needs_review");
    expect(parsePreviewState(JSON.parse(JSON.stringify(next)), id)).toEqual(next);
  });
  it("does not restore a declined proposal when the counterexample changes its content", () => {
    const initial = apply(createPreviewState("rich"), {
      type: "decline_proposal",
      proposal_id: "rich-experiment",
    });
    const next = apply(initial, { type: "branch" });
    expect(currentReport(next).proposals[0].status).toBe("declined");
    expect(currentReport(next).proposals[0].step).not.toBe(
      currentReport(initial).proposals[0].step,
    );
  });
  it("does not offer an old action after an example answer rules out its opportunity", () => {
    const next = apply(createPreviewState("zero"), {
      type: "answer",
      question_id: "zero-q1",
      kind: "sample_answer",
      branch_id: "no-room",
    });
    expect(currentReport(next).summary.text).toContain("机会受限");
    expect(currentReport(next).proposals[0].status).toBe("needs_review");
  });
  it("keeps pending free text and prior answers while updating old persisted script branches", () => {
    let initial = apply(createPreviewState("rich"), {
      type: "answer",
      question_id: "rich-q1",
      kind: "free_text",
      text: "一段必须保留的补充",
    });
    initial = apply(initial, { type: "branch" });
    // Simulate a previously stored v1 branch: same evidence/history, old question still present.
    currentReport(initial).questions[0] = structuredClone(initial.run.reports[0].questions[0]);
    currentReport(initial).questions[0].targets[0].version =
      currentReport(initial).findings[0].version;
    const next = apply(initial, { type: "branch" });
    expect(next.run.feedback).toEqual(initial.run.feedback);
    expect(next.answered).toEqual(initial.answered);
    expect(currentReport(next).questions[0].id).toBe("rich-q-after-counterexample");
    expect(currentReport(next).summary.status).toBe("needs_review");
    expect(next.run.evidence.filter((e) => e.source_id === "H13")).toHaveLength(1);
  });
});

describe("C1 persisted script review fixes", () => {
  it("blocks legacy scripted answers before explicit continuation upgrade", () => {
    const legacy = apply(createPreviewState("rich"), { type: "branch" });
    currentReport(legacy).questions[0] = structuredClone(legacy.run.reports[0].questions[0]);
    currentReport(legacy).questions[0].targets[0].version =
      currentReport(legacy).findings[0].version;
    expect(parsePreviewState(legacy, "rich")).toBeDefined();
    expect(() =>
      apply(legacy, {
        type: "answer",
        question_id: "rich-q1",
        kind: "sample_answer",
        branch_id: "reduce",
      }),
    ).toThrow("旧演练问题");
    const free = apply(legacy, {
      type: "answer",
      question_id: "rich-q1",
      kind: "free_text",
      text: "旧窗口的补充",
    });
    expect(free.run.feedback[0].text).toBe("旧窗口的补充");
    expect(currentReport(apply(free, { type: "branch" })).summary.status).toBe("needs_review");
  });
  it("rejects altered persisted consequences without overwriting their recovery payload", () => {
    const state = createPreviewState("rich");
    currentReport(state).questions[0].branches[0].consequence = "伪造的确定性人格结论";
    const storage = new MemoryStore();
    const raw = JSON.stringify(state);
    storage.values.set(storageKey("rich"), raw);
    expect(loadPreview(storage, "rich").kind).toBe("corrupt");
    expect(storage.getItem(storageKey("rich"))).toBe(raw);
    expect(() =>
      apply(state, {
        type: "answer",
        question_id: "rich-q1",
        kind: "sample_answer",
        branch_id: "reduce",
      }),
    ).toThrow("损坏");
  });
});
