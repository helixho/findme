import { useCallback, useEffect, useRef, useState } from "react";
import "./dogfood.css";

type Author = "subject" | "assistant" | "third_party" | "mixed" | "unknown";
type About = "self" | "third_party" | "project" | "unknown";
type Action = "adopt" | "exclude" | "correct" | "context" | "contested" | "time_update";
type Candidate = {
  id: string;
  start: number;
  end: number;
  quote: string;
  author: Author;
  about: About;
  stance: string;
  kind: string;
  uncertainty: string;
  status: string;
  revision: number;
  context: string[];
  judgedBy?: "model_candidate" | "owner";
  eligibility?: "eligible" | "context_only" | "excluded";
  provenanceStatus?: "current" | "stale";
  contextSourceIds?: string[];
};
class ReviewError extends Error {}

type Source = {
  review?: { revision: number; excluded: boolean; context: string[] };
  id: string;
  role: string;
  text?: string;
  time: string;
  sessionId: string;
  split: string;
  fingerprint: string;
  candidates: Candidate[];
  processing: { id: string; start: number; end: number; status: string }[];
};
type Claim = {
  id: string;
  revision: number;
  text: string;
  kind: string;
  mode: string;
  scope: string;
  evidence: string[];
  counterevidence: string[];
  rationale: string;
  alternatives: string[];
  changeCondition: string;
  status: string;
  history: unknown[];
  channel: string;
};
type DogfoodState = {
  nonce: string;
  version: number;
  manifest: {
    id: string;
    sessions: {
      id: string;
      split: string;
      groupId: string;
      selectionReasons: string[];
      project?: string | null;
      time: string;
    }[];
    independence: string;
    holdoutValidation: string;
  };
  sources: Source[];
  claims: Claim[];
  usage: {
    attempts: unknown[];
    reservedInput: number;
    outputCap: number;
    requestCap: number;
    inputCap: number;
  };
  runs: unknown[];
  feedback: unknown[];
};
type Review = {
  targetId: string;
  action: Action;
  author?: Author;
  about?: About;
  kind?: string;
  note?: string;
};
const labels: Record<string, string> = {
  candidate: "候选 · 待复核",
  adopted: "已采纳片段",
  excluded: "已排除",
  reviewed: "已复核认识",
  stale: "依据变更 · 待重评",
  invalid: "已失效",
  contested: "有争议",
  historical: "历史认识",
  pending: "未处理",
  running: "处理中",
  completed: "已处理",
  failed: "处理失败",
  self_report: "本人自述",
  evaluation: "明确评价",
  choice: "实际选择",
  work_requirement: "工作要求",
  quotation: "引用材料",
  system_wrapper: "系统包装",
  subject: "本人",
  assistant: "助手",
  third_party: "第三方",
  mixed: "混合",
  unknown: "未知",
  self: "本人",
  project: "项目",
  structured: "结构化分析",
  baseline: "普通总结对照",
};
function label(value: string) {
  return labels[value] ?? value;
}
function CandidateAssessment({ candidate }: { candidate: Candidate }) {
  return (
    <>
      <dt>归属判断</dt>
      <dd>
        {candidate.judgedBy === "owner"
          ? "本人已复核 / 更正归属"
          : candidate.judgedBy === "model_candidate"
            ? "模型候选判断 · 待本人复核"
            : "判断来源未提供"}
        {candidate.judgedBy === "owner" && candidate.status === "candidate" && " · 片段仍待采纳"}
      </dd>
      <dt>分析资格</dt>
      <dd>
        {candidate.eligibility === "eligible"
          ? "可用于分析"
          : candidate.eligibility === "context_only"
            ? "仅作为情境背景"
            : candidate.eligibility === "excluded"
              ? "已排除分析"
              : "资格未提供"}
      </dd>
      <dt>上下文有效性</dt>
      <dd>
        {candidate.provenanceStatus === "stale"
          ? "上下文已变更 · 旧片段判断失效，待重新提取 / 复核"
          : candidate.provenanceStatus === "current"
            ? "当前上下文有效"
            : "有效性未提供"}
      </dd>
    </>
  );
}
function JsonDetail({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="df-detail">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function ReviewControls({
  id,
  type,
  candidate,
  busy,
  onReview,
}: {
  id: string;
  type: "source" | "candidate" | "claim";
  candidate?: Candidate;
  busy: boolean;
  onReview: (review: Review) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [author, setAuthor] = useState<Author>(candidate?.author ?? "unknown");
  const [about, setAbout] = useState<About>(candidate?.about ?? "unknown");
  const [kind, setKind] = useState(candidate?.kind ?? "unknown");
  useEffect(() => {
    setAuthor(candidate?.author ?? "unknown");
    setAbout(candidate?.about ?? "unknown");
    setKind(candidate?.kind ?? "unknown");
  }, [candidate?.author, candidate?.about, candidate?.kind]);
  async function submit(action: Action) {
    const ok = await onReview({
      targetId: id,
      action,
      ...(action === "correct" ? { author, about, kind } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (ok) setNote("");
  }
  return (
    <details className="df-detail">
      <summary>复核 / 更正</summary>
      {type === "candidate" && (
        <div className="df-fields">
          <label>
            表达者
            <select value={author} onChange={(e) => setAuthor(e.target.value as Author)}>
              {["subject", "assistant", "third_party", "mixed", "unknown"].map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            描述对象
            <select value={about} onChange={(e) => setAbout(e.target.value as About)}>
              {["self", "third_party", "project", "unknown"].map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            表达类型
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {[
                "self_report",
                "evaluation",
                "choice",
                "work_requirement",
                "quotation",
                "system_wrapper",
                "unknown",
              ].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className="df-note">
        {type === "source" ? "来源背景 / 排除原因" : "补充背景 / 更正原因"}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="写下影响判断的背景或原因…"
        />
      </label>
      <div className="df-actions">
        {type !== "source" && (
          <button type="button" disabled={busy} onClick={() => void submit("adopt")}>
            {type === "claim" ? "确认已复核" : "采纳片段"}
          </button>
        )}
        {type !== "claim" && (
          <button type="button" disabled={busy} onClick={() => void submit("exclude")}>
            排除{type === "source" ? "整条来源" : "片段"}
          </button>
        )}
        {type === "candidate" && (
          <button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => void submit("correct")}
          >
            保存归属更正
          </button>
        )}
        {type === "claim" && (
          <>
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => void submit("contested")}
            >
              标记争议
            </button>
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => void submit("time_update")}
            >
              记录时间变化
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => void submit("context")}
        >
          补充背景
        </button>
      </div>
    </details>
  );
}
function unprocessed(source: Source) {
  if (typeof source.text !== "string") return null;
  const spans = source.processing
    .filter((p) => p.status === "completed")
    .sort((a, b) => a.start - b.start);
  let end = 0;
  let covered = 0;
  for (const span of spans) {
    const start = Math.max(0, Math.min(source.text.length, span.start));
    const next = Math.max(start, Math.min(source.text.length, span.end));
    covered += Math.max(0, next - Math.max(start, end));
    end = Math.max(end, next);
  }
  return Math.max(0, source.text.length - covered);
}
export default function Dogfood() {
  const [state, setState] = useState<DogfoodState | null>(null);
  const [section, setSection] = useState("sources");
  const [session, setSession] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/dogfood/state", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new ReviewError("读取失败，请确认本地内测服务已启动。");
    const next = (await response.json()) as DogfoodState;
    setState(next);
    setSession(
      (current) =>
        current ||
        next.sources.find((s) => s.candidates.length > 0)?.sessionId ||
        next.manifest.sessions.find((s) => s.split === "dev")?.id ||
        "",
    );
  }, []);
  useEffect(() => {
    void load().catch(() => setError("无法读取内测状态，请确认本地内测服务已启动后刷新。"));
  }, [load]);
  async function mutate(path: string, payload: object): Promise<boolean> {
    if (!state || locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/dogfood/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Dogfood-Nonce": state.nonce },
        body: JSON.stringify({
          ...payload,
          expectedVersion: state.version,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          await load();
          throw new ReviewError("状态已更新，已重新读取。请核对后再操作。");
        }
        if (response.status === 429)
          throw new ReviewError("本次操作达到用量限制，请查看 Usage 中的实际记录。");
        if (response.status === 403) throw new ReviewError("内测访问校验失败，请刷新页面后重试。");
        throw new ReviewError("操作未完成，请查看用量和运行记录，确认结果后再操作。");
      }
      const responseBody = (await response.json()) as {
        generation?: {
          outcome?: string;
          status?: string;
          retryRequired?: boolean;
          failedRuns?: number;
          pendingRuns?: number;
        };
      };
      // Always fetch persisted state; a successful request alone does not establish its result.
      await load();
      const generation = responseBody.generation;
      if (path === "generate" && generation?.status === "busy") {
        setMessage("已有相同处理正在进行；没有重复调用模型。稍后刷新状态。");
        return false;
      }
      if (path === "generate" && (generation?.retryRequired || generation?.failedRuns)) {
        setError("有处理失败的片段；已保存用量，未完成部分不会被当成分析结果。确认后可显式重试。");
        return false;
      }
      setMessage(
        path === "review"
          ? "复核已保存，状态已刷新。"
          : generation?.pendingRuns
            ? "本次已处理一部分，剩余材料仍标为未处理。"
            : "操作已完成，结果和用量已刷新。",
      );
      return true;
    } catch (e) {
      setError(
        e instanceof ReviewError
          ? e.message
          : "连接中断，操作结果尚未确认。请刷新状态和用量后再操作。",
      );
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const review = (value: Review) => mutate("review", value);
  const generate = (operation: string, retryFailed = false) =>
    mutate("generate", {
      operation,
      maxCalls: 1,
      retryFailed,
      ...(operation === "extract" ? { session, limit: 1 } : {}),
    });
  const evidence = new Map(
    state?.sources.flatMap((s) =>
      s.candidates.map((c) => [c.id, { candidate: c, source: s }] as const),
    ) ?? [],
  );
  function evidenceList(ids: string[]) {
    return ids.length ? (
      <ul>
        {ids.map((id) => {
          const found = evidence.get(id);
          const source = state?.sources.find((s) => s.id === id);
          return (
            <li key={id}>
              <a
                href={`#${source ? "source" : "fragment"}-${encodeURIComponent(id)}`}
                onClick={(event) => {
                  event.preventDefault();
                  const targetSource = found?.source ?? source;
                  if (!targetSource) return;
                  setSession(targetSource.sessionId);
                  if (targetSource.role !== "user") setShowContext(true);
                  setSection("sources");
                  const targetId = `${source ? "source" : "fragment"}-${encodeURIComponent(id)}`;
                  requestAnimationFrame(() => {
                    document.getElementById(targetId)?.scrollIntoView({ block: "start" });
                  });
                }}
              >
                {id}
              </a>
              {found ? (
                <>
                  <blockquote>{found.candidate.quote}</blockquote>
                  <small>
                    {found.source.sessionId} · {label(found.candidate.status)} · 表达者：
                    {label(found.candidate.author)}
                  </small>
                  <dl>
                    <CandidateAssessment candidate={found.candidate} />
                  </dl>
                </>
              ) : source ? (
                ` · ${source.sessionId} · ${source.role} · 见完整原文`
              ) : (
                " · 未找到可展示证据"
              )}
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="df-muted">暂无</p>
    );
  }
  return (
    <main className="dogfood">
      <header className="df-header">
        <div>
          <p className="eyebrow">FINDME · DOGFOOD</p>
          <h1>本人内测复核</h1>
          <p>加载和复核不调用模型。模型操作每次最多一次请求。</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void load()
              .then(() => {
                setError("");
                setMessage("状态已刷新。");
              })
              .catch(() => setError("刷新失败，请确认本地服务可用。"))
          }
        >
          刷新状态
        </button>
      </header>
      {error && (
        <p className="df-alert" role="alert">
          {error}
        </p>
      )}
      {message && <output className="df-message">{message}</output>}
      {busy && <output>正在保存或处理，请等待结果…</output>}
      {!state ? (
        <output>{error ? "内测状态尚未载入。" : "正在读取内测状态…"}</output>
      ) : (
        <>
          <div className="df-summary">
            <span>样本：{state.manifest.id}</span>
            <span>会话独立性：{label(state.manifest.independence)}（共享证据不计作独立支持）</span>
            <span>留出验证：{label(state.manifest.holdoutValidation)}</span>
          </div>
          <nav className="df-tabs" aria-label="内测区域">
            {[
              ["sources", "Sources · 来源"],
              ["insights", "Insights · 认识"],
              ["usage", "Usage · 用量"],
            ].map(([id, title]) => (
              <button
                type="button"
                key={id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => setSection(id)}
              >
                {title}
              </button>
            ))}
          </nav>
          <section hidden={section !== "sources"} aria-label="Sources">
            <div className="df-section-head">
              <div>
                <h2>来源与片段</h2>
                <p>原文完整保留；未提取内容仍可人工复核。留出材料不展示正文、不参与开发分析。</p>
              </div>
            </div>
            <div className="df-actions">
              <label>
                开发会话
                <select value={session} onChange={(e) => setSession(e.target.value)}>
                  <option value="">选择会话</option>
                  {state.manifest.sessions
                    .filter((s) => s.split === "dev")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.project || "会话"} · {s.time?.slice(0, 10) || "时间未知"} ·{" "}
                        {s.id.slice(-8)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="df-primary"
                disabled={busy || !session}
                onClick={() => void generate("extract")}
              >
                提取选中会话 · 最多一段 / 一次调用
              </button>
              <button
                type="button"
                disabled={busy || !session}
                onClick={() => void generate("extract", true)}
              >
                重试失败片段 · 一次调用
              </button>
            </div>
            <label className="df-context-toggle">
              <input
                type="checkbox"
                checked={showContext}
                onChange={(e) => setShowContext(e.target.checked)}
              />
              显示 AI / 系统上下文（不作本人独立证据）
            </label>
            <p className="df-muted">当前只展示选中会话；未抽取的人工消息仍完整保留。</p>
            <JsonDetail title="样本划分与选择理由" value={state.manifest.sessions} />
            {state.sources
              .filter(
                (source) => source.sessionId === session && (source.role === "user" || showContext),
              )
              .map((source) => (
                <article
                  className="df-source"
                  id={`source-${encodeURIComponent(source.id)}`}
                  key={source.id}
                >
                  <h3>{source.id}</h3>
                  {source.review && (
                    <>
                      <p className="df-meta">
                        来源状态：{source.review.excluded ? "整条来源已排除分析" : "保留分析"} ·
                        修订 {source.review.revision}
                      </p>
                      <p>{source.review.context.join("\n")}</p>
                    </>
                  )}
                  <p className="df-meta">
                    {source.sessionId} · {source.split} · {source.role} ·{" "}
                    {source.time || "时间未知"}
                  </p>
                  <p className="df-meta">
                    未处理原文：
                    {unprocessed(source) === null
                      ? "未知 / 正文未提供"
                      : `${unprocessed(source)} 字符`}{" "}
                    · 候选片段：{source.candidates.length}
                  </p>
                  <details className="df-detail">
                    <summary>完整原文（含未提取内容）</summary>
                    {source.split === "holdout" ? (
                      <p>留出正文暂不展示。</p>
                    ) : (
                      <pre className="df-raw">{source.text ?? "正文未提供"}</pre>
                    )}
                  </details>
                  <JsonDetail
                    title="处理范围与状态 / 来源指纹"
                    value={{ fingerprint: source.fingerprint, processing: source.processing }}
                  />
                  {source.split !== "holdout" && (
                    <ReviewControls id={source.id} type="source" busy={busy} onReview={review} />
                  )}
                  {(source.split === "holdout" ? [] : source.candidates).map((candidate) => (
                    <div
                      className="df-fragment"
                      id={`fragment-${encodeURIComponent(candidate.id)}`}
                      key={candidate.id}
                    >
                      <div className="df-meta">
                        <span className={`df-status df-${candidate.status}`}>
                          {label(candidate.status)}
                        </span>
                        <span>
                          {candidate.id} · 修订 {candidate.revision} · 范围 {candidate.start}–
                          {candidate.end}
                        </span>
                      </div>
                      <blockquote>{candidate.quote}</blockquote>
                      <dl>
                        <CandidateAssessment candidate={candidate} />
                        <dt>表达者 / 描述对象</dt>
                        <dd>
                          {label(candidate.author)} / {label(candidate.about)}
                        </dd>
                        <dt>立场 / 类型</dt>
                        <dd>
                          {candidate.stance} / {candidate.kind}
                        </dd>
                        <dt>不确定性</dt>
                        <dd>{candidate.uncertainty || "未提供"}</dd>
                        <dt>补充背景</dt>
                        <dd>{candidate.context?.join("\n") || "暂无"}</dd>
                        <dt>上下文来源</dt>
                        <dd>
                          {candidate.contextSourceIds?.length
                            ? candidate.contextSourceIds.map((id) => (
                                <div key={id}>
                                  <a href={`#source-${encodeURIComponent(id)}`}>{id}</a>
                                </div>
                              ))
                            : "未提供"}
                        </dd>
                      </dl>
                      {source.split !== "holdout" && (
                        <ReviewControls
                          id={candidate.id}
                          type="candidate"
                          candidate={candidate}
                          busy={busy}
                          onReview={review}
                        />
                      )}
                    </div>
                  ))}
                </article>
              ))}
          </section>
          <section hidden={section !== "insights"} aria-label="Insights">
            <div className="df-section-head">
              <h2>认识与普通总结对照</h2>
              <p>候选认识需要复核；已复核不等于事实已被独立验证。</p>
            </div>
            <div className="df-actions">
              <button
                type="button"
                className="df-primary"
                disabled={busy}
                onClick={() => void generate("synthesize")}
              >
                生成结构化认识 · 一次调用
              </button>
              <button type="button" disabled={busy} onClick={() => void generate("compare")}>
                生成普通总结对照 · 一次调用
              </button>
            </div>
            {!state.claims.length && (
              <p className="df-empty">尚无认识。先复核开发材料，再明确触发分析。</p>
            )}
            {state.claims.map((claim) => (
              <article className="df-claim" key={claim.id}>
                <div className="df-meta">
                  <span className={`df-status df-${claim.status}`}>{label(claim.status)}</span>
                  <span>
                    {label(claim.channel)} · {claim.kind} / {claim.mode} · 修订 {claim.revision}
                  </span>
                </div>
                <h3>{claim.text}</h3>
                <dl>
                  <dt>适用范围</dt>
                  <dd>{claim.scope || "未提供"}</dd>
                  <dt>推理依据</dt>
                  <dd>{claim.rationale || "未提供"}</dd>
                </dl>
                <details className="df-detail" open>
                  <summary>支持证据</summary>
                  {evidenceList(claim.evidence)}
                </details>
                <details className="df-detail" open>
                  <summary>反例 / 反证</summary>
                  {evidenceList(claim.counterevidence)}
                </details>
                <dl>
                  <dt>替代解释</dt>
                  <dd>{claim.alternatives?.join("\n") || "暂无"}</dd>
                  <dt>什么会改变这条认识</dt>
                  <dd>{claim.changeCondition || "未提供"}</dd>
                </dl>
                <JsonDetail title="修订历史" value={claim.history} />
                <ReviewControls id={claim.id} type="claim" busy={busy} onReview={review} />
              </article>
            ))}
          </section>
          <section hidden={section !== "usage"} aria-label="Usage">
            <h2>实际用量与处理记录</h2>
            <p>记录按服务端原值展示。null 表示未知，不能当作零；预留输入不等于实际消耗。</p>
            <dl className="df-budget">
              <dt>预留输入</dt>
              <dd>{state.usage.reservedInput ?? "未知"}</dd>
              <dt>输入上限</dt>
              <dd>{state.usage.inputCap ?? "未知"}</dd>
              <dt>输出上限</dt>
              <dd>{state.usage.outputCap ?? "未知"}</dd>
              <dt>请求上限</dt>
              <dd>{state.usage.requestCap ?? "未知"}</dd>
            </dl>
            <JsonDetail
              title={`调用记录（${state.usage.attempts.length}）· 实际 / 未知用量`}
              value={state.usage.attempts}
            />
            <JsonDetail title="运行与进度" value={state.runs} />
            <JsonDetail title="复核反馈记录" value={state.feedback} />
          </section>
        </>
      )}
    </main>
  );
}
