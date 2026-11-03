import { useEffect, useRef, useState } from "react";
import { CloudApiError, cloudMutation, cloudRequest, cloudSources } from "./cloud-api";

type Source = {
  id: string;
  text: string | null;
  status: string;
  eligibility: string;
  source_kind?: string;
};
type Evidence = {
  span_id: string;
  source_id: string;
  quote: string;
  speaker: string;
  stance: string;
  independence_group: string;
};
type Finding = {
  claim_revision_id: string;
  text: string;
  scope: string;
  status: "provisional" | "contested" | "unknown";
  support: Evidence[];
  counterexamples: Evidence[];
  context: Evidence[];
};
type Topic = {
  topic_key: string;
  version: number;
  source_ids: string[];
  coverage: { source_id: string; disposition: string; reason: string }[];
  result: {
    title: string;
    question: string;
    status: "provisional" | "unknown" | "needs_review";
    summary: string;
    findings: Finding[];
    gaps: string[];
  } | null;
  pending_review: boolean;
  affected_overviews: string[];
  feedback: { kind: string; note: string; created_at: string }[];
};
type FeedbackKind =
  | "fact_correction"
  | "interpretation_disagreement"
  | "temporal_change"
  | "utility_feedback";

const feedbackLabels: Record<FeedbackKind, string> = {
  fact_correction: "事实或归属有误",
  interpretation_disagreement: "不同意这个解释",
  temporal_change: "现在的情况变了",
  utility_feedback: "这份理解是否有用",
};
const coverageLabels: Record<string, string> = {
  successful: "用于本次认识",
  reused: "沿用同源依据",
  background: "背景材料",
  unknown: "资格或关联尚不明确",
  excluded: "已排除",
  failed: "处理失败",
  unprocessed: "尚未处理",
};

function errorMessage(error: unknown) {
  return error instanceof CloudApiError
    ? error.code
    : error instanceof Error
      ? error.message
      : "读取失败";
}

function EvidenceList({ title, items }: { title: string; items: Evidence[] }) {
  if (!items.length) return null;
  return (
    <details>
      <summary>
        {title} · {items.length} 个独立来源组
      </summary>
      {items.map((item) => (
        <article key={item.span_id}>
          <p>{item.quote}</p>
          <small>
            表达者：{item.speaker} · 立场：{item.stance} · 来源 {item.source_id}
          </small>
        </article>
      ))}
    </details>
  );
}

type TopicRequest = {
  topic_key: string;
  expected_version: number;
  title: string;
  question: string;
  source_ids: string[];
};
type PendingTopic = { key: string; body: TopicRequest };

export function KnowledgeView({ requestScope }: { requestScope: string }) {
  const storageKey = `findme_knowledge_pending:${requestScope}`;
  const [initialPending] = useState<PendingTopic | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    } catch {
      return null;
    }
  });
  const [topics, setTopics] = useState<Topic[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [current, setCurrent] = useState<Topic | null>(null);
  const [history, setHistory] = useState<Topic[]>([]);
  const [title, setTitle] = useState(initialPending?.body.title ?? "");
  const [question, setQuestion] = useState(initialPending?.body.question ?? "");
  const [sourceIds, setSourceIds] = useState<string[]>(initialPending?.body.source_ids ?? []);
  const [kind, setKind] = useState<FeedbackKind>("fact_correction");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pending = useRef<PendingTopic | null>(initialPending);
  const [retryPending, setRetryPending] = useState(!!initialPending);
  function clearPending() {
    pending.current = null;
    sessionStorage.removeItem(storageKey);
    setRetryPending(false);
  }

  async function refresh() {
    const [nextTopics, nextSources] = await Promise.all([
      cloudRequest<Topic[]>("/api/knowledge/topics"),
      cloudSources<Source>(),
    ]);
    setTopics(nextTopics);
    setSources(nextSources);
    if (current)
      setCurrent(nextTopics.find((item) => item.topic_key === current.topic_key) ?? null);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial read; mutations refresh explicitly.
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, []);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function open(topic: Topic) {
    clearPending();
    setCurrent(topic);
    setHistory([]);
    setTitle(topic.result?.title ?? "");
    setQuestion(topic.result?.question ?? "");
    setSourceIds(topic.source_ids);
    setNote("");
  }

  return (
    <section className="knowledge-view">
      <h1>专题认识与来源</h1>
      <p>
        从明确选定的个人材料整理当前已有认识。每条判断保留原始片段、反例和未处理范围；依据不足时显示未知。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="cloud-actions">
        <button type="button" disabled={busy} onClick={() => void act(refresh)}>
          刷新
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            clearPending();
            setCurrent(null);
            setHistory([]);
            setTitle("");
            setQuestion("");
            setSourceIds([]);
            setNote("");
          }}
        >
          新建专题范围
        </button>
      </div>
      <section className="home-section">
        <h2>已有专题</h2>
        {!topics.length && <p>尚无按固定来源整理的专题。</p>}
        {topics.map((topic) => (
          <button
            type="button"
            className="cloud-run"
            key={topic.topic_key}
            onClick={() => open(topic)}
          >
            <strong>{topic.result?.title ?? topic.topic_key}</strong>
            <span>
              版本 {topic.version} ·{" "}
              {topic.pending_review
                ? "待复核"
                : topic.result?.status === "unknown"
                  ? "依据不足"
                  : "暂有依据"}
            </span>
          </button>
        ))}
      </section>
      <section className="home-section">
        <h2>{current ? "复核这个专题" : "整理一个专题"}</h2>
        <label>
          专题名称
          <input
            disabled={retryPending}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          想弄清的问题
          <textarea
            disabled={retryPending}
            value={question}
            maxLength={1000}
            rows={3}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <details open={!current}>
          <summary>
            可选来源共 {sources.filter((source) => source.status === "active").length} 条 · 已选{" "}
            {sourceIds.length} 条
          </summary>
          {!sources.length && (
            <p>当前 Profile 尚无可选择来源。可以先在“我的资料”中保存经历或导入材料。</p>
          )}
          {sources
            .filter((source) => source.status === "active")
            .map((source) => (
              <label className="cloud-choice" key={source.id}>
                <input
                  disabled={retryPending}
                  type="checkbox"
                  checked={sourceIds.includes(source.id)}
                  onChange={(event) =>
                    setSourceIds((ids) =>
                      event.target.checked
                        ? [...ids, source.id]
                        : ids.filter((id) => id !== source.id),
                    )
                  }
                />
                <span>
                  {source.text?.slice(0, 180) ?? "原文不可读"}
                  <small>
                    {source.source_kind ?? "个人来源"} · {source.eligibility}
                  </small>
                </span>
              </label>
            ))}
        </details>
        <button
          type="button"
          className="button primary"
          disabled={busy || !title.trim() || !question.trim() || !sourceIds.length}
          onClick={() =>
            void act(async () => {
              // A failed response may already have committed. Keep the exact request and
              // topic identity until an acknowledged response, including navigation refreshes.
              pending.current ??= {
                key: crypto.randomUUID(),
                body: {
                  topic_key: current?.topic_key ?? crypto.randomUUID(),
                  expected_version: current?.version ?? 0,
                  title,
                  question,
                  source_ids: [...sourceIds],
                },
              };
              sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
              setRetryPending(true);
              const topic = await cloudRequest<Topic>("/api/knowledge/topics/process", {
                method: "POST",
                headers: { "Idempotency-Key": pending.current.key },
                body: JSON.stringify(pending.current.body),
              });
              clearPending();
              setCurrent(topic);
              setHistory([]);
              await refresh();
            })
          }
        >
          {retryPending
            ? "重试同一次整理"
            : current?.pending_review
              ? "按当前依据重新整理"
              : current
                ? "生成下一版本"
                : "整理所选来源"}
        </button>
        {retryPending && <p>尚未确认本次整理结果；重试会核对同一专题和同一次请求。</p>}
        <p>
          <small>只读取已有的个人认识与来源关联，不调用模型；未形成认识的材料会保留为缺口。</small>
        </p>
      </section>
      {current && (
        <section className="home-section">
          <h2>
            {current.result?.title ?? "专题"} · 版本 {current.version}
          </h2>
          {current.pending_review && (
            <output>本人反馈已使相关判断待复核。旧版仍可回看，但不再作为当前结论。</output>
          )}
          <p>{current.result?.summary ?? "尚无当前结论。"}</p>
          {current.result?.findings.map((finding) => (
            <article key={finding.claim_revision_id}>
              <h3>{finding.text}</h3>
              <p>
                范围：{finding.scope} ·{" "}
                {finding.status === "contested"
                  ? "有反例"
                  : finding.status === "unknown"
                    ? "未知"
                    : "暂有支持"}
              </p>
              <EvidenceList title="支持" items={finding.support} />
              <EvidenceList title="反例" items={finding.counterexamples} />
              <EvidenceList title="情境" items={finding.context} />
            </article>
          ))}
          {!!current.result?.gaps.length && (
            <details>
              <summary>不足和未处理项</summary>
              <ul>
                {current.result.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>本次来源去向</summary>
            {current.coverage.map((item) => (
              <p key={item.source_id}>
                <strong>{coverageLabels[item.disposition] ?? item.disposition}</strong> ·{" "}
                {item.reason}
                <small>{item.source_id}</small>
              </p>
            ))}
          </details>
          {!!current.feedback.length && (
            <details>
              <summary>本人反馈</summary>
              {current.feedback.map((item) => (
                <p key={`${item.created_at}:${item.kind}`}>
                  {feedbackLabels[item.kind as FeedbackKind] ?? item.kind} · {item.note}
                </p>
              ))}
            </details>
          )}
          <details>
            <summary>专题版本历史</summary>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setHistory(
                    await cloudRequest<Topic[]>(
                      `/api/knowledge/topics/${encodeURIComponent(current.topic_key)}/versions`,
                    ),
                  );
                })
              }
            >
              读取历史版本
            </button>
            {history.map((version) => (
              <article key={`${version.topic_key}:${version.version}`}>
                <h3>历史版本 {version.version}</h3>
                <p>{version.result?.summary ?? "这一版没有当前结论"}</p>
                <small>
                  {version.result?.findings.length ?? 0} 条判断 ·{" "}
                  {version.pending_review ? "当时待复核" : "当时的处理状态"}。历史不能代替当前版本。
                </small>
              </article>
            ))}
          </details>
          <h3>纠正或评价</h3>
          <label>
            反馈类型
            <select value={kind} onChange={(event) => setKind(event.target.value as FeedbackKind)}>
              {Object.entries(feedbackLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            具体说明
            <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() =>
              void act(async () => {
                const topic = await cloudMutation<Topic>(
                  `/api/knowledge/topics/${encodeURIComponent(current.topic_key)}/feedback`,
                  {
                    expected_version: current.version,
                    kind,
                    note,
                    claim_revision_ids: [],
                  },
                );
                setCurrent(topic);
                setHistory([]);
                setNote("");
                await refresh();
              })
            }
          >
            保存反馈
          </button>
        </section>
      )}
    </section>
  );
}
