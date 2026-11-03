import type {
  CoreReportTarget,
  UnderstandingAppView,
  UnderstandingExactEvidence,
  UnderstandingFeedbackInput,
  UnderstandingReport,
  UnderstandingReportHistory,
  UnderstandingSourceStatus,
  UnderstandingTopicView,
  UnderstandingVersionView,
} from "@findme/core";
import { ArrowLeft, BookOpen, ChevronRight, Home, MessageSquare, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, coreApi, privateUnderstandingMode, understandingApi } from "./api";
import type { CoreReportSource, ExplorationSummary } from "./types";
import "./understanding.css";

const statusText = {
  ready: "已通过当前审核 · 待本人评价",
  partial: "尚未复核完成",
  no_evidence: "已处理，本范围未选出合格证据",
  context_required: "需要澄清背景",
  not_selected: "本次未分析",
  needs_review: "待重新复核",
  blocked: "来源依据不可用",
};
const feedbackLabels = {
  disagree: "这不准确",
  scope_only: "仅某情境成立",
  time_update: "现在已经不同",
  supplement: "补充经历",
  helpful: "有帮助",
};
const receiptLabels = {
  saved: "已保存 · 待核验",
  pending_analysis: "待核验 · 等待显式分析",
  processing: "分析中 · 尚未接受",
  accepted: "审核通过 · 新版本可读",
  rejected: "复核未通过 · 原报告保留",
  failed: "处理失败 · 原报告保留",
};
const overallLabels = {
  blocked: "暂不能复评",
  pending: "等待显式复评",
  running: "正在复评",
  ready: "已通过当前审核",
  rejected: "复核未通过",
  failed: "处理失败",
};
const frameworkLabels: Record<UnderstandingAppView["frameworks"]["human_3"], string> = {
  not_run: "尚未运行",
  in_progress: "访谈进行中",
  needs_review: "输入变化后待复核",
  completed: "已有完成报告",
  abandoned: "已放弃本次运行",
};
const blockedLabels: Record<string, string> = {
  U2_OVERALL_ABSENT: "U2 尚无已接受的整体报告，U3 不能代为完成。",
  TOPICS_NOT_CURRENT: "仍有专题尚未完成审核，整体复评暂不能开始。",
  TOPIC_FEEDBACK_UNRESOLVED: "专题回应仍待处理，请先完成专题修订。",
  NEW_FEEDBACK_REQUIRED: "需要实际新增回应才可复评。",
  FEEDBACK_PROCESSING_DISABLED: "服务器未启用模型处理。",
  FEEDBACK_BUDGET_EXHAUSTED: "剩余调用预算不足，不能开始生成和独立审核。",
  FEEDBACK_PROCESSING_BUSY: "正在处理，请稍后重新读取。",
  OVERALL_ORIGINAL_BOUND_EXCEEDED: "所需原文并集超过单次输入上限；本次不能复评，不会截掉证据。",
  OVERALL_ORIGINAL_UNAVAILABLE: "所需原文当前不可用。",
  PROVIDER_TIMEOUT: "模型调用超时，可显式恢复；已经使用的调用保留计数。",
  PROCESS_INTERRUPTED: "上次处理被中断，需要显式恢复。",
  REVISION_SOURCE_RACE: "来源或回应已变化，本次结果没有发布。",
  STALE_REPORT_SOURCE: "原话内容或资格版本已经变化，相关报告已暂停展示。",
  REPORT_SOURCE_EXCLUDED: "原始来源已被排除，相关内容不可继续使用。",
  REPORT_SOURCE_DELETED: "原始来源已删除，相关内容不可继续使用。",
  REPORT_SOURCE_REPLACED: "原始来源已被更正或替换，需要重新选择当前原话。",
  SOURCE_RETIRED: "此来源已明确退役，恢复来源不会自动恢复旧内容。",
  REPORT_SOURCE_BLOCKED: "这份报告依赖不可用来源，请先处理来源并恢复相关专题。",
  EXPLICIT_SOURCE_RETIREMENT_REQUIRED: "先明确退役或重新绑定失效来源，再恢复专题。",
  SOURCE_LIFECYCLE_CONFLICT: "来源管理状态已变化，请重新读取后再操作。",
};
type Target = {
  domain: string;
  version: string;
  title: string;
  finding_key?: string;
  question?: string;
  baseline_version?: string;
  input_hash?: string;
};
const targetStorage = "findme_u3_context_target";
function storedTarget(): Target | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(targetStorage) ?? "null");
    return t &&
      typeof t.domain === "string" &&
      typeof t.version === "string" &&
      typeof t.title === "string" &&
      typeof t.baseline_version === "string" &&
      typeof t.input_hash === "string"
      ? t
      : null;
  } catch {
    return null;
  }
}
type Draft = { note: string; type: UnderstandingFeedbackInput["type"]; key: string };
const draftKey = (t: Target) =>
  `findme_u3_draft:${t.domain}:${t.version}:${t.finding_key ?? "report"}`;
function storedDraft(t: Target): Draft {
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey(t)) ?? "null");
    if (d && typeof d.note === "string" && d.type in feedbackLabels && typeof d.key === "string")
      return d;
  } catch {
    /* In-memory draft still works. */
  }
  return { note: "", type: "supplement", key: crypto.randomUUID() };
}
function message(e: unknown) {
  return e instanceof ApiError
    ? `请求失败：${e.code}。文字仍保留，请重新读取或重试。`
    : "连接失败。文字仍保留，请稍后重试。";
}
function ReportBody({
  report,
  target,
  onFeedback,
  onExplore,
  onEvidence,
}: {
  report: UnderstandingReport;
  target: Target;
  onFeedback?: (t: Target) => void;
  onExplore?: (t: Target) => void;
  onEvidence: (t: Target, ids: string[], role: string) => void;
}) {
  const finding = (f: NonNullable<UnderstandingReport["current_understanding"]>) => (
    <article className="claim-card observation fm-claim" key={f.key}>
      <p className="claim-text">{f.text}</p>
      <div className="claim-scope">
        <span>适用范围</span>
        <p>{f.scope}</p>
      </div>
      <div className="u3-actions">
        {(
          [
            ["支持", f.evidence_ids],
            ["反例", f.counterevidence_ids],
            ["背景", f.context_ids],
          ] as const
        ).map(
          ([role, ids]) =>
            ids.length > 0 && (
              <button type="button" key={role} onClick={() => onEvidence(target, ids, role)}>
                {role}依据
              </button>
            ),
        )}
        {onFeedback && (
          <button
            type="button"
            onClick={() => onFeedback({ ...target, finding_key: f.key, question: f.text })}
          >
            纠正或补充这句话
          </button>
        )}
        {onExplore && (
          <button
            type="button"
            onClick={() => onExplore({ ...target, finding_key: f.key, question: f.text })}
          >
            从这条理解开始原生探索
          </button>
        )}
      </div>
    </article>
  );
  const nodes = new Map(report.nodes.map((n) => [n.key, n]));
  return (
    <div className="u3-report">
      <h2>{report.headline}</h2>
      {report.current_understanding && finding(report.current_understanding)}
      {report.findings.map(finding)}
      {report.resources_conditions_costs.length > 0 && (
        <section>
          <h3>资源、条件与可能的成本</h3>
          {report.resources_conditions_costs.map(finding)}
        </section>
      )}
      {report.nodes.length > 0 && (
        <details className="fm-relations">
          <summary>情境中的角色与选择 · {report.nodes.length}</summary>
          {report.nodes.map((n) => (
            <div key={n.key}>
              <p>
                {n.type} · {n.text}（{n.scope}）
              </p>
              <button type="button" onClick={() => onEvidence(target, n.evidence_ids, "情境")}>
                查看依据
              </button>
            </div>
          ))}
        </details>
      )}
      {report.links.length > 0 && (
        <details className="fm-relations">
          <summary>展开有依据的关系 · {report.links.length}</summary>
          {report.links.map((l) => (
            <div key={l.key}>
              <p>
                {nodes.get(l.from)?.text} · {l.type} · {nodes.get(l.to)?.text}（{l.scope}）
              </p>
              <button type="button" onClick={() => onEvidence(target, l.evidence_ids, "关系")}>
                查看依据
              </button>
            </div>
          ))}
        </details>
      )}
      {report.alternatives.length > 0 && (
        <section>
          <h3>其他解释</h3>
          {report.alternatives.map((v) => (
            <p key={v}>{v}</p>
          ))}
        </section>
      )}
      {report.unknowns.length > 0 && (
        <section>
          <h3>仍不清楚</h3>
          {report.unknowns.map((v) => (
            <p key={v}>{v}</p>
          ))}
        </section>
      )}
      {report.question && (
        <section>
          <h3>最值得澄清的问题</h3>
          <p>{report.question.text}</p>
          {onFeedback && (
            <button
              type="button"
              onClick={() => onFeedback({ ...target, question: report.question?.text })}
            >
              带着这个问题继续探索
            </button>
          )}
          {onExplore && (
            <button
              type="button"
              onClick={() => onExplore({ ...target, question: report.question?.text })}
            >
              带着这个问题开始原生探索
            </button>
          )}
          {report.question.branches.map((v) => (
            <p key={v}>{v}</p>
          ))}
        </section>
      )}
      {report.next_step && <p>可选下一步：{report.next_step}</p>}
      {onFeedback && (
        <button type="button" className="button primary" onClick={() => onFeedback(target)}>
          纠正或补充这份理解
        </button>
      )}
      {onExplore && (
        <button type="button" className="button secondary" onClick={() => onExplore(target)}>
          从这个专题开始原生探索
        </button>
      )}
    </div>
  );
}
const versionLabels = {
  accepted: "当前已接受",
  superseded: "已被后续版本替代",
  needs_review: "待重新复核",
  blocked: "依据不可用",
};
const originLabels = { baseline: "理解基线", feedback: "回应修订", source_recovery: "来源恢复" };
function ReportHistory({
  domain,
  title,
  feedback,
  onEvidence,
}: {
  domain: string;
  title: string;
  feedback: UnderstandingAppView["feedback"];
  onEvidence: (t: Target, ids: string[], role: string) => void;
}) {
  const [history, setHistory] = useState<UnderstandingReportHistory | null>(null);
  const [selected, setSelected] = useState<UnderstandingVersionView | null>(null);
  const [previous, setPrevious] = useState<UnderstandingVersionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(version?: string) {
    setBusy(true);
    setError("");
    setPrevious(null);
    if (version) setSelected(null);
    try {
      if (version) {
        const next = await understandingApi.version(domain, version);
        setSelected(next);
        if (next.previous_version) {
          try {
            setPrevious(await understandingApi.version(domain, next.previous_version));
          } catch {
            setError("前一版本暂不可读取；以下仅展示实际可读的版本内容。");
          }
        }
      } else setHistory(await understandingApi.history(domain));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const readable = (v: UnderstandingVersionView | null) =>
    v && v.status !== "blocked" ? v.report : null;
  const selectedReport = readable(selected);
  const previousReport = readable(previous);
  const related = selected
    ? feedback.filter((f) => f.input.domain === domain && f.result_version === selected.version)
    : [];
  return (
    <section className="home-section fm-history" aria-label={`${title}报告版本`}>
      <div className="section-head">
        <h2>{title} · 修订历史</h2>
        <button type="button" disabled={busy} onClick={() => load()}>
          {busy ? "读取中…" : "读取版本记录"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {history && (
        <>
          {history.versions.length === 0 && <p>此范围尚无报告版本。</p>}
          <div className="fm-version-list">
            {history.versions.map((v) => (
              <button
                type="button"
                key={v.version}
                disabled={busy}
                aria-pressed={selected?.version === v.version}
                onClick={() => load(v.version)}
              >
                <strong>{v.version}</strong> · {versionLabels[v.status]} · {originLabels[v.origin]}
                {v.feedback_types.length > 0 &&
                  ` · ${v.feedback_types.map((t) => feedbackLabels[t]).join("、")}`}
              </button>
            ))}
          </div>
          {history.truncated && <p>仅显示最近 30 个版本。</p>}
        </>
      )}
      {selected && (
        <>
          <p className="fm-status">
            版本 {selected.version} · {versionLabels[selected.status]}。历史只供回看。
          </p>
          <div className="fm-diff">
            <section className="old">
              <small>修订前 · {selected.previous_version ?? "无前一版本"}</small>
              {previousReport ? (
                <p>{previousReport.current_understanding?.text ?? previousReport.headline}</p>
              ) : (
                <p>
                  {selected.previous_version
                    ? "前一版本当前不可展示，无法对照。"
                    : "这是此范围的初始版本，没有修订前内容。"}
                </p>
              )}
            </section>
            <section className="new">
              <small>所选版本 · {selected.version}</small>
              {selectedReport ? (
                <p>{selectedReport.current_understanding?.text ?? selectedReport.headline}</p>
              ) : (
                <p>来源依据不可用或尚待复核，此版本内容已停止展示。</p>
              )}
            </section>
          </div>
          <section>
            <h3>修订来由</h3>
            <p>
              版本来源：{originLabels[selected.origin]}
              {selected.feedback_types.length > 0 &&
                `；回应类型：${selected.feedback_types.map((t) => feedbackLabels[t]).join("、")}`}
              。
            </p>
            {related.map((f) => (
              <blockquote key={f.id}>{f.input.note || "有帮助评价"}</blockquote>
            ))}
            <p>以上为版本记录与已关联回应；接口未提供独立的逐条修改理由。</p>
          </section>
          {selectedReport && (
            <details>
              <summary>阅读所选版本全文与依据</summary>
              <ReportBody
                report={selectedReport}
                target={{ domain, version: selected.version, title }}
                onEvidence={onEvidence}
              />
            </details>
          )}
          {previous && previousReport && (
            <details>
              <summary>阅读前一版本全文与依据</summary>
              <ReportBody
                report={previousReport}
                target={{ domain, version: previous.version, title }}
                onEvidence={onEvidence}
              />
            </details>
          )}
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setPrevious(null);
            }}
          >
            收起版本报告
          </button>
        </>
      )}
    </section>
  );
}
function SourceControl({
  source,
  data,
  onReload,
}: {
  source: UnderstandingSourceStatus;
  data: UnderstandingAppView;
  onReload: () => Promise<void>;
}) {
  const storageKey = `findme_u3_source:${source.source_id}`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (
        saved &&
        typeof saved.reason === "string" &&
        typeof saved.exploration === "string" &&
        typeof saved.replacement === "string" &&
        typeof saved.domain === "string" &&
        typeof saved.key === "string"
      )
        return saved as {
          reason: string;
          exploration: string;
          replacement: string;
          domain: string;
          key: string;
        };
    } catch {
      /* The in-memory draft remains usable. */
    }
    return { reason: "", exploration: "", replacement: "", domain: "", key: crypto.randomUUID() };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [rebind, setRebind] = useState(false);
  const [explorations, setExplorations] = useState<ExplorationSummary[]>([]);
  const [sources, setSources] = useState<CoreReportSource[]>([]);
  async function loadExplorations() {
    setRebind(true);
    setBusy(true);
    setError("");
    try {
      const lists = await Promise.all([
        coreApi.explorations("active"),
        coreApi.explorations("completed"),
        coreApi.explorations("abandoned"),
      ]);
      setExplorations(lists.flatMap((list) => list.items));
      if (draft.exploration)
        setSources((await coreApi.exploration(draft.exploration)).report_sources ?? []);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function chooseExploration(id: string) {
    change({ exploration: id, replacement: "" });
    setSources([]);
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      setSources((await coreApi.exploration(id)).report_sources ?? []);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const targets = [
    ...(data.overall.version
      ? [{ domain: "overall", version: data.overall.version, title: "整体理解" }]
      : []),
    ...data.topics.map((t) => ({ domain: t.domain, version: t.version, title: t.title })),
  ];
  function change(fields: Partial<typeof draft>) {
    const next = { ...draft, ...fields, key: crypto.randomUUID() };
    setDraft(next);
    setSaved(false);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Keep draft in memory. */
    }
  }
  async function submit(kind: "retire" | "rebind") {
    setBusy(true);
    setError("");
    try {
      const action = {
        source_id: source.source_id,
        expected_lifecycle_revision: source.lifecycle_revision,
        reason: draft.reason.trim(),
        idempotency_key: `${kind}:${draft.key}`,
      };
      if (kind === "retire") await understandingApi.retireSource(action);
      else {
        const target = targets.find((t) => t.domain === draft.domain);
        if (!target) throw new ApiError(400, "REPORT_TARGET_REQUIRED", "请选择报告目标");
        await understandingApi.rebindSource({
          ...action,
          exploration_id: draft.exploration.trim(),
          new_source_id: draft.replacement.trim(),
          target: {
            baseline_version: data.baseline_version,
            input_hash: data.input_hash,
            domain: target.domain,
            report_version: target.version,
          },
        });
      }
      setSaved(true);
      await onReload();
      sessionStorage.removeItem(storageKey);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="u3-feedback">
      <h3>来源 {source.source_id}</h3>
      <p>
        {source.status === "active" ? "有效" : source.status === "retired" ? "已退休" : "已失效"} ·
        来源修订 {source.lifecycle_revision}
      </p>
      {source.reason && <p>{blockedLabels[source.reason] ?? source.reason}</p>}
      <p>
        影响范围：
        {source.affected_domains
          .map((d) =>
            d === "overall" ? "整体理解" : (data.topics.find((t) => t.domain === d)?.title ?? d),
          )
          .join("、") || "尚无报告依赖"}
      </p>
      <>
        <label>
          操作理由
          <textarea
            rows={2}
            value={draft.reason}
            maxLength={1000}
            onChange={(e) => change({ reason: e.target.value })}
          />
        </label>
        {source.status !== "retired" && (
          <>
            <p>退休会停止使用这条来源，并使依赖它的报告等待重新复核。</p>
            <button
              type="button"
              disabled={busy || saved || !draft.reason.trim()}
              onClick={() => submit("retire")}
            >
              退休这条来源
            </button>
          </>
        )}
        {!privateUnderstandingMode && data.capabilities.native_core === "available" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => (rebind ? setRebind(false) : loadExplorations())}
              aria-expanded={rebind}
            >
              重新绑定有效来源
            </button>
            {rebind && (
              <>
                <p>请指定原生探索及其来源；服务器会读取和核验原话。绑定后仍需显式重新复核专题。</p>
                <label>
                  原生探索
                  <select
                    value={draft.exploration}
                    disabled={busy}
                    onChange={(e) => chooseExploration(e.target.value)}
                  >
                    <option value="">请选择探索</option>
                    {explorations.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.summary} · {new Date(e.started_at).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  替代原话
                  <select
                    value={draft.replacement}
                    disabled={busy}
                    onChange={(e) => change({ replacement: e.target.value })}
                  >
                    <option value="">请选择已核验的原话</option>
                    {sources.map((source) => (
                      <option key={source.source_id} value={source.source_id}>
                        {source.content}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.exploration && !busy && sources.length === 0 && (
                  <p>这次探索没有可用于报告的原话。</p>
                )}
                {sources.find((source) => source.source_id === draft.replacement) && (
                  <p>{sources.find((source) => source.source_id === draft.replacement)?.content}</p>
                )}
                <label>
                  报告目标
                  <select value={draft.domain} onChange={(e) => change({ domain: e.target.value })}>
                    <option value="">请选择报告</option>
                    {targets.map((t) => (
                      <option key={t.domain} value={t.domain}>
                        {t.title} · {t.version}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={
                    busy ||
                    saved ||
                    !draft.reason.trim() ||
                    !draft.exploration.trim() ||
                    !draft.replacement.trim() ||
                    !draft.domain
                  }
                  onClick={() => submit("rebind")}
                >
                  核验并重新绑定
                </button>
              </>
            )}
          </>
        )}
      </>
      {/* biome-ignore lint/a11y/useSemanticElements: status text is a paragraph; <output> is for computed results. */}
      {saved && <p role="status">来源操作已保存，正在重新读取状态。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
function FeedbackForm({
  target,
  data,
  onSaved,
  onClose,
  disabled = false,
}: {
  target: Target;
  data: UnderstandingAppView;
  onSaved: () => Promise<void>;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => storedDraft(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  function change(next: Partial<Draft>) {
    const d = { ...draft, ...next, key: crypto.randomUUID() };
    setDraft(d);
    setSaved(false);
    try {
      sessionStorage.setItem(draftKey(target), JSON.stringify(d));
    } catch {
      setError("浏览器未能保存草稿，请在离开前复制文字。");
    }
  }
  const current =
    target.domain === "overall"
      ? data.overall
      : data.topics.find((t) => t.domain === target.domain);
  const sourceUnavailable =
    !current || current.status === "blocked" || current.status === "unavailable";
  const stale =
    target.baseline_version !== data.baseline_version ||
    target.input_hash !== data.input_hash ||
    current?.version !== target.version;
  async function save() {
    if (stale || disabled || sourceUnavailable) return;
    setBusy(true);
    setError("");
    try {
      await understandingApi.save(
        {
          baseline_version: data.baseline_version,
          input_hash: data.input_hash,
          domain: target.domain,
          report_version: target.version,
          finding_key: target.finding_key,
          context: target.question ? { question: target.question } : undefined,
          type: draft.type,
          note: draft.note,
        },
        draft.key,
      );
      setSaved(true);
      try {
        sessionStorage.removeItem(draftKey(target));
      } catch {
        /* Saved on server. */
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="u3-feedback fm-correction" aria-label="纠正或补充报告">
      <div className="section-head">
        <h2>让这份理解更贴近当时的你</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭回应">
          <X size={20} />
        </button>
      </div>
      <div className="fm-target-quote">
        <p className="fm-meta">
          正在回应 · {target.title} · 版本 {target.version}
          {target.finding_key && ` · 判断 ${target.finding_key}`}
        </p>
        {sourceUnavailable ? (
          <p>此报告来源当前不可用，目标内容已停止展示。你的草稿仍保留。</p>
        ) : target.question ? (
          <blockquote>{target.question}</blockquote>
        ) : (
          <p>回应这份报告的整体内容。可以返回阅读，选择一句具体判断。</p>
        )}
      </div>
      <p>你的笔记将作为报告回应保存。补充与纠正等待显式分析和独立审核，保存不会启动模型。</p>
      {stale && (
        <p role="alert" className="form-error">
          目标报告已变化；这份草稿仍绑定原版本，不能保存到新版本。请保留原话并重新选择目标。
        </p>
      )}

      <label>
        回应类型
        <select
          disabled={busy}
          value={draft.type}
          onChange={(e) => change({ type: e.target.value as Draft["type"] })}
        >
          {Object.entries(feedbackLabels).map(([value, text]) => (
            <option value={value} key={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label>
        你知道的情况
        <textarea
          disabled={busy}
          value={draft.note}
          maxLength={2400}
          rows={5}
          onChange={(e) => change({ note: e.target.value })}
          placeholder="补充具体背景、反例或现在的变化…"
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: status text is a paragraph; <output> is for computed results. */}
      {saved && <p role="status">原话已保存。评价不会成为独立证据；其他回应尚未分析。</p>}
      <button
        type="button"
        className="button primary"
        disabled={
          disabled ||
          sourceUnavailable ||
          stale ||
          busy ||
          saved ||
          (draft.type !== "helpful" && !draft.note.trim())
        }
        onClick={save}
      >
        {busy ? "保存中…" : "保存，等待核验"}
      </button>
    </section>
  );
}
type ReportEvidence = { role: string; target: Target; rows: UnderstandingExactEvidence[] };
function ReportEvidenceDialog({
  evidence,
  onClose,
}: { evidence: ReportEvidence; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      className="fm-evidence-drawer"
      ref={dialog}
      aria-labelledby="report-evidence-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="section-head">
        <h2 id="report-evidence-title">{evidence.role}依据</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭依据">
          <X size={20} />
        </button>
      </div>
      <p className="fm-meta">
        {evidence.target.title} · 报告版本 {evidence.target.version}
      </p>
      {evidence.rows.length === 0 && <p>此版本没有可展示的对应原话。</p>}
      {evidence.rows.map((e) => (
        <article className="cloud-evidence" key={e.id}>
          <blockquote>{e.quote}</blockquote>
          <p>
            作者：{e.author} · 对象：{e.about} · 立场：{e.stance}
          </p>
          <p>
            报告时间：{e.report_time ?? "未明确"} · 范围：{e.scope}
          </p>
          {e.qualifier && <p>必要上下文：{e.qualifier}</p>}
          <details>
            <summary>来源标识与位置</summary>
            <p>{e.source_id}</p>
            <p>{e.source_ids.join("，")}</p>
            <p>
              会话：{e.session_id} · 消息：{e.message_id}
            </p>
            <p>
              原文位置：{e.start}–{e.end}（UTF-16）
            </p>
          </details>
        </article>
      ))}
      <button className="button secondary" type="button" onClick={onClose}>
        返回阅读
      </button>
    </dialog>
  );
}
export default function UnderstandingView({
  data,
  view,
  onCurrent,
  onReload,
  startFeedback,
  unavailable,
  onExplore,
  returnTarget,
  onHome,
}: {
  data: UnderstandingAppView;
  view: "home" | "current";
  onCurrent: () => void;
  onReload: () => Promise<void>;
  startFeedback: number;
  unavailable?: string;
  onExplore?: (target: CoreReportTarget) => void;
  returnTarget?: CoreReportTarget | null;
  onHome?: () => void;
}) {
  const [domain, setDomain] = useState<string | null>(() => {
    const t = storedTarget();
    return t && t.domain !== "overall" ? t.domain : null;
  });
  const [target, setTarget] = useState<Target | null>(storedTarget);
  const [page, setPage] = useState<"overview" | "topics" | "revisions">(
    view === "home" ? "overview" : "topics",
  );
  const [overviewExpanded, setOverviewExpanded] = useState(view === "current");
  const [chooseTopic, setChooseTopic] = useState(false);
  const [reason, setReason] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a restored target opens the current view once on mount.
  useEffect(() => {
    if (target) {
      setPage("revisions");
      onCurrent();
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts only to a new return target from native exploration.
  useEffect(() => {
    if (returnTarget) {
      setDomain(returnTarget.domain === "overall" ? null : returnTarget.domain);
      setTarget(null);
      setPage(returnTarget.domain === "overall" ? "overview" : "topics");
      setOverviewExpanded(true);
      onCurrent();
    }
  }, [returnTarget]);
  function exploreTarget(t: Target) {
    onExplore?.({
      baseline_version: data.baseline_version,
      input_hash: data.input_hash,
      domain: t.domain,
      report_version: t.version,
      ...(t.finding_key ? { finding_key: t.finding_key } : {}),
      ...(t.question ? { question: t.question } : {}),
    });
  }
  function selectTarget(t: Target) {
    setTarget({ ...t, baseline_version: data.baseline_version, input_hash: data.input_hash });
    setDomain(t.domain === "overall" ? null : t.domain);
    setPage("revisions");
    onCurrent();
    setChooseTopic(false);
  }
  useEffect(() => {
    try {
      if (target) sessionStorage.setItem(targetStorage, JSON.stringify(target));
      else sessionStorage.removeItem(targetStorage);
    } catch {
      /* Draft remains in memory. */
    }
  }, [target]);
  const [evidence, setEvidence] = useState<ReportEvidence | null>(null);
  const evidenceRequest = useRef(0);
  const previousView = useRef(view);
  useEffect(() => {
    const changed = previousView.current !== view;
    previousView.current = view;
    if (changed && view === "home") {
      setPage("overview");
      setDomain(null);
      setEvidence(null);
      setOverviewExpanded(false);
    }
  }, [view]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset reading position only on navigation, not on edits or refreshes.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [page, domain]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sourceState =
    data.sources
      ?.map((source) => `${source.source_id}:${source.lifecycle_revision}:${source.status}`)
      .join("|") ?? "";
  const reportState = `${data.overall.version}:${data.overall.status}|${data.topics.map((t) => `${t.domain}:${t.version}:${t.status}`).join("|")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate cached and in-flight evidence when navigating or its source/report changes.
  useEffect(() => {
    evidenceRequest.current++;
    setEvidence(null);
    setBusy(false);
  }, [sourceState, reportState, domain, page]);
  const topic = data.topics.find((t) => t.domain === domain);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts only to the feedback entry request, not to later data refreshes.
  useEffect(() => {
    if (startFeedback) {
      const eligible = data.topics.filter((t) => t.report && t.status !== "blocked");
      const [only] = eligible;
      if (eligible.length === 1 && only)
        selectTarget({ domain: only.domain, version: only.version, title: only.title });
      else if (eligible.length > 1) {
        setPage("revisions");
        setChooseTopic(true);
      } else setError("专题报告尚未可用，暂时没有可回应的报告目标。");
    }
  }, [startFeedback]);
  async function reload() {
    setBusy(true);
    setError("");
    try {
      await onReload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function processFeedback(id?: string) {
    setBusy(true);
    setError("");
    try {
      if (id) {
        const action = data.capabilities.feedback_actions.find((a) => a.id === id)?.action;
        await understandingApi.process(id, {
          recover: action === "recover",
          reason: action === "revise_reason" ? reason : undefined,
        });
      } else if (data.capabilities.overall.request) {
        const action = data.capabilities.overall.action;
        await understandingApi.processOverall(data.capabilities.overall.request, {
          recover: action === "recover",
          reason: action === "revise_reason" ? reason : undefined,
        });
      }
      setReason("");
      await onReload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function recoverTopic(selectedDomain: string, version: string) {
    setBusy(true);
    setError("");
    try {
      await understandingApi.recoverTopic(selectedDomain, version, {
        recover: true,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      await onReload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function showEvidence(t: Target, ids: string[], role: string) {
    const request = ++evidenceRequest.current;
    setBusy(true);
    setError("");
    setEvidence(null);
    try {
      const rows = await understandingApi.evidences(t.domain, t.version, ids);
      if (request === evidenceRequest.current) setEvidence({ role, target: t, rows });
    } catch (e) {
      if (request === evidenceRequest.current) setError(message(e));
    } finally {
      if (request === evidenceRequest.current) setBusy(false);
    }
  }

  function open(t: UnderstandingTopicView) {
    setDomain(t.domain);
    setPage("topics");
    onCurrent();
    setEvidence(null);
  }
  if (unavailable)
    return (
      <div className="current-page u3-page">
        <h1>当前理解暂不可读取</h1>
        <p className="global-error" role="alert">
          {unavailable}。当前报告已停止展示，请核对来源或连接后重新读取。
        </p>
        <button type="button" className="button secondary" onClick={reload} disabled={busy}>
          重新读取
        </button>
        {target && (
          <FeedbackForm
            key={draftKey(target)}
            target={target}
            data={data}
            onSaved={onReload}
            onClose={() => setTarget(null)}
            disabled
          />
        )}
      </div>
    );
  const overallReport = data.overall.status === "ready" ? data.overall.report : null;
  const readableTopics = data.topics.filter((t) => t.status !== "blocked" && t.report);
  const topicCards = (
    <section className="home-section" aria-label="专题阅读">
      <div className="section-head">
        <h2>从一个具体侧面，继续理解</h2>
        <span className="fm-meta">{data.topics.length} 个专题 · 各自保留依据与范围</span>
      </div>
      <div className="fm-topic-grid">
        {data.topics.map((t) => (
          <button type="button" className="fm-topic-card" key={t.domain} onClick={() => open(t)}>
            <span className="fm-status">{statusText[t.status]}</span>
            <h3>{t.title}</h3>
            <p>
              {t.status !== "blocked" && t.report
                ? (t.report.current_understanding?.text ?? t.report.headline)
                : t.status === "blocked"
                  ? "来源依据不可用，相关内容已停止展示。"
                  : "本专题还没有可阅读的完整认识，保留当前范围与未知。"}
            </p>
            <span className="fm-topic-foot">
              阅读这个专题 <ChevronRight size={18} />
            </span>
          </button>
        ))}
      </div>
      {data.topics.length === 0 && <p>这批材料尚未形成可阅读的专题。</p>}
    </section>
  );
  function navigate(next: typeof page) {
    setPage(next);
    setChooseTopic(false);
    setEvidence(null);
    if (next === "overview") {
      setDomain(null);
      setOverviewExpanded(false);
      onHome?.();
    } else {
      if (next === "topics") setDomain(null);
      onCurrent();
    }
  }
  return (
    <div className="u3-page fm-page">
      <nav className="fm-shell-nav fm-nav" aria-label="认识阅读导航">
        <button
          type="button"
          aria-current={page === "overview" ? "page" : undefined}
          onClick={() => navigate("overview")}
        >
          <Home size={18} />
          <span>整体认识</span>
        </button>
        <button
          type="button"
          aria-current={page === "topics" ? "page" : undefined}
          onClick={() => navigate("topics")}
        >
          <BookOpen size={18} />
          <span>专题阅读</span>
        </button>
        <button
          type="button"
          aria-current={page === "revisions" ? "page" : undefined}
          onClick={() => navigate("revisions")}
        >
          <MessageSquare size={18} />
          <span>纠正与修订</span>
        </button>
      </nav>
      <div className="section-head fm-meta">
        <span>截至 {data.scope.cutoff_before} · 仅在本批授权材料与选材范围内</span>
        <button
          type="button"
          className="icon-button"
          onClick={reload}
          disabled={busy}
          aria-label="重新读取"
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {error && (
        <p className="global-error" role="alert">
          {error}
        </p>
      )}
      {returnTarget && (
        <p className="fm-status">
          已从原生探索返回：
          {returnTarget.domain === "overall"
            ? "整体认识"
            : (data.topics.find((t) => t.domain === returnTarget.domain)?.title ?? "原专题")}
          {returnTarget.question && ` · ${returnTarget.question}`}
        </p>
      )}
      {page === "overview" && (
        <>
          <section className="fm-hero">
            <div>
              <p className="eyebrow">我的整体认识</p>
              <h1>
                {overallReport?.headline ??
                  (data.overall.status === "needs_review"
                    ? "整体认识，等待重新复核。"
                    : "整体认识，还没有形成。")}
              </h1>
              {overallReport ? (
                <p className="fm-lead">
                  {overallReport.current_understanding?.text ??
                    "当前报告已形成，可以展开完整理解并逐条核对。"}
                </p>
              ) : (
                <p className="fm-lead">
                  目前没有可展示的整体报告。你可以先阅读已完成的专题，未完成的部分继续保留未知。
                </p>
              )}
              {overallReport && (
                <div className="u3-actions">
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => setOverviewExpanded(!overviewExpanded)}
                    aria-expanded={overviewExpanded}
                  >
                    {overviewExpanded ? "收起完整理解" : "阅读完整理解"}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      selectTarget({
                        domain: "overall",
                        version: data.overall.version,
                        title: "整体认识",
                      })
                    }
                  >
                    纠正或补充
                  </button>
                </div>
              )}
            </div>
            <aside>
              <p className="fm-status">
                {overallReport ? "阶段性理解 · 待本人评价" : "尚无可读总览"}
              </p>
              {overallReport && <p className="fm-meta">版本 {data.overall.version}</p>}
              <h3>先理解，再核对</h3>
              <p>把判断放回具体情境。依据、反例与未知保留在正文中，每一句都可以继续纠正。</p>
              <button type="button" onClick={() => navigate("revisions")}>
                查看纠正与修订 <ChevronRight size={16} />
              </button>
            </aside>
          </section>
          {overallReport && overviewExpanded && (
            <div className="fm-reading-layout">
              <article className="fm-reading">
                <ReportBody
                  report={overallReport}
                  target={{ domain: "overall", version: data.overall.version, title: "整体认识" }}
                  onFeedback={selectTarget}
                  onExplore={onExplore ? exploreTarget : undefined}
                  onEvidence={showEvidence}
                />
              </article>
              <aside className="fm-margin-notes">
                <section>
                  <h3>一份有范围的认识</h3>
                  <p>
                    这份报告只覆盖本批授权材料。每条判断保留自身适用范围，不能由一次经历推到所有情境。
                  </p>
                </section>
                <section>
                  <h3>核对方式</h3>
                  <p>在判断旁展开支持、反例或背景原话；纠正会绑定你正在阅读的版本。</p>
                </section>
              </aside>
            </div>
          )}
          {topicCards}
        </>
      )}
      {page === "topics" && !topic && (
        <>
          <section className="fm-hero">
            <div>
              <p className="eyebrow">专题阅读</p>
              <h1>把认识，放回具体情境。</h1>
              <p className="fm-lead">
                每个专题保留自己的依据、适用范围和未知。选择一个侧面，读完整解释，再核对其中的判断。
              </p>
            </div>
          </section>
          {topicCards}
        </>
      )}
      {page === "topics" && topic && (
        <>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setDomain(null);
              setEvidence(null);
            }}
          >
            <ArrowLeft size={16} />
            全部专题
          </button>
          <div className="fm-topic-switch" aria-label="切换专题">
            {data.topics.map((t) => (
              <button
                type="button"
                key={t.domain}
                aria-pressed={t.domain === topic.domain}
                onClick={() => open(t)}
              >
                {t.title}
              </button>
            ))}
          </div>
          <div className="fm-reading-layout">
            <article className="fm-reading">
              <p className="fm-meta">
                {topic.title} · 版本 {topic.version}
              </p>
              <h1>{topic.title}</h1>
              <p className="fm-status">{statusText[topic.status]}</p>
              {topic.status !== "blocked" && topic.report ? (
                <ReportBody
                  report={topic.report}
                  target={{ domain: topic.domain, version: topic.version, title: topic.title }}
                  onFeedback={selectTarget}
                  onExplore={onExplore ? exploreTarget : undefined}
                  onEvidence={showEvidence}
                />
              ) : (
                <section className="fm-empty">
                  <h2>
                    {topic.status === "blocked" ? "来源依据暂不可用" : "这个侧面，先保留未知"}
                  </h2>
                  <p>
                    {topic.status === "partial" || topic.status === "not_selected"
                      ? "这一专题尚未完成分析与复核，不能据此判断缺少个人证据。"
                      : statusText[topic.status]}
                  </p>
                  {topic.status === "blocked" && (
                    <p>相关报告已停止展示。可以在下方“来源与处理设置”查看恢复条件。</p>
                  )}
                </section>
              )}
            </article>
            <aside className="fm-margin-notes">
              <section>
                <h3>本专题的范围</h3>
                <p>{topic.selection.scope}</p>
              </section>
              <section>
                <h3>如何核对</h3>
                <p>
                  每条判断旁都可以查看原话、反例和背景。共用来源不会因为出现在多个专题而成为新的独立证据。
                </p>
              </section>
              <section>
                <h3>版本与修订</h3>
                <p>纠正绑定当前版本；保存后先等待核验，只有通过复核才会形成新版本。</p>
                <button
                  type="button"
                  onClick={() => {
                    setPage("revisions");
                    setTarget(null);
                  }}
                >
                  查看本专题修订历史
                </button>
              </section>
            </aside>
          </div>
        </>
      )}
      {page === "revisions" && (
        <>
          <section className="fm-hero">
            <div>
              <p className="eyebrow">纠正与修订</p>
              <h1>认识在变，来由始终看得见。</h1>
              <p className="fm-lead">
                补上当时的背景，或指出描述得太宽的地方。新的回应先等待核验，提交本身不会改写判断。
              </p>
            </div>
            <aside>
              <h3>你正在回应哪一版</h3>
              <p>具体判断、原话与草稿始终保留版本绑定。历史报告只供回看。</p>
            </aside>
          </section>
          {target ? (
            <FeedbackForm
              key={draftKey(target)}
              target={target}
              data={data}
              onSaved={onReload}
              onClose={() => setTarget(null)}
            />
          ) : (
            <section className="fm-correction">
              <h2>选择要纠正或补充的报告</h2>
              <p>也可以回到专题，在一句具体判断旁直接纠正。</p>
              <div className="u3-actions">
                {overallReport && (
                  <button
                    type="button"
                    onClick={() =>
                      selectTarget({
                        domain: "overall",
                        version: data.overall.version,
                        title: "整体认识",
                      })
                    }
                  >
                    整体认识
                  </button>
                )}
                {readableTopics.map((t) => (
                  <button
                    type="button"
                    key={t.domain}
                    onClick={() =>
                      selectTarget({ domain: t.domain, version: t.version, title: t.title })
                    }
                  >
                    {t.title}
                  </button>
                ))}
                {!overallReport && readableTopics.length === 0 && (
                  <p>目前没有可回应的报告。已有草稿仍保留在浏览器中。</p>
                )}
              </div>
            </section>
          )}
          {chooseTopic && <p className="fm-status">请从上面选择一个具体报告，再补充你的情况。</p>}
          <section className="fm-history-scope">
            <label>
              查看哪个范围的修订{" "}
              <select
                value={domain ?? "overall"}
                onChange={(e) => setDomain(e.target.value === "overall" ? null : e.target.value)}
              >
                <option value="overall">整体认识</option>
                {data.topics.map((t) => (
                  <option key={t.domain} value={t.domain}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          </section>
          {data.feedback.length > 0 && (
            <section className="home-section">
              <h2>回应与修订状态</h2>
              {data.feedback
                .filter((f) => f.input.domain === (domain ?? "overall"))
                .map((f) => (
                  <article key={f.id}>
                    <h3>
                      {feedbackLabels[f.input.type]} · {receiptLabels[f.status]}
                    </h3>
                    <p className="fm-meta">
                      {f.input.domain === "overall"
                        ? "整体认识"
                        : (data.topics.find((t) => t.domain === f.input.domain)?.title ??
                          f.input.domain)}{" "}
                      · 回应版本 {f.input.report_version}
                      {f.input.finding_key && ` · 判断 ${f.input.finding_key}`}
                    </p>
                    {f.input.context?.question &&
                      (f.input.domain === "overall"
                        ? data.overall.status === "ready"
                        : data.topics.find((t) => t.domain === f.input.domain)?.status !==
                          "blocked") && <blockquote>{f.input.context.question}</blockquote>}
                    <p>{f.input.note}</p>
                    <p>{new Date(f.saved_at).toLocaleString()}</p>
                    <p>
                      {f.qualification === "ready"
                        ? "回应命题已完成归属加工和独立复核，可用于有范围的报告；不代表事实已证实。"
                        : f.qualification === "context_only"
                          ? "已分析归属：目前仅保留为背景或未知，未转为个人依据。"
                          : f.qualification === "rejected"
                            ? "归属加工未通过复核，尚未进入报告依据。"
                            : f.qualification === "not_applicable"
                              ? "有帮助评价已保存，不进入证据加工。"
                              : "原话已保存，归属与命题加工尚未完成。"}
                    </p>
                    {f.error && <p className="form-error">{blockedLabels[f.error] ?? f.error}</p>}
                    {data.capabilities.feedback_actions.find((a) => a.id === f.id)?.action ===
                      "revise_reason" && (
                      <label>
                        修改复评理由
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={1000}
                        />
                      </label>
                    )}
                    {data.capabilities.feedback_actions.find((a) => a.id === f.id)
                      ?.blocked_reason && (
                      <p className="fm-status">
                        {blockedLabels[
                          data.capabilities.feedback_actions.find((a) => a.id === f.id)
                            ?.blocked_reason ?? ""
                        ] ??
                          data.capabilities.feedback_actions.find((a) => a.id === f.id)
                            ?.blocked_reason}
                      </p>
                    )}
                    {data.capabilities.feedback_actions.find((a) => a.id === f.id)?.action && (
                      <p className="fm-meta">
                        以下处理会调用模型并独立审核；剩余调用 {data.capabilities.remaining_calls}。
                      </p>
                    )}
                    {data.capabilities.feedback_actions.find((a) => a.id === f.id)?.action && (
                      <button
                        type="button"
                        disabled={
                          busy ||
                          (data.capabilities.feedback_actions.find((a) => a.id === f.id)?.action ===
                            "revise_reason" &&
                            !reason.trim())
                        }
                        onClick={() => processFeedback(f.id)}
                      >
                        {data.capabilities.feedback_actions.find((a) => a.id === f.id)?.action ===
                        "recover"
                          ? "恢复处理"
                          : "处理这条回应"}
                      </button>
                    )}
                    {f.status === "accepted" && (
                      <>
                        <p>
                          这条回应对应的报告修订已通过独立审核。整体是否可用以整体复评状态为准。
                        </p>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            const t = data.topics.find((t) => t.domain === f.input.domain);
                            if (t) open(t);
                            else if (f.input.domain === "overall") {
                              setDomain(null);
                              setPage("overview");
                              setOverviewExpanded(true);
                            }
                          }}
                        >
                          阅读这个范围的当前版本
                        </button>
                      </>
                    )}
                  </article>
                ))}
            </section>
          )}

          {data.feedback.filter((f) => f.input.domain === (domain ?? "overall")).length === 0 && (
            <p className="fm-status">这个范围还没有回应记录。</p>
          )}
          <ReportHistory
            key={`${domain ?? "overall"}:${topic?.version ?? data.overall.version}:${topic?.status ?? data.overall.status}:${sourceState}`}
            domain={domain ?? "overall"}
            title={topic?.title ?? "整体认识"}
            feedback={data.feedback}
            onEvidence={showEvidence}
          />
          <details className="fm-history">
            <summary>旧认识的校正</summary>
            <p>
              {data.old_dispositions.status === "ready"
                ? "当前版本已复核，待本人评价"
                : data.old_dispositions.status === "needs_review"
                  ? "回应后的依赖尚待重新复核"
                  : "校正尚未完成"}
            </p>
            {data.old_dispositions.status === "ready" &&
              data.old_dispositions.report?.dispositions.map((d, i) => (
                <article key={d.old_id}>
                  <h3>
                    认识 {i + 1} · {d.disposition}
                  </h3>
                  {d.text && <p>{d.text}</p>}
                  <p>{d.scope}</p>
                  <p>{d.reason}</p>
                </article>
              ))}
          </details>
        </>
      )}
      <details className="fm-settings">
        <summary>来源与处理设置</summary>
        <p>
          模型处理{data.capabilities.provider_enabled ? "已启用" : "未启用"} · 剩余调用{" "}
          {data.capabilities.remaining_calls}
          。读取和保存均不调用模型；以下处理按钮会显式启动分析与独立审核。
        </p>
        <section aria-label="整体复评状态">
          <p>
            整体复评：{overallLabels[data.capabilities.overall.status]}{" "}
            {data.capabilities.overall.blocked_reason &&
              (blockedLabels[data.capabilities.overall.blocked_reason] ??
                data.capabilities.overall.blocked_reason)}
          </p>
          {data.capabilities.overall.action === "revise_reason" && (
            <label>
              修改复评理由
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </label>
          )}
          {data.capabilities.overall.action && (
            <button
              type="button"
              disabled={
                busy || (data.capabilities.overall.action === "revise_reason" && !reason.trim())
              }
              onClick={() => processFeedback()}
            >
              {data.capabilities.overall.action === "recover" ? "恢复整体复评" : "重新复评整体理解"}
            </button>
          )}
        </section>
        {data.capabilities.topic_recovery
          ?.filter((r) => !topic || r.domain === topic.domain)
          .map((r) => (
            <section className="home-section" key={r.domain}>
              <h2>
                {data.topics.find((t) => t.domain === r.domain)?.title ?? r.domain} · 来源恢复复核
              </h2>
              {r.blocked_reason && <p>{blockedLabels[r.blocked_reason] ?? r.blocked_reason}</p>}
              {r.action === "process" && (
                <label>
                  复核理由（可选；上次未通过时说明新的变化）
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={1000}
                  />
                </label>
              )}
              {r.action === "process" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => recoverTopic(r.domain, r.version)}
                >
                  重新复核此专题
                </button>
              )}
            </section>
          ))}
        {data.sources && data.sources.length > 0 && (
          <section className="home-section" aria-label="来源管理">
            <h2>来源管理</h2>
            {privateUnderstandingMode && <p>此入口可退休来源；重新绑定需要主 App 核验原生探索。</p>}
            {data.sources.map((source) => (
              <SourceControl
                key={`${source.source_id}:${source.lifecycle_revision}`}
                source={source}
                data={data}
                onReload={onReload}
              />
            ))}
          </section>
        )}

        <section className="home-section">
          <h2>独立框架与原生探索</h2>
          <p>
            HUMAN 3.0：{frameworkLabels[data.frameworks.human_3]}
            。原生基线不包含框架评分；独立访谈与完整报告请从主 App
            的“独立框架访谈”进入。专题正文中的原生探索入口会携带具体判断及版本。
          </p>
        </section>
      </details>
      {evidence && <ReportEvidenceDialog evidence={evidence} onClose={() => setEvidence(null)} />}
    </div>
  );
}
