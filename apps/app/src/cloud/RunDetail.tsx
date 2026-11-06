import type { UnderstandingReport } from "@findme/core";
import { ChevronLeft, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudMutation, cloudRequest, cloudSources, currentCloudProfile } from "../cloud-api";
import {
  type Evidence,
  type Job,
  type Run,
  type Source,
  domainLabels,
  labels,
  message,
} from "./shared";

export type ReportPane = "read" | "correct" | "history";
type ReportVersion = { version: number; status: string; report: UnderstandingReport | null };
type ResponseDraft = {
  note: string;
  kind: string;
  target: { version: number; revisionId: string | null; reportVersion: number } | null;
};
const responseLabels: Record<string, string> = {
  supplement: "补充重要背景",
  inaccurate: "理解不准确",
  context_only: "仅某种情境成立",
  changed_now: "现在已经不同",
  helpful: "有帮助",
};
function useResponseDraft(key: string) {
  const [draft, setDraft] = useState<ResponseDraft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${key}:bound`) ?? "null");
      if (
        saved &&
        typeof saved.note === "string" &&
        saved.kind in responseLabels &&
        (saved.target === null ||
          (Number.isInteger(saved.target?.version) &&
            Number.isInteger(saved.target?.reportVersion) &&
            (saved.target.revisionId === null || typeof saved.target.revisionId === "string")))
      )
        return saved;
      return { note: localStorage.getItem(key) ?? "", kind: "supplement", target: null };
    } catch {
      return { note: "", kind: "supplement", target: null };
    }
  });
  useEffect(() => {
    try {
      if (draft.note || draft.target) localStorage.setItem(`${key}:bound`, JSON.stringify(draft));
      else {
        localStorage.removeItem(`${key}:bound`);
        localStorage.removeItem(key);
      }
    } catch {
      /* The in-memory draft remains available. */
    }
  }, [key, draft]);
  return [draft, setDraft] as const;
}
function Report({
  report,
  onEvidence,
  onCorrect,
}: {
  report: UnderstandingReport;
  onEvidence?: (ids: string[], role: string) => void;
  onCorrect?: () => void;
}) {
  const findings = [
    report.current_understanding,
    ...report.findings,
    ...report.resources_conditions_costs,
  ].filter((f) => f !== null);
  const nodes = new Map(report.nodes.map((node) => [node.key, node.text]));
  return (
    <div className="cloud-report fm-reading">
      {findings.map((f) => (
        <article className="claim-card" key={f.key}>
          <span className="fm-status">
            {f.status === "unknown"
              ? "保持未知"
              : f === report.current_understanding
                ? "当前理解"
                : report.resources_conditions_costs.includes(f)
                  ? "资源、条件与代价"
                  : "专题判断"}
          </span>
          <h2>{f.text}</h2>
          <div className="claim-scope">
            <span>适用范围</span>
            <p>{f.scope}</p>
          </div>
          {f.time && <small>时间范围：{f.time}</small>}
          <div className="cloud-actions">
            {(
              [
                ["支持", f.evidence_ids],
                ["反例", f.counterevidence_ids],
                ["背景", f.context_ids],
              ] as const
            ).map(
              ([role, ids]) =>
                ids.length > 0 && (
                  <button
                    type="button"
                    key={role}
                    disabled={!onEvidence}
                    onClick={() => onEvidence?.([...ids], role)}
                  >
                    {role}依据 · {ids.length}
                  </button>
                ),
            )}
            {onCorrect && (
              <button type="button" className="button primary" onClick={onCorrect}>
                纠正或补充这份理解
              </button>
            )}
          </div>
        </article>
      ))}
      {report.nodes.length > 0 && (
        <details>
          <summary>展开情境与有依据的关系</summary>
          <p>关系只表达报告中已有的关联；共享原话不重复计算为独立依据。</p>
          {report.nodes.map((n) => (
            <article key={n.key}>
              <h3>{n.text}</h3>
              <p>{n.scope}</p>
              {onEvidence && n.evidence_ids.length > 0 && (
                <button type="button" onClick={() => onEvidence(n.evidence_ids, "情境")}>
                  查看情境依据
                </button>
              )}
            </article>
          ))}
          {report.links.map((l) => (
            <article key={l.key}>
              <p>
                {nodes.get(l.from) ?? "未知命题"} · {l.type} · {nodes.get(l.to) ?? "未知命题"}
              </p>
              <small>{l.scope}</small>
              {onEvidence && l.evidence_ids.length > 0 && (
                <button type="button" onClick={() => onEvidence(l.evidence_ids, "关系")}>
                  查看关系依据
                </button>
              )}
            </article>
          ))}
        </details>
      )}
      {!!report.alternatives.length && (
        <section className="home-section">
          <h2>还可能怎样解释</h2>
          {report.alternatives.map((a) => (
            <p key={a}>{a}</p>
          ))}
        </section>
      )}
      {!!report.unknowns.length && (
        <section className="home-section">
          <h2>仍然未知的部分</h2>
          {report.unknowns.map((u) => (
            <p key={u}>{u}</p>
          ))}
        </section>
      )}
      {report.question && (
        <section className="home-section">
          <h2>值得继续理解</h2>
          <p>{report.question.text}</p>
          {report.question.branches.map((branch) => (
            <p key={branch}>{branch}</p>
          ))}
        </section>
      )}
      {report.next_step && (
        <section className="home-section">
          <h2>可选的下一步</h2>
          <p>{report.next_step}</p>
        </section>
      )}
    </div>
  );
}
function EvidenceDrawer({
  rows,
  role,
  onClose,
}: { rows: Evidence[]; role: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
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
      aria-labelledby="cloud-evidence-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="section-head">
        <h2 id="cloud-evidence-title">{role}依据与原话</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭依据">
          <X size={20} />
        </button>
      </div>
      <p>原话只说明当时的表达，不单独证明一个稳定特征。</p>
      {rows.map((e) => (
        <article className="cloud-evidence" key={e.evidence_id}>
          <blockquote>{e.quote}</blockquote>
          <p>
            披露时间：{e.reported_at ?? "未知"} · 事件时间：{e.occurred_at ?? "未知"}
          </p>
          {e.qualifier && <p>限定：{e.qualifier}</p>}
          {e.about && <p>谈论对象：{e.about}</p>}
          {e.stance && <p>立场：{e.stance}</p>}
          {e.scope && <p>适用范围：{e.scope}</p>}
          <details>
            <summary>来源定位与归属</summary>
            <p>表达者：{e.content_author}</p>
            <p>
              {e.content_scope === "quote_excerpt" ? "精确引文片段，不是整段会话" : "原文位置"}：
              {e.start}–{e.end}（UTF-16）
            </p>
            {e.session_id && <p>会话：{e.session_id}</p>}
            {e.message_id && <p>消息：{e.message_id}</p>}
            {!!e.source_ids?.length && <p>原来源：{e.source_ids.join("、")}</p>}
          </details>
        </article>
      ))}
      <button type="button" className="button secondary" onClick={onClose}>
        返回阅读
      </button>
    </dialog>
  );
}
export function RunDetail({
  runId,
  userId,
  onBack,
  initialPane = "read",
  onUpdated,
}: {
  runId: string;
  userId: string;
  onBack: () => void;
  initialPane?: ReportPane;
  onUpdated: () => Promise<void>;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [pane, setPane] = useState<ReportPane>(initialPane);
  const [responses, setResponses] = useState<
    { id: string; note: string; kind: string; processing_status: string }[]
  >([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [draft, setDraft] = useResponseDraft(
    `findme_cloud:draft:${userId}:${currentCloudProfile()}:${runId}`,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [evidence, setEvidence] = useState<{ rows: Evidence[]; role: string } | null>(null);
  const [historyRows, setHistoryRows] = useState<
    { id: string; version: number; status: string }[] | null
  >(null);
  const [past, setPast] = useState<ReportVersion | null>(null);
  const [sourceChoices, setSourceChoices] = useState<Source[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [topicChoices, setTopicChoices] = useState<Run[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const reload = useCallback(async () => {
    try {
      const [r, rs, js] = await Promise.all([
        cloudRequest<Run>(`/api/diagnostics/${runId}`),
        cloudRequest<typeof responses>(`/api/diagnostics/${runId}/responses`),
        cloudRequest<Job[]>(`/api/diagnostics/${runId}/jobs`),
      ]);
      setRun(r);
      setResponses(rs);
      setJobs(js);
      setEvidence(null);
      setPast(null);
      setHistoryRows(null);
    } catch (e) {
      setRun(null);
      setEvidence(null);
      setPast(null);
      throw e;
    }
  }, [runId]);
  useEffect(() => {
    void reload().catch((e) => setError(message(e)));
  }, [reload]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === "running" || j.status === "queued")) return;
    const timer = setInterval(
      () =>
        void reload()
          .then(onUpdated)
          .catch((e) => setError(message(e))),
      4000,
    );
    return () => clearInterval(timer);
  }, [jobs, reload, onUpdated]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function bindCurrent() {
    if (!run) return;
    setDraft((d) => ({
      ...d,
      target: {
        version: run.version,
        revisionId: run.report_revision_id ?? null,
        reportVersion: run.head_version,
      },
    }));
  }
  function showPane(next: ReportPane) {
    setPane(next);
    setEvidence(null);
    if (next === "correct") setReceipt("");
    if (next === "correct" && !draft.note && !draft.target) bindCurrent();
    window.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  async function saveResponse() {
    if (!run || !draft.target || !draft.note.trim()) return;
    await cloudMutation(`/api/diagnostics/${run.id}/responses`, {
      expected_version: draft.target.version,
      report_revision_id: draft.target.revisionId,
      kind: draft.kind,
      note: draft.note,
    });
    setReceipt(
      draft.kind === "helpful"
        ? "评价已保存，不作为独立证据。"
        : "纠正已保存，等待核验；当前报告尚未因此改变。",
    );
    setDraft({ note: "", kind: "supplement", target: null });
    setPane("history");
    await reload();
    await onUpdated();
  }
  async function process() {
    if (!run) return;
    const body = {
      expected_version: run.version,
      source_ids: selectedSources,
      topic_run_ids: topics,
      provider_call_cap: 0,
    };
    const plan = await cloudMutation<{
      model: string | null;
      enabled: boolean;
      required_calls: number;
      remaining_profile_calls: number;
      source_ids: string[];
      estimated_input_bytes: number;
    }>(`/api/diagnostics/${run.id}/process/plan`, body);
    // The service budgets model use; the owner only asks for a new version.
    if (!plan.enabled) throw new Error("报告处理暂不可用，已保存的回应保持不变。");
    await cloudMutation(`/api/diagnostics/${run.id}/process`, {
      ...body,
      provider_call_cap: plan.required_calls,
    });
    await reload();
    await onUpdated();
  }
  if (!run)
    return (
      <section>
        <button className="button secondary" type="button" onClick={onBack}>
          返回当前理解
        </button>
        <p aria-live="polite">{error || "正在读取当前报告…"}</p>
        {error && (
          <button type="button" onClick={() => void action(reload)}>
            重新读取
          </button>
        )}
      </section>
    );
  const stale =
    draft.target !== null &&
    (draft.target.version !== run.version ||
      draft.target.revisionId !== (run.report_revision_id ?? null));
  const currentReport =
    run.status === "ready" && run.report_status === "accepted" ? run.report : null;
  return (
    <section className="cloud-detail">
      <div className="section-head">
        <button type="button" onClick={onBack}>
          <ChevronLeft size={18} />
          返回当前理解
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await reload();
              await onUpdated();
            })
          }
          aria-label="重新读取当前报告"
        >
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="fm-nav cloud-actions" aria-label="报告阅读与修订">
        {(
          [
            ["read", "阅读理解"],
            ["correct", "纠正与补充"],
            ["history", "修订记录"],
          ] as const
        ).map(([key, title]) => (
          <button type="button" key={key} aria-pressed={pane === key} onClick={() => showPane(key)}>
            {title}
          </button>
        ))}
      </div>
      <div className="fm-meta">
        <span>{domainLabels[run.domain] ?? "专题理解"}</span>
        <span className="fm-status">{labels[run.status] ?? run.status}</span>
        <span>报告版本 {run.head_version || "尚无"}</span>
      </div>
      <h1 ref={heading} tabIndex={-1}>
        {pane === "correct"
          ? "让这份理解，更贴近当时的你。"
          : pane === "history"
            ? "认识在变，来由看得见。"
            : (currentReport?.headline ?? run.question)}
      </h1>
      {error && (
        <p className="form-error" role="alert">
          {error}。未提交的文字仍保留。
        </p>
      )}
      {receipt && (
        <p className="fm-status" aria-live="polite">
          {receipt}
        </p>
      )}
      {pane === "read" && (
        <div className="fm-reading-layout">
          <article>
            {currentReport ? (
              <Report
                report={currentReport}
                onCorrect={() => showPane("correct")}
                onEvidence={(ids, role) =>
                  void action(async () =>
                    setEvidence({
                      role,
                      rows: await Promise.all(
                        [...new Set(ids)].map((id) =>
                          cloudRequest<Evidence>(
                            `/api/diagnostics/${run.id}/evidence?evidence_id=${encodeURIComponent(id)}`,
                          ),
                        ),
                      ),
                    }),
                  )
                }
              />
            ) : (
              <section className="home-section">
                <h2>当前没有可读的已审核报告</h2>
                <p>
                  尚未完成、来源待核验或审核失败的内容不会作为当前认识展示。你仍可以补充经历或查看处理状态。
                </p>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => showPane("correct")}
                >
                  补充经历
                </button>
              </section>
            )}
          </article>
          <aside className="fm-margin-notes">
            <section>
              <h3>理解的范围</h3>
              <p>
                {currentReport?.current_understanding?.scope ??
                  "以当前专题的可用依据为限，资料不足处保持未知。"}
              </p>
            </section>
            {!!currentReport?.unknowns.length && (
              <section>
                <h3>还缺什么</h3>
                {currentReport.unknowns.map((u) => (
                  <p key={u}>{u}</p>
                ))}
              </section>
            )}
            <section>
              <h3>你可以不同意</h3>
              <p>纠正与补充绑定正在阅读的报告版本。保存之后仍须核验，不会直接改写判断。</p>
              <button type="button" onClick={() => showPane("correct")}>
                回应这份理解
              </button>
            </section>
            {run.report_origin?.kind === "u2_approved_import" && (
              <details>
                <summary>这份报告的来由</summary>
                <p>来自原 U2 审核导入，不代表在账号模式重新审核。</p>
                <p>
                  {run.report_origin.provenance_available === false
                    ? "原审核出处当前不可用。"
                    : `原版本 ${run.report_origin.report_version ?? "未知"}；审核记录 ${run.report_origin.audit_hash?.slice(0, 12) ?? "未知"}；原审核任务 raw 未归档。`}
                </p>
              </details>
            )}
          </aside>
        </div>
      )}
      {pane === "correct" && (
        <div className="fm-reading-layout">
          <section className="fm-correction">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!stale && draft.target) void action(saveResponse);
              }}
            >
              <div className="claim-card">
                <span className="fm-meta">
                  正在回应 ·{" "}
                  {draft.target
                    ? `报告版本 ${draft.target.reportVersion || "尚无"}`
                    : "尚未绑定报告"}
                </span>
                <blockquote>{currentReport?.headline ?? run.question}</blockquote>
                <p>回应整份报告。若要纠正某句话，请在补充中指出具体表述。</p>
              </div>
              <fieldset>
                <legend>哪里需要重新理解？</legend>
                <div className="fm-feedback-choices">
                  {Object.entries(responseLabels).map(([key, title]) => (
                    <label className="cloud-choice" key={key}>
                      <input
                        type="radio"
                        name="response-kind"
                        value={key}
                        checked={draft.kind === key}
                        disabled={busy}
                        onChange={() => setDraft((d) => ({ ...d, kind: key }))}
                      />
                      {title}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label>
                你知道的情况
                <textarea
                  rows={6}
                  maxLength={5000}
                  value={draft.note}
                  disabled={busy}
                  onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                  placeholder="哪部分不准确？当时还有什么重要背景？"
                  required
                />
              </label>
              {(stale || !draft.target) && (
                <div className="home-section">
                  <p>
                    {stale
                      ? "目标报告或运行版本已变化。草稿仍保留，尚未移到新版本。"
                      : "这份草稿尚未绑定版本，请先核对当前报告。"}
                  </p>
                  <button type="button" disabled={busy} onClick={bindCurrent}>
                    已核对，按当前版本继续
                  </button>
                </div>
              )}
              <div className="cloud-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || stale || !draft.target || !draft.note.trim()}
                >
                  {busy ? "保存中…" : "保存纠正，等待核验"}
                </button>
                <button type="button" onClick={() => showPane("read")}>
                  返回阅读，保留草稿
                </button>
              </div>
            </form>
          </section>
          <aside className="fm-margin-notes">
            <section>
              <h3>提交之后会怎样</h3>
              <p>保存只记录你的原话。已完成的修订、待核验的回应和失败的处理会分开显示。</p>
            </section>
            <section>
              <h3>当前不会启动分析</h3>
              <p>需要新的报告版本时，在“修订记录”里点“生成新的报告版本”。</p>
            </section>
          </aside>
        </div>
      )}
      {pane === "history" && (
        <div className="fm-history">
          <section className="home-section">
            <h2>回应与处理状态</h2>
            {responses.length === 0 && (
              <p>目前没有已保存的回应。可以先阅读，再核对其中的具体判断。</p>
            )}
            {responses.map((x) => (
              <article key={x.id}>
                <div className="fm-meta">
                  <span className="fm-status">
                    {labels[x.processing_status] ?? x.processing_status}
                  </span>
                  <span>{responseLabels[x.kind] ?? x.kind}</span>
                </div>
                <p>{x.note}</p>
              </article>
            ))}
          </section>
          <section className="home-section">
            <h2>报告版本与修订前后</h2>
            <p>读取真实版本进行对照。当前接口没有单独的修订理由字段，不据版本变化推测原因。</p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () =>
                  setHistoryRows(await cloudRequest(`/api/diagnostics/${run.id}/history`)),
                )
              }
            >
              读取版本记录
            </button>
            {historyRows?.length === 0 && <p>尚无报告版本。</p>}
            <div className="cloud-actions">
              {historyRows?.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  disabled={busy}
                  aria-pressed={past?.version === h.version}
                  onClick={() =>
                    void action(async () => {
                      setPast(null);
                      setPast(
                        await cloudRequest(`/api/diagnostics/${run.id}/history/${h.version}`),
                      );
                    })
                  }
                >
                  版本 {h.version}
                  {h.version === run.head_version ? " · 当前" : " · 历史"} ·{" "}
                  {labels[h.status] ?? h.status}
                </button>
              ))}
            </div>
            {past && (
              <>
                <p>
                  历史版本只读，不改变当前认识。历史依据接口尚未提供按版本读取，因此不混用当前依据。
                </p>
                {past.report ? (
                  <>
                    <div className="fm-diff">
                      <section>
                        <h3>
                          {past.version === run.head_version ? "所选当前版本" : "修订前"} · 版本{" "}
                          {past.version}
                        </h3>
                        <p>{past.report.current_understanding?.text ?? past.report.headline}</p>
                      </section>
                      {past.version !== run.head_version && (
                        <section>
                          <h3>当前 · 版本 {run.head_version}</h3>
                          <p>
                            {currentReport?.current_understanding?.text ??
                              currentReport?.headline ??
                              "当前报告不可读，无法作版本对照。"}
                          </p>
                        </section>
                      )}
                    </div>
                    <details>
                      <summary>展开所选版本的完整报告</summary>
                      <h2>{past.report.headline}</h2>
                      <Report report={past.report} />
                    </details>
                  </>
                ) : (
                  <p>此版本当前不可展示：{labels[past.status] ?? past.status}。</p>
                )}
              </>
            )}
          </section>
          <details>
            <summary>继续处理与历史材料</summary>
            <p>保存回应不会自动生成新报告；需要时点下面的按钮。</p>
            <details>
              <summary>选择历史材料与专题依据</summary>
              {run.report_origin?.kind === "u2_approved_import" && (
                <p>
                  归档只保存精确引文片段，不能把它们当作完整原文再次分析；可提交新的经历或纠正。
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const sources = await cloudSources<Source>();
                    setSourceChoices(
                      sources.filter(
                        (s) => s.status === "active" && s.source_kind !== "u2_quote_excerpt",
                      ),
                    );
                    setTopicChoices(await cloudRequest<Run[]>("/api/diagnostics?limit=50"));
                  })
                }
              >
                读取可选资料
              </button>
              <p>
                可选资料共 {sourceChoices.length} 条 · 已选 {selectedSources.length} 条
              </p>
              {sourceChoices.map((s) => (
                <label className="cloud-choice" key={s.id}>
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(s.id)}
                    onChange={(e) =>
                      setSelectedSources((xs) =>
                        e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id),
                      )
                    }
                  />
                  {s.text?.slice(0, 160)}
                </label>
              ))}
              {run.domain === "overall" &&
                topicChoices
                  .filter((t) => t.status === "ready" && t.domain !== "overall")
                  .map((t) => (
                    <label key={t.id} className="cloud-choice">
                      <input
                        type="checkbox"
                        checked={topics.includes(t.id)}
                        onChange={(e) =>
                          setTopics((xs) =>
                            e.target.checked ? [...xs, t.id] : xs.filter((x) => x !== t.id),
                          )
                        }
                      />
                      {t.question}
                    </label>
                  ))}
              <p>
                未处理的新回应始终纳入；旧材料只按明确选择和既有引用归并。超出处理边界会停止，不悄悄截断。
              </p>
            </details>
            <button
              type="button"
              disabled={busy || jobs.some((j) => j.status === "running" || j.status === "queued")}
              onClick={() => void action(process)}
            >
              生成新的报告版本
            </button>
          </details>
          <section>
            <h3>处理任务</h3>
            {jobs.map((j) => (
              <article key={j.id}>
                <p>{labels[j.status] ?? j.status}</p>
                {j.error && <small>{j.error}</small>}
                <div className="cloud-actions">
                  {["queued", "running"].includes(j.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await cloudMutation(`/api/diagnostics/jobs/${j.id}/cancel`, {});
                          await reload();
                        })
                      }
                    >
                      取消后续处理
                    </button>
                  )}
                  {["failed", "queued", "running"].includes(j.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          // The service decides the budget for the next round.
                          await cloudMutation(`/api/diagnostics/jobs/${j.id}/resume`, {});
                          await reload();
                        })
                      }
                    >
                      继续处理
                    </button>
                  )}
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
      {evidence && (
        <EvidenceDrawer
          rows={evidence.rows}
          role={evidence.role}
          onClose={() => setEvidence(null)}
        />
      )}
    </section>
  );
}
