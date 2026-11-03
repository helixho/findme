import { DiagnosticRun } from "@findme/core";
import type { DiagnosticFeedback, DiagnosticFinding, ReportRevision } from "@findme/core";
import { followupQuestion, revisionScripts, sampleAnswerSource } from "./revision-scripts";
import { CASE_IDS, appendSource, createRun, scenarios } from "./scenarios";
import { required } from "./scenarios";
import type { CaseId } from "./scenarios";

export const PREVIEW_SCHEMA_VERSION = 1;
export type PreviewState = {
  schema_version: 1;
  case_id: CaseId;
  run: DiagnosticRun;
  applied_commands: { id: string; payload: string }[];
  branch_applied: boolean;
  drafts: Record<string, string>;
  answered: Record<string, string>;
  completed: boolean;
};
export type Action =
  | { type: "branch" }
  | { type: "draft"; question_id: string; text: string }
  | {
      type: "answer";
      question_id: string;
      kind: "sample_answer" | "free_text" | "unknown" | "skip";
      text?: string;
      branch_id?: string;
    }
  | {
      type: "finding_feedback";
      finding_id: string;
      kind: "contested" | "helpful" | "changed_now" | "narrower_scope";
      text: string;
    }
  | {
      type: "source_correction";
      source_id: string;
      kind: "excluded" | "not_mine" | "changed_now" | "narrower_scope";
      text: string;
    }
  | { type: "decline_proposal"; proposal_id: string }
  | { type: "finish" };
export type Command = { id: string; expectedVersion: number; report_id: string; action: Action };
export class PreviewError extends Error {
  constructor(
    public code: "stale" | "invalid" | "idempotency",
    message: string,
  ) {
    super(message);
  }
}
export function createPreviewState(caseId: CaseId): PreviewState {
  return {
    schema_version: 1,
    case_id: caseId,
    run: createRun(caseId),
    applied_commands: [],
    branch_applied: false,
    drafts: {},
    answered: {},
    completed: false,
  };
}
export function currentReport(state: PreviewState) {
  return required(state.run.reports.find((r) => r.id === state.run.current_report_id));
}
export function reportHistory(state: PreviewState) {
  return state.run.reports.map((r) => ({
    report: r,
    is_current: r.id === state.run.current_report_id,
    display_status: r.id === state.run.current_report_id ? r.status : "superseded",
  }));
}
export function latestAssessment(run: DiagnosticRun, sourceId: string) {
  return required(
    run.assessments
      .filter((a) => a.source_id === sourceId)
      .sort((a, b) => b.version - a.version)[0],
  );
}
function retarget(report: ReportRevision) {
  const refs = (targets: { finding_id: string; version: number }[]) =>
    targets.map((t) => ({
      ...t,
      version: required(report.findings.find((f) => f.id === t.finding_id)).version,
    }));
  report.summary.targets = refs(report.summary.targets);
  for (const q of report.questions) q.targets = refs(q.targets);
  for (const p of report.proposals) {
    p.targets = refs(p.targets);
    if (
      p.status !== "declined" &&
      p.targets.some(
        (t) => report.findings.find((f) => f.id === t.finding_id)?.status === "needs_review",
      )
    )
      p.status = "needs_review";
  }
  if (
    report.summary.targets.some(
      (t) => report.findings.find((f) => f.id === t.finding_id)?.status === "needs_review",
    )
  ) {
    report.summary.status = "needs_review";
    report.status = "needs_review";
  } else if (
    report.summary.targets.some(
      (t) => report.findings.find((f) => f.id === t.finding_id)?.status === "contested",
    )
  ) {
    report.summary.status = "contested";
    report.status = "contested";
  }
}
function revise(state: PreviewState, report: ReportRevision, reason: string, now: string) {
  const previous = currentReport(state);
  report.version = previous.version + 1;
  report.previous_report_id = previous.id;
  report.id = `${state.case_id}-report-${report.version}`;
  report.created_at = now;
  report.reason = reason;
  retarget(report);
  state.run.reports.push(report);
  state.run.current_report_id = report.id;
}
function pending(f: DiagnosticFinding) {
  f.version++;
  f.status = "needs_review";
  f.framework_grade = null;
}
function admissibleRefs(state: PreviewState, report: ReportRevision) {
  report.source_refs = state.run.sources
    .filter((s) =>
      ["eligible", "context_only"].includes(latestAssessment(state.run, s.id).eligibility),
    )
    .map((s) => ({
      source_id: s.id,
      version: s.version,
      assessment_version: latestAssessment(state.run, s.id).version,
    }));
  const allowed = new Set(
    report.source_refs
      .filter((s) => latestAssessment(state.run, s.source_id).eligibility === "eligible")
      .map((s) => s.source_id),
  );
  const contextAllowed = new Set(report.source_refs.map((s) => s.source_id));
  const validAtom = (id: string) =>
    allowed.has(required(state.run.evidence.find((e) => e.id === id)).source_id);
  for (const resource of report.resources)
    if (!resource.evidence_ids.every(validAtom)) resource.status = "needs_review";
  for (const area of report.coverage)
    if (!area.evidence_ids.every(validAtom)) {
      area.coverage = "unknown";
      area.note = "来源已更正或排除，此领域覆盖待复核，不代表发展低。";
    }
  for (const f of report.findings) {
    const before = f.evidence.length;
    f.evidence = f.evidence.filter((ref) =>
      (ref.relation === "contextualizes" ? contextAllowed : allowed).has(
        required(state.run.evidence.find((e) => e.id === ref.evidence_id)).source_id,
      ),
    );
    f.required_evidence_ids = f.required_evidence_ids.filter((id) =>
      f.evidence.some((e) => e.evidence_id === id),
    );
    if (f.evidence.length !== before) {
      if (f.status !== "needs_review") pending(f);
      f.evidence_sufficiency = f.evidence.some((e) => e.relation === "supports")
        ? "partial"
        : "insufficient";
    }
  }
}
export function applyCommand(
  original: PreviewState,
  command: Command,
  now = new Date().toISOString(),
): PreviewState {
  parsePreviewState(original, original.case_id);
  if (!command.id || !Number.isSafeInteger(command.expectedVersion))
    throw new PreviewError("invalid", "操作编号与版本必填。");
  const payload = JSON.stringify({ report_id: command.report_id, action: command.action });
  const prior = original.applied_commands.find((c) => c.id === command.id);
  if (prior) {
    if (prior.payload !== payload)
      throw new PreviewError("idempotency", "同一操作编号不能对应不同内容。");
    return original;
  }
  if (
    original.run.version !== command.expectedVersion ||
    currentReport(original).id !== command.report_id
  )
    throw new PreviewError(
      "stale",
      "预览已在另一处更新；已读取最新版本，请检查后重新提交。输入仍保留。",
    );
  const state = structuredClone(original);
  const oldReport = currentReport(state);
  const report = structuredClone(oldReport);
  const a = command.action;
  const feedback = (
    kind: DiagnosticFeedback["kind"],
    text: string,
    targets = report.summary.targets,
    analysis_status: DiagnosticFeedback["analysis_status"] = "recorded",
  ) => {
    state.run.feedback.push({
      id: command.id,
      report_id: oldReport.id,
      targets: structuredClone(targets),
      kind,
      text,
      analysis_status,
      created_at: now,
    });
  };
  const question = (id: string) => {
    const q = report.questions.find((q) => q.id === id);
    if (!q) throw new PreviewError("invalid", "问题不属于这份报告。");
    return q;
  };
  const getFinding = (id: string) => {
    const f = report.findings.find((f) => f.id === id);
    if (!f) throw new PreviewError("invalid", "判断不属于这份报告。");
    return f;
  };
  switch (a.type) {
    case "draft": {
      question(a.question_id);
      if (typeof a.text !== "string" || a.text.length > 5000)
        throw new PreviewError("invalid", "草稿最多 5000 字。");
      state.drafts[a.question_id] = a.text;
      break;
    }
    case "answer": {
      const q = question(a.question_id);
      if (state.answered[q.id])
        throw new PreviewError("invalid", "此问题已经回应；原型不自动覆盖旧回答。");
      if (a.kind === "free_text") {
        if (!a.text?.trim() || a.text.length > 5000)
          throw new PreviewError("invalid", "请输入要保存的内容，最多 5000 字。");
        feedback("free_text", a.text, q.targets, "pending");
        state.drafts[q.id] = a.text;
        for (const t of q.targets) pending(getFinding(t.finding_id));
        revise(state, report, "保存自由文本：待分析，原型未调用模型。", now);
      } else if (a.kind === "sample_answer") {
        if (
          state.branch_applied &&
          q.targets.some((t) => t.finding_id === `${state.case_id}-f1`) &&
          q.id !== `${state.case_id}-q-after-counterexample`
        )
          throw new PreviewError(
            "stale",
            "旧演练问题已被反例取代，请先更新问题与建议。原有文字与反馈仍保留。",
          );
        const branch = q.branches.find((b) => b.id === a.branch_id);
        if (!branch) throw new PreviewError("invalid", "没有这个演示回答。");
        feedback(
          "sample_answer",
          `加载虚构演示回答：${branch.sample_answer}`,
          q.targets,
          "scripted",
        );
        const source = sampleAnswerSource(q, branch, now);
        appendSource(state.run, source);
        const sourceId = source.id;
        const f = getFinding(required(q.targets[0]).finding_id);
        f.version++;
        f.text = `${f.text}

补问演示回答：“${branch.sample_answer}”。${branch.consequence}`;
        f.evidence.push({ evidence_id: `${sourceId}-quote`, relation: "supports" });
        if (
          !q.id.endsWith("-q-after-counterexample") &&
          q.targets.some((t) => report.summary.targets.some((s) => s.finding_id === t.finding_id))
        )
          report.summary.text = `演示分支：${branch.consequence}`;
        for (const p of report.proposals) {
          if (
            p.status === "offered" &&
            p.targets.some((t) => q.targets.some((target) => target.finding_id === t.finding_id))
          )
            p.status = "needs_review";
        }
        admissibleRefs(state, report);
        revise(
          state,
          report,
          "选择脚本示例回答；保留原证据与反例，相关建议待复核，不是本人事实确认。",
          now,
        );
      } else if (a.kind === "skip" || a.kind === "unknown") {
        feedback(
          a.kind,
          a.kind === "skip" ? "跳过此问，不扣分，不补造答案。" : "不知道，保留未知，不扣分。",
          q.targets,
        );
      } else throw new PreviewError("invalid", "未知回答类型。");
      state.answered[q.id] = a.kind;
      break;
    }
    case "branch": {
      if (
        state.branch_applied &&
        report.questions.some((q) => q.id === `${state.case_id}-q-after-counterexample`)
      )
        return original;
      const c = scenarios[state.case_id];
      const script = revisionScripts[state.case_id];
      appendSource(state.run, structuredClone(c.later));
      const f = required(report.findings[0]);
      f.version++;
      f.title = c.branchHeadline;
      f.text = c.branchText;
      f.scope = script.scope;
      f.would_change = script.wouldChange;
      if (!f.evidence.some((e) => e.evidence_id === `${c.later.id}-quote`))
        f.evidence.push({ evidence_id: `${c.later.id}-quote`, relation: "challenges" });
      // Retire the answered/obsolete uncertainty instead of asking it again.
      report.questions = [
        followupQuestion(state.case_id, f.version),
        ...report.questions.filter((q) => !q.targets.some((t) => t.finding_id === f.id)),
      ];
      for (const p of report.proposals) {
        if (p.targets.some((t) => t.finding_id === f.id))
          Object.assign(p, structuredClone(script.proposal));
      }
      f.alternatives =
        state.case_id === "zero"
          ? ["协调的任务类型", "成果反馈", "负荷与权限"]
          : state.case_id === "fire"
            ? ["掌握与创造", "可见成果", "可选的关系资源"]
            : ["个人担忧", "检查习惯", "待辨别的竞争承诺"];
      report.summary.text = c.branchHeadline;
      // A scripted counterexample does not resolve prior attribution corrections or pending free text.
      admissibleRefs(state, report);
      state.branch_applied = true;
      revise(
        state,
        report,
        `R0 演练脚本 v2：反例 ${c.later.id} 同时修订判断、范围、下一问题与建议；不是用户自述。`,
        now,
      );
      break;
    }
    case "source_correction": {
      const s = state.run.sources.find((s) => s.id === a.source_id);
      if (
        !s ||
        !report.findings.some((f) =>
          f.evidence.some(
            (e) => state.run.evidence.find((x) => x.id === e.evidence_id)?.source_id === s.id,
          ),
        )
      )
        throw new PreviewError("invalid", "来源不属于当前判断的证据。");
      if (
        !["excluded", "not_mine", "changed_now", "narrower_scope"].includes(a.kind) ||
        !a.text.trim()
      )
        throw new PreviewError("invalid", "请说明来源纠正。");
      const affected = report.findings.filter((f) =>
        f.evidence.some(
          (e) => state.run.evidence.find((x) => x.id === e.evidence_id)?.source_id === s.id,
        ),
      );
      feedback(
        a.kind,
        `${s.id}：${a.text}`,
        affected.map((f) => ({ finding_id: f.id, version: f.version })),
        a.kind === "excluded" || a.kind === "not_mine" ? "recorded" : "pending",
      );
      const last = latestAssessment(state.run, s.id);
      state.run.assessments.push({
        source_id: s.id,
        source_version: s.version,
        version: last.version + 1,
        eligibility: a.kind === "excluded" || a.kind === "not_mine" ? "excluded" : last.eligibility,
        correction: a.kind,
        note: a.text,
        effective_at: now,
      });
      for (const f of affected) pending(f);
      admissibleRefs(state, report);
      if (a.kind === "changed_now")
        report.constraints.push("原事件时间保留；现在变化为本机反馈，尚未分析。");
      if (a.kind === "narrower_scope")
        report.constraints.push(`用户限制使用范围：${a.text}。未自动验证其语义。`);
      revise(
        state,
        report,
        `来源 ${s.id}：${a.kind === "not_mine" ? "归属纠正并排除" : a.kind === "excluded" ? "排除" : "时段/范围待复核"}。只影响依赖判断。`,
        now,
      );
      break;
    }
    case "finding_feedback": {
      const f = getFinding(a.finding_id);
      if (
        !["contested", "helpful", "changed_now", "narrower_scope"].includes(a.kind) ||
        !a.text.trim()
      )
        throw new PreviewError("invalid", "请说明判断反馈。");
      feedback(
        a.kind,
        a.text,
        [{ finding_id: f.id, version: f.version }],
        a.kind === "changed_now" || a.kind === "narrower_scope" ? "pending" : "recorded",
      );
      if (a.kind === "helpful") break; // usefulness never upgrades evidence sufficiency
      if (a.kind === "contested") {
        f.version++;
        if (f.status !== "needs_review") f.status = "contested";
      } else {
        pending(f);
        report.constraints.push(
          a.kind === "changed_now"
            ? "以前的事件仍保留；现在变化待分析。"
            : `用户限制：${a.text}。原型未自动验证范围语义。`,
        );
      }
      revise(
        state,
        report,
        a.kind === "contested" ? "解释存在争议，未判为已推翻。" : "时段或范围变化，待分析。",
        now,
      );
      break;
    }
    case "decline_proposal": {
      const p = report.proposals.find((p) => p.id === a.proposal_id);
      if (!p) throw new PreviewError("invalid", "建议不属于这份报告。");
      p.status = "declined";
      revise(state, report, "不采用可选实验；没有创建任务。", now);
      break;
    }
    case "finish":
      state.completed = true;
      break;
    default:
      throw new PreviewError("invalid", "未知操作。");
  }
  state.run.version++;
  state.applied_commands.push({ id: command.id, payload });
  return parsePreviewState(state, state.case_id);
}

export function parsePreviewState(value: unknown, expectedCase: CaseId): PreviewState {
  const invalid = () => {
    throw new PreviewError("invalid", "本机数据损坏或版本不兼容。请导出后重置本例；没有静默丢弃。");
  };
  if (!value || typeof value !== "object") return invalid();
  const s = value as PreviewState;
  if (
    s.schema_version !== PREVIEW_SCHEMA_VERSION ||
    s.case_id !== expectedCase ||
    !CASE_IDS.includes(s.case_id) ||
    typeof s.branch_applied !== "boolean" ||
    typeof s.completed !== "boolean"
  )
    return invalid();
  const parsed = DiagnosticRun.safeParse(s.run);
  if (
    !parsed.success ||
    parsed.data.id !== `${expectedCase}-run` ||
    parsed.data.subject_kind !== "synthetic"
  )
    return invalid();
  const run = parsed.data;
  const scriptedQuestions = [
    ...required(createRun(expectedCase).reports[0]).questions,
    followupQuestion(expectedCase, 1),
  ];
  for (const report of run.reports) {
    for (const question of report.questions) {
      const known = scriptedQuestions.find((q) => q.id === question.id);
      if (!known) return invalid();
      const shape = (q: typeof question) => ({ ...q, targets: q.targets.map((t) => t.finding_id) });
      if (JSON.stringify(shape(question)) !== JSON.stringify(shape(known))) return invalid();
    }
  }
  const questions = new Set(run.reports.flatMap((r) => r.questions.map((q) => q.id)));
  const stringRecord = (x: unknown) =>
    x &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Object.entries(x).every(
      ([k, v]) => questions.has(k) && typeof v === "string" && v.length <= 5000,
    );
  if (
    !stringRecord(s.drafts) ||
    !stringRecord(s.answered) ||
    Object.values(s.answered).some(
      (v) => !["sample_answer", "free_text", "skip", "unknown"].includes(v),
    )
  )
    return invalid();
  if (
    !Array.isArray(s.applied_commands) ||
    s.applied_commands.some(
      (c) => !c || typeof c.id !== "string" || !c.id || typeof c.payload !== "string",
    ) ||
    new Set(s.applied_commands.map((c) => c.id)).size !== s.applied_commands.length
  )
    return invalid();
  if (run.version !== s.applied_commands.length + 1) return invalid();
  // A persisted synthetic source is immutable too: modified source+quote pairs cannot pass as R0.
  const expectedSources = [
    ...scenarios[expectedCase].sources,
    ...(s.branch_applied ? [scenarios[expectedCase].later] : []),
  ];
  for (const source of expectedSources) {
    const actual = run.sources.find((x) => x.id === source.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(source)) return invalid();
  }
  for (const source of run.sources) {
    if (expectedSources.some((x) => x.id === source.id)) continue;
    const q = scriptedQuestions.find((q) =>
      q.branches.some((b) => `${q.id}-${b.id}` === source.id),
    );
    const branch = q?.branches.find((b) => `${q.id}-${b.id}` === source.id);
    if (
      !q ||
      !branch ||
      JSON.stringify(source) !== JSON.stringify(sampleAnswerSource(q, branch, source.reported_at))
    )
      return invalid();
  }
  return {
    schema_version: 1,
    case_id: expectedCase,
    run,
    applied_commands: s.applied_commands,
    branch_applied: s.branch_applied,
    drafts: s.drafts,
    answered: s.answered,
    completed: s.completed,
  };
}
