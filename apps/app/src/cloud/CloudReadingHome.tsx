import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { cloudRequest } from "../cloud-api";
import type { ExplorationListResponse, ExplorationSummary, UnderstandingChange } from "../types";
import type { ReportPane } from "./RunDetail";
import { type Run, domainLabels, labels, message } from "./shared";

export function CloudReadingHome({
  runs,
  profile,
  mode,
  onOpen,
  onTalk,
  onStart,
  onUnderstanding,
  refreshToken = 0,
}: {
  runs: Run[];
  profile: string;
  mode: "home" | "topics" | "history";
  onOpen: (runId: string, pane?: ReportPane) => void;
  /** Opens the conversation, optionally continuing a saved matter. */
  onTalk?: (explorationId?: string) => void;
  onStart?: (message: string) => void;
  onUnderstanding?: () => void;
  /** Changes when the workspace refreshes (window visible again, home clicked). */
  refreshToken?: number;
}) {
  const [core, setCore] = useState<{
    changes: UnderstandingChange[];
    recent: ExplorationSummary[];
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [conversationError, setConversationError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken requests a re-read.
  useEffect(() => {
    // Keep the shown data until the newer read arrives; a superseded read is ignored.
    let active = true;
    if (profile && mode === "home")
      void Promise.all([
        cloudRequest<{ items: UnderstandingChange[] }>(
          "/api/core/understanding/changes?limit=8",
        ).catch(() => ({ items: [] })),
        cloudRequest<ExplorationListResponse>("/api/core/explorations?limit=8"),
      ])
        .then(([changes, open]) => {
          if (active) {
            setConversationError("");
            setCore({
              changes: changes.items ?? [],
              recent: (open.items ?? []).filter((item) => item.status !== "abandoned"),
            });
          }
        })
        .catch(() => {
          if (active)
            setConversationError("最近对话暂时读不到，可以先聊件新的，或稍后重新打开首页。");
        });
    return () => {
      active = false;
    };
  }, [profile, mode, refreshToken]);
  const overall = runs.find((r) => r.domain === "overall");
  const [overview, setOverview] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const id = overall?.id;
  const runVersion = overall?.version;
  const status = overall?.status;
  const reportVersion = overall?.head_version;
  useEffect(() => {
    let active = true;
    setOverview(null);
    setError("");
    if (profile && id && runVersion && status === "ready" && reportVersion) {
      void cloudRequest<Run>(`/api/diagnostics/${id}`)
        .then((next) => {
          if (active) setOverview(next);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    }
    return () => {
      active = false;
    };
  }, [id, runVersion, status, reportVersion, profile]);
  const current =
    overview &&
    overview.id === id &&
    overview.version === runVersion &&
    overview.status === "ready" &&
    overview.report_status === "accepted"
      ? overview.report
      : null;
  const topicRuns = mode === "history" ? runs : runs.filter((r) => r.domain !== "overall");
  // The report revision's own generation time: the run's updated_at also moves
  // on feedback such as "helpful", which does not change the report.
  const reportTime = overview?.report_created_at ?? null;
  const laterChanges =
    core && reportTime
      ? core.changes.filter((c) => new Date(c.changed_at) > new Date(reportTime))
      : [];
  const reportContent = (
    <section>
      {mode === "home" ? (
        <section className="fm-hero">
          <div>
            <div className="fm-meta">
              <span>整体报告</span>
              {current && <span className="fm-status">报告版本 {overview?.head_version}</span>}
              {current && reportTime && (
                <span>生成于 {new Date(reportTime).toLocaleDateString("zh-CN")}</span>
              )}
            </div>
            <h1>{current?.headline ?? "从具体经历，逐渐理解自己。"}</h1>
            <p>
              {current?.current_understanding?.text ??
                "整体认识尚无可读的已审核版本。已通过的专题仍可以单独阅读，未完成的内容不会被拼成综合结论。"}
            </p>
            {current && laterChanges.length > 0 && (
              <p className="form-error">
                这份报告生成之后，你的认识有 {laterChanges.length}{" "}
                处变化。报告中涉及这些内容的判断可能已不再成立，以现在的理解为准。
              </p>
            )}
            <div className="cloud-actions">
              {current && overall && (
                <button type="button" className="button primary" onClick={() => onOpen(overall.id)}>
                  阅读整体认识
                </button>
              )}
              {overall && !current && (
                <button type="button" onClick={() => onOpen(overall.id)}>
                  查看整体处理状态
                </button>
              )}
            </div>
          </div>
          <aside>
            <h3>理解的范围</h3>
            <p>
              {current?.current_understanding?.scope ??
                "以当前可用的材料和专题为限，资料不足的部分保持未知。"}
            </p>
            {!!current?.unknowns.length && (
              <>
                <h3>仍需理解</h3>
                <p>{current.unknowns[0]}</p>
              </>
            )}
          </aside>
        </section>
      ) : (
        <section className="fm-hero">
          <div>
            <div className="fm-meta">{mode === "topics" ? "专题阅读" : "纠正与修订"}</div>
            <h1>{mode === "topics" ? "把认识，放回具体情境。" : "认识在变，来由看得见。"}</h1>
            <p>
              {mode === "topics"
                ? "按需要深入专题，查看判断的依据、范围和未知。"
                : "选择一份理解，查看已保存的回应、真实处理状态及报告版本。"}
            </p>
          </div>
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          整体报告读取失败：{error}。未展示缓存结论，请重新读取。
        </p>
      )}
      <section className="home-section">
        <div className="section-head">
          <h2>{mode === "history" ? "选择要回看的理解" : "从整体，走进具体"}</h2>
          <span className="fm-meta">
            {topicRuns.length} 个{mode === "history" ? "范围" : "专题"}
          </span>
        </div>
        {!topicRuns.length && (
          <p>还没有专题。从一个想理解的问题或一件实际经历开始，保存不会自动启动模型。</p>
        )}
        <div className="fm-topic-grid">
          {topicRuns.map((r) => (
            <button
              className="fm-topic-card"
              type="button"
              key={r.id}
              onClick={() => onOpen(r.id, mode === "history" ? "history" : "read")}
            >
              <span className="fm-status">{labels[r.status] ?? r.status}</span>
              <h3>{r.question}</h3>
              <p>
                {domainLabels[r.domain] ?? "专题理解"}
                {r.head_version > 0 ? ` · 报告版本 ${r.head_version}` : " · 尚无报告"}
              </p>
              <span className="fm-topic-foot">
                {mode === "history" ? "查看回应与版本" : "进入专题"}
                <ChevronRight size={18} />
              </span>
            </button>
          ))}
        </div>
      </section>
      {mode === "home" && !!current?.links.length && (
        <details className="fm-secondary-nav">
          <summary>这些认识之间，有哪些关联？</summary>
          <p>以下只展示报告中已经有依据的关系，不把相关性视为因果。</p>
          {current.links.map((l) => (
            <article key={l.key}>
              <p>
                {current.nodes.find((n) => n.key === l.from)?.text ?? "未命名命题"} · {l.type} ·{" "}
                {current.nodes.find((n) => n.key === l.to)?.text ?? "未命名命题"}
              </p>
              <small>{l.scope}</small>
            </article>
          ))}
        </details>
      )}
    </section>
  );
  if (mode !== "home") return reportContent;
  return (
    <section className="daily-home" aria-label="日常交流">
      <header className="daily-home-heading">
        <span className="fm-meta">FINDME · 日常商量</span>
        <h1>今天，想从哪里说起？</h1>
        <p className="muted">一个问题，一点近况，或者还没想清楚的念头。</p>
      </header>
      <form
        className="daily-home-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || !onStart) return;
          onStart(draft.trim());
          setDraft("");
        }}
      >
        <label className="sr-only" htmlFor="home-message">
          聊件新的
        </label>
        <textarea
          id="home-message"
          value={draft}
          maxLength={5000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="说一件现在在意的事……"
        />
        <div className="daily-home-composer-foot">
          <span className="muted">不用先整理好再说</span>
          <button type="submit" className="button primary" disabled={!draft.trim() || !onStart}>
            发送 ↑
          </button>
        </div>
      </form>
      <section className="daily-recent" aria-label="最近对话">
        <div className="section-head">
          <h2>接着聊</h2>
          <button type="button" className="daily-text-button" onClick={() => onTalk?.()}>
            聊件新的 ＋
          </button>
        </div>
        {conversationError && <output className="muted">{conversationError}</output>}
        {!core && !conversationError && <p className="muted">正在找回最近的对话…</p>}
        {core && core.recent.length === 0 && (
          <p className="muted">还没有对话。从上面说件现在在意的事就好。</p>
        )}
        {core?.recent.map((item) => (
          <button
            key={item.id}
            type="button"
            className="daily-recent-talk"
            onClick={() => onTalk?.(item.id)}
          >
            <span>
              <strong>{item.summary.slice(0, 100) || "未命名对话"}</strong>
              <span className="daily-recent-meta">
                {new Date(item.last_activity_at).toLocaleDateString("zh-CN")}
                {item.status === "completed"
                  ? " · 已结束，仍可接着聊"
                  : item.parked
                    ? " · 暂放这里"
                    : " · 可以接着说"}
              </span>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ))}
      </section>
      <div className="daily-home-understanding">
        <div>
          <h2>慢慢认识自己</h2>
          <p className="muted">理解可以修改，不需要每次聊天都得出结论。</p>
        </div>
        <button type="button" className="daily-text-button" onClick={onUnderstanding}>
          看看已有认识 →
        </button>
      </div>
      {core && core.changes.length > 0 && (
        <details className="daily-changes">
          <summary>最近的认识变化</summary>
          {core.changes.map((change) => (
            <p key={change.claim_revision_id}>
              <span className="fm-meta">{CHANGE_LABEL[change.change]}</span> {change.text}
            </p>
          ))}
        </details>
      )}
      {(runs.length > 0 || error) && (
        <details className="daily-reports">
          <summary>整体报告与专题</summary>
          {reportContent}
        </details>
      )}
    </section>
  );
}

const CHANGE_LABEL: Record<UnderstandingChange["change"], string> = {
  added: "新形成",
  revised: "已修订",
  withdrawn: "已停用",
};
