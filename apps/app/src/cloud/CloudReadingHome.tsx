import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { cloudRequest } from "../cloud-api";
import type {
  CurrentUnderstandingResponse,
  ExplorationListResponse,
  ExplorationSummary,
  UnderstandingChange,
} from "../types";
import type { ReportPane } from "./RunDetail";
import { type Run, domainLabels, labels, message } from "./shared";

export function CloudReadingHome({
  runs,
  profile,
  mode,
  onOpen,
  onTalk,
}: {
  runs: Run[];
  profile: string;
  mode: "home" | "topics" | "history";
  onOpen: (runId: string, pane?: ReportPane) => void;
  /** Opens the conversation, optionally continuing a saved matter. */
  onTalk?: (explorationId?: string) => void;
}) {
  const [core, setCore] = useState<{
    current: CurrentUnderstandingResponse;
    changes: UnderstandingChange[];
    open: ExplorationSummary[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    setCore(null);
    if (profile && mode === "home")
      void Promise.all([
        cloudRequest<CurrentUnderstandingResponse>("/api/core/understanding"),
        cloudRequest<{ items: UnderstandingChange[] }>("/api/core/understanding/changes?limit=8"),
        cloudRequest<ExplorationListResponse>("/api/core/explorations?status=active&limit=5"),
      ])
        .then(([current, changes, open]) => {
          if (active)
            setCore({
              current: { ...current, claims: current.claims ?? [] },
              changes: changes.items ?? [],
              open: (open.items ?? []).filter((item) => !item.parked),
            });
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [profile, mode]);
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
  const reportTime = overview?.updated_at ?? overall?.updated_at ?? null;
  const laterChanges =
    core && reportTime
      ? core.changes.filter((c) => new Date(c.changed_at) > new Date(reportTime))
      : [];
  const coreClaims = core?.current.claims ?? [];
  // D30: an unfinished matter comes first; right after a first review with no
  // conversation yet, the report invites checking; otherwise start from today.
  const firstReview = !!current && !coreClaims.length && !core?.open.length;
  const continueBlock = mode === "home" && !!core?.open.length && (
    <section className="home-section" aria-label="还没谈完的事">
      <div className="section-head">
        <h2>接着上次的事</h2>
      </div>
      {core.open.slice(0, 2).map((item) => (
        <article key={item.id}>
          <p>
            <strong>{item.summary.slice(0, 80)}</strong>
          </p>
          <p className="muted">
            {item.open_question
              ? `等你回答：${item.open_question.question}`
              : item.key_uncertainty
                ? `卡在：${item.key_uncertainty}`
                : "可以接着说"}
          </p>
          <button type="button" className="button primary" onClick={() => onTalk?.(item.id)}>
            继续这件事
          </button>
        </article>
      ))}
    </section>
  );
  const nowBlock = mode === "home" && core && (
    <section className="home-section" aria-label="当前认识">
      <div className="section-head">
        <h2>现在的理解</h2>
        <span className="fm-meta">{coreClaims.length} 条有效认识</span>
      </div>
      {!core.open.length && (
        <button type="button" className="button primary" onClick={() => onTalk?.()}>
          说一件现在在意的事
        </button>
      )}
      {coreClaims.length > 0 && (
        <ul>
          {coreClaims.slice(0, 5).map((claim) => (
            <li key={claim.claim_revision_id}>
              {claim.text}
              <br />
              <span className="muted">适用范围：{claim.scope}</span>
            </li>
          ))}
        </ul>
      )}
      {core.changes.length > 0 && (
        <details className="fm-secondary-nav">
          <summary>最近的认识变化</summary>
          <ul>
            {core.changes.map((change) => (
              <li key={change.claim_revision_id}>
                <span className="fm-status">{CHANGE_LABEL[change.change]}</span> {change.text}
                <br />
                <span className="muted">
                  {new Date(change.changed_at).toLocaleDateString("zh-CN")}
                  {change.reason ? ` · ${change.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
  return (
    <section>
      {!firstReview && continueBlock}
      {!firstReview && nowBlock}
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
                处变化（见“现在的理解”）。报告中涉及这些内容的判断可能已不再成立，以现在的理解为准。
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
      {firstReview && continueBlock}
      {firstReview && nowBlock}
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
}

const CHANGE_LABEL: Record<UnderstandingChange["change"], string> = {
  added: "新形成",
  revised: "已修订",
  withdrawn: "已停用",
};
