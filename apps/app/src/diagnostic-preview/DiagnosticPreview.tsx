import type { DiagnosticFinding, ReportRevision } from "@findme/core";
import {
  ArrowUpRight,
  BookOpenText,
  Check,
  ChevronRight,
  Download,
  History,
  MessageSquareText,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../../../../assets/brand/v0.1.0/logo/findme-mark.svg?url";
import { CASE_IDS, scenarios } from "./scenarios";
import type { CaseId } from "./scenarios";
import { createPreviewState, currentReport, latestAssessment, reportHistory } from "./state";
import type { Action, Command, PreviewState } from "./state";
import {
  StorageWriteError,
  commitPreview,
  exportPreview,
  loadPreview,
  resetPreview,
  storageKey,
} from "./storage";
import type { LoadResult, PreviewStorage } from "./storage";
import "./preview.css";
const store: PreviewStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};
const words: Record<string, string> = {
  candidate: "待检验的判断",
  current: "当前判断",
  needs_review: "待复核",
  contested: "存在异议",
  superseded: "历史版本",
  supports: "支持材料",
  challenges: "反例 / 限定",
  contextualizes: "必要背景",
  subject: "案例本人",
  assistant: "AI",
  third_party: "他人",
  mixed: "混合 / 含转发",
  unknown: "未知",
  reported: "本人报告",
  endorsed: "明确认可",
  not_endorsed: "不背书",
  opposed: "明确反对",
  partial: "有限材料",
  sufficient_for_scope: "限于此范围的依据",
  insufficient: "依据不足",
  eligible: "可作候选依据",
  context_only: "仅作背景",
  excluded: "已排除",
  observed: "已有材料",
};
const label = (value: string) => words[value] ?? value;
type Basis = { version: number; reportId: string };
type Overlay =
  | { type: "evidence" | "feedback"; findingId: string; basis: Basis }
  | { type: "history" | "reset" };
const scratchKey = (caseId: CaseId, id: string) => `findme:c1:tab-draft:${caseId}:${id}`;
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function DiagnosticPreview() {
  const requested = new URLSearchParams(location.search).get("case");
  const [caseId, setCaseId] = useState<CaseId>(
    CASE_IDS.includes(requested as CaseId) ? (requested as CaseId) : "zero",
  );
  const [loaded, setLoaded] = useState<LoadResult>(() => loadPreview(store, caseId));
  const [state, setState] = useState<PreviewState>(() =>
    loaded.kind === "ready" ? loaded.state : createPreviewState(caseId),
  );
  const [modal, setModal] = useState<Overlay | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    command: Command;
    base: PreviewState;
    snapshot: PreviewState;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftWarning, setDraftWarning] = useState("");
  const [feedbackKind, setFeedbackKind] = useState<
    "contested" | "helpful" | "changed_now" | "narrower_scope"
  >("contested");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const next = loadPreview(store, caseId);
    setLoaded(next);
    if (next.kind === "ready") setState(next.state);
  }, [caseId]);
  useEffect(() => {
    const next = loadPreview(store, caseId);
    setLoaded(next);
    setState(next.kind === "ready" ? next.state : createPreviewState(caseId));
    setNotice("");
    setError("");
    setModal(null);
    setHistoryId(null);
  }, [caseId]);
  useEffect(() => {
    const listener = (e: StorageEvent) => {
      if (e.key === storageKey(caseId)) {
        refresh();
        setNotice("另一标签页更新了本例；已读取最新报告，当前草稿仍保留。");
      }
    };
    addEventListener("storage", listener);
    return () => removeEventListener("storage", listener);
  }, [caseId, refresh]);
  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (!modal && dialog.current?.open) dialog.current?.close();
  }, [modal]);
  const report = currentReport(state);
  const currentCase = scenarios[caseId];
  const branchIsCurrent =
    state.branch_applied &&
    report.questions.some((q) => q.id === `${caseId}-q-after-counterexample`);
  const disabled = busy || pending !== null || loaded.kind !== "ready" || state.case_id !== caseId;
  function draft(id: string) {
    const key = `${caseId}:${id}`;
    if (Object.hasOwn(drafts, key)) return drafts[key];
    try {
      return sessionStorage.getItem(scratchKey(caseId, id)) ?? state.drafts[id] ?? "";
    } catch {
      return state.drafts[id] ?? "";
    }
  }
  function editDraft(id: string, text: string) {
    setDrafts((values) => ({ ...values, [`${caseId}:${id}`]: text }));
    try {
      sessionStorage.setItem(scratchKey(caseId, id), text);
      setDraftWarning("");
    } catch {
      setDraftWarning("草稿仅保留在当前页面内存；本机存储不可用，请复制或导出后再离开。");
    }
  }
  function openModal(value: Overlay) {
    returnFocus.current = document.activeElement as HTMLElement;
    setModal(value);
  }
  function closeModal() {
    setModal(null);
    dialog.current?.close();
    returnFocus.current?.focus();
  }
  const basis = (): Basis => ({ version: state.run.version, reportId: report.id });
  async function commit(command: Command, base: PreviewState) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!navigator.locks)
        throw new Error(
          "当前浏览器缺少本机互斥保存支持；请使用支持 Web Locks 的浏览器预览。内容尚未写入。",
        );
      const next = await navigator.locks.request(storageKey(base.case_id), () =>
        commitPreview(store, base, command),
      );
      setState(next);
      setLoaded({ kind: "ready", state: next, saved: true });
      setPending(null);
      setNotice(
        command.action.type === "answer" && command.action.kind === "free_text"
          ? "补充已在本机保存，待分析；本原型没有调用模型。"
          : "已保存到本机预览。不是云端个人档案。",
      );
      return true;
    } catch (cause) {
      if (cause instanceof StorageWriteError) {
        setPending({ command, base, snapshot: cause.unsaved });
        setError(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : "操作未完成。");
        refresh();
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function act(action: Action, at: Basis = basis()) {
    if (disabled) return false;
    return commit(
      { id: crypto.randomUUID(), expectedVersion: at.version, report_id: at.reportId, action },
      state,
    );
  }
  function chooseCase(id: CaseId) {
    if (busy || pending) return;
    const next = loadPreview(store, id);
    setCaseId(id);
    setLoaded(next);
    setState(next.kind === "ready" ? next.state : createPreviewState(id));
    setNotice("");
    setError("");
    setModal(null);
    setHistoryId(null);
    const url = new URL(location.href);
    url.searchParams.set("case", id);
    history.replaceState(null, "", url);
  }
  function exportState() {
    try {
      const text =
        loaded.kind === "corrupt"
          ? loaded.raw
          : JSON.stringify(
              {
                ...JSON.parse(exportPreview(pending?.snapshot ?? state)),
                tab_drafts: Object.fromEntries(
                  [
                    ...new Set([
                      ...state.run.reports.flatMap((r) => r.questions.map((q) => q.id)),
                      ...report.findings.map((f) => `feedback:${f.id}`),
                    ]),
                  ]
                    .map((id) => [id, draft(id)])
                    .filter(([, text]) => Boolean(text)),
                ),
                unsaved: pending !== null,
              },
              null,
              2,
            );
      download(text, `findme-c1-${caseId}${loaded.kind === "corrupt" ? "-recovery" : ""}.json`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出未完成。");
    }
  }
  async function reset() {
    setBusy(true);
    try {
      if (!navigator.locks) throw new Error("当前浏览器不支持安全保存。");
      const next = await navigator.locks.request(storageKey(caseId), () =>
        resetPreview(store, caseId),
      );
      setState(next);
      setLoaded({ kind: "ready", state: next, saved: true });
      setPending(null);
      setDrafts((values) =>
        Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(`${caseId}:`))),
      );
      for (const id of [
        ...new Set([
          ...state.run.reports.flatMap((r) => r.questions.map((q) => q.id)),
          ...report.findings.map((f) => `feedback:${f.id}`),
        ]),
      ]) {
        try {
          sessionStorage.removeItem(scratchKey(caseId, id));
        } catch {
          /* Existing local-only scratch remains; never clear other storage. */
        }
      }
      setError("");
      setNotice("已重置当前合成示例；其他示例和实际档案不受影响。");
      closeModal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重置失败，原内容仍保留。");
    } finally {
      setBusy(false);
    }
  }
  const activeQuestion = report.questions.find((q) => !state.answered[q.id]);
  const historical = state.run.reports.find((r) => r.id === historyId) ?? report;
  const overlayReport =
    modal && (modal.type === "evidence" || modal.type === "feedback")
      ? (state.run.reports.find((r) => r.id === modal.basis.reportId) ?? report)
      : report;
  const overlayFinding =
    modal && (modal.type === "evidence" || modal.type === "feedback")
      ? overlayReport.findings.find((f) => f.id === modal.findingId)
      : null;
  function findingCard(f: DiagnosticFinding) {
    return (
      <article
        className={`dp-finding ${f.status === "needs_review" ? "dp-pending" : ""}`}
        key={f.id}
        data-finding={f.id}
      >
        <div className="dp-card-kicker">
          <span>
            0{f.priority} / {label(f.status)}
          </span>
          <span>{label(f.evidence_sufficiency)}</span>
        </div>
        <h3>{f.status === "needs_review" ? "这项判断的依据需要复核" : f.title}</h3>
        <p>
          {f.status === "needs_review"
            ? "新的补充或来源纠正已影响这项判断。原型保留原文与历史，但不会把旧解释继续当作有效结论。"
            : f.text}
        </p>
        <p className="dp-scope">适用范围 · {f.scope}</p>
        {f.status !== "needs_review" && (
          <details className="dp-detail">
            <summary>还有哪些解释？什么会改变判断？</summary>
            <p>{f.alternatives.join("；")}</p>
            <p>
              <strong>检验条件：</strong>
              {f.would_change}
            </p>
          </details>
        )}
        <div className="dp-actions">
          <button
            type="button"
            onClick={() => openModal({ type: "evidence", findingId: f.id, basis: basis() })}
          >
            <BookOpenText size={16} />
            查看依据
          </button>
          <button
            type="button"
            onClick={() => {
              setFeedbackKind("contested");
              openModal({ type: "feedback", findingId: f.id, basis: basis() });
            }}
          >
            <MessageSquareText size={16} />
            纠正或补充
          </button>
        </div>
      </article>
    );
  }
  return (
    <div className="dp-root" data-case={state.case_id}>
      <header className="dp-header">
        <div className="dp-brand">
          <img src={logo} width="32" height="32" alt="" />
          <strong>
            Find<span>Me</span>
          </strong>
          <span className="dp-brand-caption">看清自己。</span>
        </div>
        <div className="dp-header-actions">
          <button
            type="button"
            onClick={() => {
              setHistoryId(null);
              openModal({ type: "history" });
            }}
          >
            <History size={17} />
            <span>修订记录</span>
          </button>
          <button type="button" onClick={exportState} aria-label="导出本例">
            <Download size={17} />
            <span>导出</span>
          </button>
        </div>
      </header>
      <div className="dp-preview-banner">
        <span className="dp-dot" />
        合成示例 · 非本人诊断 · 本机预览
        <details>
          <summary>预览边界</summary>
          <p>
            示例事实与反例均预先编写，用于体验诊断如何被证据修正。自由文字只在本机保存为待分析材料；没有模型调用、账号登录或云端同步，也不是
            HUMAN 3.0 原版测评。
          </p>
        </details>
      </div>
      <main className="dp-main">
        <nav className="dp-case-nav" aria-label="选择合成场景">
          {CASE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={caseId === id}
              disabled={busy || pending !== null}
              onClick={() => chooseCase(id)}
            >
              <span>{scenarios[id].label}</span>
              <small>{scenarios[id].subtitle}</small>
            </button>
          ))}
        </nav>
        {loaded.kind !== "ready" && (
          <div className="dp-alert" role="alert">
            <strong>当前仅展示参考示例，未覆盖已存内容。</strong>
            <p>{loaded.message}</p>
            <button type="button" onClick={exportState}>
              导出现有内容
            </button>
            <button type="button" onClick={() => openModal({ type: "reset" })}>
              重置本例
            </button>
          </div>
        )}
        {error && (
          <div className="dp-alert" role="alert">
            {error}
            {pending && (
              <div className="dp-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void commit(pending.command, pending.base)}
                >
                  重试保存
                </button>
                <button type="button" onClick={exportState}>
                  导出未保存内容
                </button>
              </div>
            )}
          </div>
        )}
        {notice && (
          <output className="dp-notice">
            <Check size={15} />
            {notice}
          </output>
        )}
        {draftWarning && (
          <p className="dp-alert" role="alert">
            {draftWarning}
          </p>
        )}
        <section className="dp-hero" aria-labelledby="diagnostic-headline">
          <div className="dp-eyebrow">
            当前诊断{" "}
            <span>
              v{report.version} · {label(report.summary.status)}
            </span>
          </div>
          <p className="dp-presented">你想理解 · {report.question}</p>
          <h1 id="diagnostic-headline">
            {report.summary.status === "needs_review"
              ? "关键材料已变化，先重新确认判断。"
              : report.summary.text}
          </h1>
          <p className="dp-hero-note">
            {report.summary.status === "needs_review"
              ? "已经停止把受影响的旧解释作为当前结论。查看依据或修订记录，保留尚未解决的部分。"
              : currentCase.scope}
          </p>
          <div className="dp-hero-foot">
            <span>初评，不是定论</span>
            <span>
              依据与反例可随时展开 <ArrowUpRight size={14} />
            </span>
          </div>
        </section>
        <div className="dp-grid">
          <div className="dp-primary">
            <div className="dp-section-title">
              <h2>先看这几件事</h2>
              <span>有轻重，也有边界</span>
            </div>
            {report.findings.map(findingCard)}
            <section className="dp-question" aria-labelledby="next-question">
              <span className="dp-eyebrow">继续理解 · 不必一次说完</span>
              {activeQuestion && !state.completed ? (
                <>
                  <h2 id="next-question">{activeQuestion.text}</h2>
                  <p>
                    {activeQuestion.target_uncertainty}。{activeQuestion.why_missing}
                  </p>
                  <details className="dp-detail">
                    <summary>演练示例回答（不是我的自述）</summary>
                    {state.branch_applied && !branchIsCurrent && (
                      <p>旧问题已被反例取代。请先更新问题与建议，已有文字与反馈不会丢失。</p>
                    )}
                    <div className="dp-sample-answers">
                      {activeQuestion.branches.map((branch) => (
                        <button
                          key={branch.id}
                          type="button"
                          disabled={disabled || (state.branch_applied && !branchIsCurrent)}
                          onClick={() =>
                            void act({
                              type: "answer",
                              question_id: activeQuestion.id,
                              kind: "sample_answer",
                              branch_id: branch.id,
                            })
                          }
                        >
                          {branch.sample_answer.replace(/^演示：/, "")}
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                  </details>
                  {state.branch_applied && !branchIsCurrent && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void act({ type: "branch" })}
                    >
                      更新问题与建议（保留已有记录）
                    </button>
                  )}
                  <label className="dp-input-label" htmlFor="free-answer">
                    或写下自己的补充
                  </label>
                  <textarea
                    id="free-answer"
                    value={draft(activeQuestion.id)}
                    maxLength={5000}
                    onChange={(e) => editDraft(activeQuestion.id, e.target.value)}
                    placeholder="这段文字仅保留在本机，待接入模型后再分析。"
                  />
                  <p className="dp-small">
                    未提交草稿保存在当前标签页；补充提交后保存在本机预览。不会上传。
                  </p>
                  <div className="dp-actions">
                    <button
                      type="button"
                      className="dp-primary-button"
                      disabled={disabled || !draft(activeQuestion.id).trim()}
                      onClick={() =>
                        void act({
                          type: "answer",
                          question_id: activeQuestion.id,
                          kind: "free_text",
                          text: draft(activeQuestion.id),
                        })
                      }
                    >
                      保存补充（待分析）
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        void act({
                          type: "answer",
                          question_id: activeQuestion.id,
                          kind: "unknown",
                        })
                      }
                    >
                      不知道
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        void act({ type: "answer", question_id: activeQuestion.id, kind: "skip" })
                      }
                    >
                      跳过
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 id="next-question">可以先停在这里。</h2>
                  <p>
                    {state.completed
                      ? "本次探索已结束，没有创建任务；现有判断和反馈仍保留。"
                      : "本轮问题已回应。无需为了完成报告继续填满每个生活领域。"}
                  </p>
                </>
              )}
            </section>
          </div>
          <aside className="dp-secondary">
            <section className="dp-side-card">
              <span className="dp-eyebrow">可以借助的资源</span>
              <h2>不是从零开始</h2>
              {report.resources.map((resource, i) => (
                <p
                  key={resource.text}
                  className={resource.status === "needs_review" ? "dp-muted" : "dp-resource"}
                  data-resource={i}
                >
                  {resource.status === "needs_review" ? (
                    `待复核 · ${resource.text}`
                  ) : (
                    <>
                      <Check size={16} />
                      {resource.text}
                    </>
                  )}
                </p>
              ))}
              <details className="dp-detail">
                <summary>现实条件与边界</summary>
                {report.constraints.map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </details>
            </section>
            {report.coverage.length > 0 && (
              <section className="dp-side-card">
                <span className="dp-eyebrow">整体盘点</span>
                <h2>材料覆盖，不是分数</h2>
                {report.coverage.map((area) => (
                  <div className="dp-coverage" key={area.area}>
                    <strong>{area.area}</strong>
                    <span>{label(area.coverage)}</span>
                    <p>{area.note}</p>
                  </div>
                ))}
              </section>
            )}
            <section className="dp-side-card dp-experiment">
              <span className="dp-eyebrow">下一步 · 自愿尝试</span>
              {report.proposals.map((p) => (
                <div key={p.id}>
                  <h2>
                    {p.status === "declined"
                      ? "这项建议已暂不采用"
                      : p.status === "needs_review"
                        ? "建议也需要一起复核"
                        : p.purpose}
                  </h2>
                  {p.status === "offered" ? (
                    <>
                      <p>{p.step}</p>
                      <details className="dp-detail">
                        <summary>观察什么，什么时候停止？</summary>
                        <p>{p.constraints}</p>
                        <p>{p.interpretation}</p>
                        <p>
                          <strong>停止条件：</strong>
                          {p.stop}
                        </p>
                        <p>
                          <strong>回顾：</strong>
                          {p.review}
                        </p>
                      </details>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void act({ type: "decline_proposal", proposal_id: p.id })}
                      >
                        暂不采用这项建议
                      </button>
                    </>
                  ) : (
                    <p>
                      {p.status === "declined"
                        ? "你的选择已保留，不会因后续纠正自动恢复建议，也没有创建任务。"
                        : "相关判断有新的补充或纠正。旧建议不继续作为当前推荐。"}
                    </p>
                  )}
                </div>
              ))}
              {!state.completed && (
                <button
                  type="button"
                  className="dp-finish"
                  disabled={disabled}
                  onClick={() => void act({ type: "finish" })}
                >
                  暂不改变，结束本次探索
                </button>
              )}
            </section>
            <section className="dp-side-card dp-branch">
              <span className="dp-eyebrow">体验一次真正的修订</span>
              <h2>新证据出现以后</h2>
              <p>加载这位虚构人物的一段后续经历，看主判断如何改变，并保留之前的版本。</p>
              <button
                type="button"
                className="dp-primary-button"
                disabled={disabled || branchIsCurrent}
                onClick={() => void act({ type: "branch" })}
              >
                {branchIsCurrent
                  ? "反例已加入，可查看修订记录"
                  : state.branch_applied
                    ? "更新反例后的问题与建议"
                    : "体验补充反例"}
                <ArrowUpRight size={16} />
              </button>
              <p className="dp-small">演练分支不是你的新自述，不会确认个人事实。</p>
            </section>
          </aside>
        </div>
        {state.run.feedback.length > 0 && (
          <details className="dp-feedback-log">
            <summary>已保存的回应与反馈 · {state.run.feedback.length}</summary>
            {state.run.feedback.map((f) => (
              <article key={f.id}>
                <strong>
                  {f.analysis_status === "pending"
                    ? "待分析"
                    : f.analysis_status === "scripted"
                      ? "合成演练"
                      : "已记录"}
                </strong>
                <p>{f.text || "保留未知"}</p>
                <small>
                  {f.analysis_status === "pending"
                    ? "原型未调用模型，未产生新的人格判断。"
                    : f.analysis_status === "scripted"
                      ? "预先编写的案例，不是本人确认。"
                      : "反馈不等于独立事实证据。"}
                </small>
              </article>
            ))}
          </details>
        )}
        <footer className="dp-footer">
          <span>FindMe · 理解可以改变，证据可以回看。</span>
          <button type="button" disabled={busy} onClick={() => openModal({ type: "reset" })}>
            <RotateCcw size={14} />
            重置本例
          </button>
        </footer>
      </main>
      <dialog
        ref={dialog}
        className="dp-dialog"
        aria-labelledby="dialog-title"
        onCancel={closeModal}
        onClose={() => {
          setModal(null);
          returnFocus.current?.focus();
        }}
      >
        <div className="dp-dialog-head">
          <h2 id="dialog-title">
            {modal?.type === "evidence"
              ? "为什么这样判断"
              : modal?.type === "feedback"
                ? "让理解更准确"
                : modal?.type === "history"
                  ? "认识如何变化"
                  : "重置当前示例"}
          </h2>
          <button type="button" aria-label="关闭弹层" onClick={closeModal}>
            <X size={20} />
          </button>
        </div>
        {modal &&
          (modal.type === "evidence" || modal.type === "feedback") &&
          modal.basis.version !== state.run.version && (
            <p className="dp-alert">
              报告已在别处更新；这里保留打开时版本。请关闭并重新打开后提交。
            </p>
          )}
        {modal?.type === "evidence" && overlayFinding && (
          <div className="dp-dialog-body">
            <p className="dp-muted">这是合成案例的可追溯材料，不是对你的个人诊断。</p>
            <h3>{overlayFinding.title}</h3>
            {overlayFinding.evidence.length === 0 && (
              <p>这项判断的可用依据已被撤销；旧引用可在历史版本查看。</p>
            )}
            {overlayFinding.evidence.map((ref) => {
              const e = state.run.evidence.find((e) => e.id === ref.evidence_id);
              const s =
                e &&
                state.run.sources.find(
                  (s) => s.id === e.source_id && s.version === e.source_version,
                );
              if (!e || !s) return null;
              const assessment = latestAssessment(state.run, s.id);
              return (
                <article key={e.id} className="dp-evidence" data-source={s.id}>
                  <div className="dp-card-kicker">
                    <span>{label(ref.relation)}</span>
                    <span>{label(assessment.eligibility)}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>提交者</dt>
                      <dd>{label(s.submitter)}</dd>
                    </div>
                    <div>
                      <dt>内容作者</dt>
                      <dd>{label(s.content_author)}</dd>
                    </div>
                    <div>
                      <dt>谈论对象</dt>
                      <dd>{label(s.about)}</dd>
                    </div>
                    <div>
                      <dt>表达立场</dt>
                      <dd>{label(s.stance)}</dd>
                    </div>
                  </dl>
                  <blockquote>
                    {s.original_text.slice(0, e.start)}
                    <mark>{s.original_text.slice(e.start, e.end)}</mark>
                    {s.original_text.slice(e.end)}
                  </blockquote>
                  <small>
                    {s.id} · {s.occurred_at} · 原始版本 {s.version}
                  </small>
                  {assessment.correction !== "initial" && (
                    <p className="dp-muted">更正：{assessment.note}</p>
                  )}
                  <div className="dp-actions">
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        modal.basis.version !== state.run.version ||
                        assessment.eligibility === "excluded"
                      }
                      onClick={() =>
                        void act(
                          {
                            type: "source_correction",
                            source_id: s.id,
                            kind: "not_mine",
                            text: "演练：这段不是案例本人的表达，停止作为本人依据。",
                          },
                          modal.basis,
                        ).then((ok) => {
                          if (ok) closeModal();
                        })
                      }
                    >
                      不是本人的表达
                    </button>
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        modal.basis.version !== state.run.version ||
                        assessment.eligibility === "excluded"
                      }
                      onClick={() =>
                        void act(
                          {
                            type: "source_correction",
                            source_id: s.id,
                            kind: "excluded",
                            text: "演练：将此来源排除出当前分析。",
                          },
                          modal.basis,
                        ).then((ok) => {
                          if (ok) closeModal();
                        })
                      }
                    >
                      不用于分析
                    </button>
                  </div>
                </article>
              );
            })}
            <p className="dp-small">
              材料能被定位，不等于解释已经成立。方法：{state.run.method.id} ·{" "}
              {state.run.method.adaptation_notes}
            </p>
          </div>
        )}
        {modal?.type === "feedback" && overlayFinding && (
          <form
            className="dp-dialog-body"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                {
                  type: "finding_feedback",
                  finding_id: overlayFinding.id,
                  kind: feedbackKind,
                  text: draft(`feedback:${overlayFinding.id}`),
                },
                modal.basis,
              ).then((ok) => {
                if (ok) closeModal();
              });
            }}
          >
            <p>{overlayFinding.title}</p>
            <label className="dp-input-label" htmlFor="feedback-type">
              这次需要怎样调整？
            </label>
            <select
              id="feedback-type"
              value={feedbackKind}
              onChange={(e) => setFeedbackKind(e.target.value as typeof feedbackKind)}
            >
              <option value="contested">我不同意这个解释</option>
              <option value="narrower_scope">只在某种情境下成立</option>
              <option value="changed_now">以前如此，现在不同</option>
              <option value="helpful">这项判断有帮助</option>
            </select>
            <label className="dp-input-label" htmlFor="feedback-note">
              具体补充
            </label>
            <textarea
              id="feedback-note"
              value={draft(`feedback:${overlayFinding.id}`)}
              maxLength={5000}
              onChange={(e) => editDraft(`feedback:${overlayFinding.id}`, e.target.value)}
              placeholder="可以指出哪一处不准确，或补充当时的条件。"
            />
            <p className="dp-small">
              异议不等于已证伪；认可也不增加证据。自由文字只保存为反馈，不运行模型重评。
            </p>
            <button
              className="dp-primary-button"
              type="submit"
              disabled={
                disabled ||
                modal.basis.version !== state.run.version ||
                !draft(`feedback:${overlayFinding.id}`).trim()
              }
            >
              保存反馈
            </button>
          </form>
        )}
        {modal?.type === "history" && (
          <div className="dp-dialog-body">
            <p className="dp-muted">
              旧版本保留当时的理解，不作为当前有效诊断。新版本不会改写旧原文。
            </p>
            <div className="dp-version-list">
              {reportHistory(state).map((item) => (
                <button
                  type="button"
                  key={item.report.id}
                  aria-pressed={historical.id === item.report.id}
                  onClick={() => setHistoryId(item.report.id)}
                >
                  v{item.report.version} · {item.is_current ? "当前版本" : "历史版本"}
                </button>
              ))}
            </div>
            <article className="dp-history-report">
              <span className="dp-eyebrow">
                v{historical.version} ·{" "}
                {historical.id === report.id ? "当前版本" : "非当前，仅供回看"}
              </span>
              <h3>{historical.summary.text}</h3>
              <p className="dp-history-reason">修订原因：{historical.reason}</p>
              {historical.findings.map((f) => (
                <section key={f.id}>
                  <h4>{f.title}</h4>
                  <p>{f.text}</p>
                  <small>
                    {f.scope} · {label(f.status)}
                  </small>
                  <details className="dp-detail">
                    <summary>当时使用的依据（只读）</summary>
                    {f.evidence.map((ref) => {
                      const e = state.run.evidence.find((item) => item.id === ref.evidence_id);
                      const source =
                        e &&
                        state.run.sources.find(
                          (item) => item.id === e.source_id && item.version === e.source_version,
                        );
                      if (!e || !source) return null;
                      const assessment = latestAssessment(state.run, source.id);
                      return (
                        <article className="dp-evidence" key={e.id} data-history-source={source.id}>
                          <small>
                            {source.id} · {label(ref.relation)} · 现在：
                            {label(assessment.eligibility)}
                          </small>
                          <blockquote>
                            {source.original_text.slice(0, e.start)}
                            <mark>{e.quote}</mark>
                            {source.original_text.slice(e.end)}
                          </blockquote>
                          <p className="dp-small">历史引用只说明当时依据，不恢复当前使用资格。</p>
                        </article>
                      );
                    })}
                  </details>
                </section>
              ))}
            </article>
          </div>
        )}
        {modal?.type === "reset" && (
          <div className="dp-dialog-body">
            <p>
              仅重置“{currentCase.label} · {currentCase.subtitle}
              ”的合成报告、回应和本标签页草稿。其他案例、原生 App、AV 和个人资料不受影响。
            </p>
            <p>本例中的自由输入将被移除；需要保留时请先导出。</p>
            <div className="dp-actions">
              <button type="button" onClick={exportState}>
                先导出本例
              </button>
              <button
                type="button"
                className="dp-primary-button"
                disabled={busy}
                onClick={() => void reset()}
              >
                确认重置本例
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
