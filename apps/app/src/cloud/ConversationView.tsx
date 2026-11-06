import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloudApiError, cloudMutation, cloudRequest, isProcessingReply } from "../cloud-api";
import type {
  ClaimView,
  CoreModelStatus,
  CurrentUnderstandingResponse,
  ExplorationListResponse,
  ExplorationSummary,
  ExplorationView,
  GapView,
  GuidedQuestion,
  PriorSelectionView,
  ProcessingView,
  StartResponse,
} from "../types";
import { message } from "./shared";

// Account-mode conversation: every input is saved first, then processed with
// the current understanding from earlier experiences. A matter stays open after
// the explorer stops asking: the owner can keep talking, correct or stop using a
// judgement, park it or finish it. Nothing here substitutes for the owner's own
// judgement.

type Ask = {
  exploration_id: string;
  version: number;
  phase: "awaiting_answer";
  reading: { current_reading: string; key_uncertainty: string | null };
  question: GuidedQuestion;
  prior_understanding?: PriorSelectionView;
};
type Done = {
  exploration_id: string;
  version: number;
  phase: string;
  reading?: { current_reading: string; key_uncertainty: string | null };
  claims: ClaimView[];
  gaps: GapView[];
  processing?: ProcessingView;
  prior_understanding?: PriorSelectionView;
  view?: ExplorationView;
};
type Step =
  | { kind: "compose" }
  | { kind: "saved"; id: string; version: number; note: string; pending?: boolean }
  | { kind: "ask"; data: Ask }
  | { kind: "done"; data: Done };
type Reply = {
  version: number;
  reply: string;
  new_information: boolean;
  new_information_note: string | null;
};

const STARTERS = [
  "最近一件让我在意的具体事情是……",
  "最近我做了一个选择：……",
  "最近有一刻我的情绪变化很明显：……",
];
const RESULT_LABEL: Record<ProcessingView["result"], string> = {
  revised: "这次输入修订了已有认识",
  challenged: "这次输入对已有认识提出了挑战，争议保留",
  added: "这次输入形成了新的有限认识",
  supported: "这次输入为已有认识补充了独立支持",
  unknown: "暂时没有形成新认识，保留为未知",
};
const EFFECT_LABEL: Record<string, string> = {
  narrows: "收窄了适用范围",
  challenges: "提出挑战（未改写，争议保留）",
  supports: "补充支持",
  unchanged: "相关但不改变",
  skipped_stale: "该认识期间已变化，未改写",
  not_assessed: "参考但未判断关系",
};
const CORRECTION_TYPES = [
  ["wrong_fact", "事实不对"],
  ["missing_context", "缺少情境"],
  ["overinterpreted", "解释过度"],
  ["changed_now", "现在已经不同"],
  ["not_mine", "不是我的表达"],
  ["other", "其他"],
] as const;
// The whole saved conversation: first input, questions and answers, follow-ups,
// replies, corrections. Redacted (deleted) turns are left out.
const THREAD_LABEL: Record<string, string> = {
  correction: "我的纠正",
  stop_using: "我要求停用",
  amendment: "我的更正",
};
const FINISHED_PAGE = 20;

function explain(error: unknown) {
  if (error instanceof CloudApiError) {
    if (error.code === "CORE_MODEL_LIMIT_REACHED")
      return "最近 24 小时的自动处理次数已用完。你的输入已保存，稍后可以继续处理。";
    if (error.code === "LLM_UNAVAILABLE") return "自动处理尚未启用。你的输入已保存。";
    if (error.code === "STALE_VERSION") return "这次交流已在其他地方更新，请重新打开。";
    if (error.code === "STALE_CLAIM_REVISION")
      return "相关认识已经变化。你的输入已保存，请在当前认识上重新提交。";
  }
  return message(error);
}

export function ConversationView({
  resumeId,
  initialMessage,
  onInitialMessageConsumed,
}: {
  resumeId?: string | null;
  initialMessage?: string;
  onInitialMessageConsumed?: () => void;
} = {}) {
  const [status, setStatus] = useState<CoreModelStatus | null>(null);
  const [current, setCurrent] = useState<CurrentUnderstandingResponse | null>(null);
  const [open, setOpen] = useState<ExplorationSummary[]>([]);
  const [recent, setRecent] = useState<ExplorationSummary[]>([]);
  const [recentMore, setRecentMore] = useState(false);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<Step>({ kind: "compose" });
  const [event, setEvent] = useState("");
  const [answer, setAnswer] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correctionType, setCorrectionType] = useState<string>("missing_context");
  const [correctionNote, setCorrectionNote] = useState("");
  const [notice, setNotice] = useState("");
  // The saved conversation of the open matter, shown whatever the analysis
  // step is (asking, processing, failed or done).
  const [optimistic, setOptimistic] = useState("");
  const [replying, setReplying] = useState<string | null>(null);
  const initialSent = useRef<string | null>(null);
  const [thread, setThread] = useState<ExplorationView | null>(null);
  // Any new action or unmount invalidates pending reads from the previous view.
  const viewGeneration = useRef(0);
  function compose() {
    viewGeneration.current++;
    setStep({ kind: "compose" });
    setThread(null);
    setNotice("");
    setError("");
    setOptimistic("");
    setReplying(null);
  }

  const refresh = useCallback(async () => {
    const [s, c, active, completed] = await Promise.all([
      cloudRequest<CoreModelStatus>("/api/core/model-status"),
      cloudRequest<CurrentUnderstandingResponse>("/api/core/understanding"),
      cloudRequest<ExplorationListResponse>("/api/core/explorations?status=active&limit=50"),
      cloudRequest<ExplorationListResponse>(
        `/api/core/explorations?status=completed&limit=${FINISHED_PAGE}`,
      ),
    ]);
    setStatus(s);
    setCurrent(c);
    setOpen([...active.items].sort((a, b) => Number(!!a.parked) - Number(!!b.parked)));
    setRecent(completed.items);
    setRecentMore(completed.items.length === FINISHED_PAGE);
  }, []);

  async function run(fn: () => Promise<void>) {
    const generation = ++viewGeneration.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (generation === viewGeneration.current) setError(explain(e));
    } finally {
      if (generation === viewGeneration.current) {
        setBusy(false);
        setOptimistic("");
        void refresh().catch(() => undefined);
      }
    }
  }

  async function proceed(id: string, version: number) {
    try {
      const next = await cloudMutation<Ask | Done | { status: "processing" }>(
        `/api/core/explorations/${id}/continue`,
        { expected_version: version },
      );
      // 202: an earlier identical request is still running. Do not start another
      // one; let the owner refresh the saved exploration instead.
      if (isProcessingReply(next))
        return setStep({
          kind: "saved",
          id,
          version,
          pending: true,
          note: "上一次处理仍在进行，稍后刷新查看结果。",
        });
      setAnswer("");
      setOptions([]);
      if (next.phase === "awaiting_answer") return setStep({ kind: "ask", data: next as Ask });
      setStep({ kind: "done", data: next as Done });
      await attachView(id);
    } catch (e) {
      setStep({ kind: "saved", id, version, note: explain(e) });
    }
  }

  /** Adds the saved thread and pending inputs to a result already shown. */
  async function attachView(id: string) {
    const generation = viewGeneration.current;
    const view = await cloudRequest<ExplorationView>(`/api/core/explorations/${id}`).catch(
      () => null,
    );
    if (!view || generation !== viewGeneration.current) return;
    setThread(view);
    setStep((prev) =>
      prev.kind === "done" && prev.data.exploration_id === id && prev.data.version === view.version
        ? { kind: "done", data: { ...prev.data, view } }
        : prev,
    );
  }

  async function resume(id: string, allowProceed = true, generation = viewGeneration.current) {
    if (generation !== viewGeneration.current) return;
    const view = await cloudRequest<ExplorationView>(`/api/core/explorations/${id}`);
    if (generation !== viewGeneration.current) return;
    setThread(view);
    if (view.phase === "awaiting_answer" && view.open_question)
      return setStep({
        kind: "ask",
        data: {
          exploration_id: view.id,
          version: view.version,
          phase: "awaiting_answer",
          reading: {
            current_reading: view.latest_step?.current_reading ?? "",
            key_uncertainty: view.latest_step?.key_uncertainty ?? null,
          },
          question: view.open_question,
        },
      });
    const talking = (view.turns ?? []).some((turn) =>
      ["reply", "pi_reply"].includes(turn.turnKind),
    );
    // A message still waiting for its reply is retried as a reply, never as exploration.
    const waiting = !!view.pending?.messages?.length;
    if (view.phase === "ready_to_plan" && !talking && !waiting)
      return allowProceed
        ? proceed(view.id, view.version)
        : setStep({
            kind: "saved",
            id: view.id,
            version: view.version,
            pending: true,
            note: "仍在处理中，稍后再刷新。重新处理会沿用同一请求，不会重复计算。",
          });
    const meta = view.latest_step?.decision_meta as
      | { processing?: ProcessingView; prior_understanding?: PriorSelectionView }
      | undefined;
    setStep({
      kind: "done",
      data: {
        exploration_id: view.id,
        version: view.version,
        phase: view.phase,
        reading: view.latest_step ?? undefined,
        claims: view.understanding.claims,
        gaps: view.understanding.gaps,
        processing: meta?.processing,
        prior_understanding: meta?.prior_understanding,
        view,
      },
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: open the requested matter once.
  useEffect(() => {
    void refresh().catch((e) => setError(explain(e)));
    if (resumeId) void run(() => resume(resumeId, false));
    return () => {
      viewGeneration.current++;
    };
  }, [refresh, resumeId]);

  async function pollReply(id: string, operationId: string, generation: number) {
    try {
      // Only GETs: timeout or failure never spends another model operation.
      for (let attempt = 0; attempt < 180; attempt++) {
        if (generation !== viewGeneration.current) return;
        const operation = await cloudRequest<{
          status: "processing" | "completed" | "failed" | "stale";
          error?: { code?: string };
        }>(`/api/core/model-operations/${encodeURIComponent(operationId)}`);
        if (generation !== viewGeneration.current) return;
        if (operation.status !== "processing") {
          await resume(id, false, generation);
          if (generation !== viewGeneration.current) return;
          setReplying(null);
          setNotice(
            operation.status === "completed"
              ? "回应已生成。"
              : `消息已保存，${operation.error?.code ? explain(new CloudApiError(503, operation.error.code)) : "这次回应未完成，可以重新处理。"}`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (generation === viewGeneration.current) {
        setReplying(null);
        setNotice(
          "消息已保存，回应等待时间较长。可以重新打开这段对话确认结果；重试会沿用同一请求。",
        );
      }
    } catch (e) {
      if (generation === viewGeneration.current) {
        setReplying(null);
        setNotice(
          `消息已保存，暂时无法读取处理状态。重新打开对话可确认结果，也可沿用同一请求重试。${explain(e)}`,
        );
      }
    }
  }

  /** Ordinary chat only replies; understanding is updated on explicit request. */
  async function respond(id: string, version: number, sourceId: string) {
    const generation = viewGeneration.current;
    setReplying(sourceId);
    setNotice("回应正在生成，完成后会自动显示。");
    try {
      const reply = await cloudMutation<Reply | { status: "processing"; operation_id: string }>(
        `/api/core/explorations/${id}/reply`,
        { expected_version: version, message_source_id: sourceId },
      );
      if (generation !== viewGeneration.current) return;
      if (isProcessingReply(reply)) {
        setNotice("回应正在生成，完成后会自动显示。");
        await resume(id, false);
        void pollReply(id, reply.operation_id, generation);
        return;
      }
      await resume(id, false);
      if (generation !== viewGeneration.current) return;
      setReplying(null);
      setNotice("");
    } catch (e) {
      if (generation !== viewGeneration.current) return;
      setReplying(null);
      setNotice(`消息已保存。${explain(e)}`);
      return resume(id, false);
    }
  }

  /** The correction is saved first; processing may fail and be retried later. */
  async function processCorrection(id: string, version: number, sourceId: string) {
    try {
      const revised = await cloudMutation<{ change_summary: string } | { status: "processing" }>(
        `/api/core/explorations/${id}/correct`,
        { expected_version: version, correction_source_id: sourceId },
      );
      await resume(id, false);
      setNotice(
        isProcessingReply(revised)
          ? "纠正已保存，仍在处理中，稍后刷新查看。"
          : `已修订：${revised.change_summary}`,
      );
    } catch (e) {
      await resume(id, false);
      setNotice(`纠正已保存，暂未处理：${explain(e)}`);
    }
  }

  async function startMessage(text: string) {
    setOptimistic(text);
    await run(async () => {
      const generation = viewGeneration.current;
      const started = await cloudMutation<StartResponse>("/api/core/explorations", {
        event: text,
        reply_first: true,
      });
      if (generation !== viewGeneration.current) return;
      setEvent("");
      onInitialMessageConsumed?.();
      setStep({
        kind: "saved",
        id: started.exploration.id,
        version: started.exploration.version,
        note: "正在回应。",
      });
      await attachView(started.exploration.id);
      if (generation !== viewGeneration.current) return;
      setOptimistic("");
      if (started.event_source_id)
        await respond(started.exploration.id, started.exploration.version, started.event_source_id);
      else await proceed(started.exploration.id, started.exploration.version);
    });
    setOptimistic("");
  }

  // The home composer already submitted this text; save it once on entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: protect the submitted value across rerenders.
  useEffect(() => {
    if (!initialMessage?.trim()) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || initialSent.current === initialMessage) return;
      initialSent.current = initialMessage;
      setEvent(initialMessage);
      void startMessage(initialMessage.trim());
    });
    return () => {
      cancelled = true;
    };
  }, [initialMessage]);

  const usedCount =
    step.kind === "ask" || step.kind === "done"
      ? (step.data.prior_understanding?.used.length ?? 0)
      : 0;

  return (
    <section className="home-section conversation-view" aria-labelledby="conversation-title">
      <header className="conversation-heading">
        <div>
          <span className="fm-meta">FINDME · 日常商量</span>
          <h2 id="conversation-title">
            {step.kind === "compose"
              ? "今天，想从哪里说起？"
              : thread?.experience?.summary.slice(0, 80) || "接着聊"}
          </h2>
        </div>
        {step.kind !== "compose" && (
          <button type="button" className="button secondary" disabled={busy} onClick={compose}>
            聊件新的
          </button>
        )}
      </header>
      {status && !status.enabled && (
        <output className="form-error">自动处理尚未启用：输入可以保存，但暂时不会生成回应。</output>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <output className="conversation-notice">{notice}</output>}
      {optimistic && (
        <div className="conversation-thread">
          <article className="thread-user">
            <span className="thread-speaker">我：</span>
            <p>{optimistic}</p>
            <small>正在保存……</small>
          </article>
        </div>
      )}

      {step.kind === "compose" && (
        <>
          {!current?.claims.length && (
            <div className="cloud-actions" aria-label="开始方式">
              {STARTERS.map((text) => (
                <button key={text} type="button" onClick={() => setEvent(text)}>
                  {text.replace("……", "").replace("：", "")}
                </button>
              ))}
            </div>
          )}
          <label>
            说说一件具体的事
            <textarea
              value={event}
              maxLength={5000}
              rows={5}
              onChange={(e) => setEvent(e.target.value)}
              placeholder="发生了什么、当时怎么想、后来怎样都可以；不用一次说全。"
            />
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !event.trim()}
            onClick={() => void startMessage(event.trim())}
          >
            保存并继续
          </button>
          {open.length > 0 && (
            <div className="conversation-open">
              <h3>最近对话</h3>
              <ul>
                {open.map((item) => (
                  <li key={item.id}>
                    <strong>{item.summary.slice(0, 60)}</strong>
                    {item.parked && <span className="fm-status">暂缓</span>}
                    <br />
                    <span className="muted">
                      {item.open_question
                        ? item.open_question.question
                        : item.key_uncertainty
                          ? item.key_uncertainty
                          : "可以接着说"}
                    </span>
                    <div className="cloud-actions">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void run(() => resume(item.id, false))}
                      >
                        继续
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await cloudMutation(`/api/core/explorations/${item.id}/park`, {
                              expected_version: item.version,
                              parked: !item.parked,
                            });
                          })
                        }
                      >
                        {item.parked ? "恢复" : "暂缓"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recent.length > 0 && (
            <details className="fm-secondary-nav">
              <summary>已经结束的事</summary>
              <label>
                查找
                <input value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              <ul>
                {recent
                  .filter((item) => !search.trim() || item.summary.includes(search.trim()))
                  .map((item) => (
                    <li key={item.id}>
                      {item.summary.slice(0, 60)}{" "}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => resume(item.id, false))}
                      >
                        接着聊
                      </button>
                    </li>
                  ))}
              </ul>
              {recentMore && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    // Not through run(): its refresh reloads page one and would drop this page.
                    void (async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const next = await cloudRequest<ExplorationListResponse>(
                          `/api/core/explorations?status=completed&limit=${FINISHED_PAGE}&offset=${recent.length}`,
                        );
                        setRecent((all) => [...all, ...next.items]);
                        setRecentMore(next.items.length === FINISHED_PAGE);
                      } catch (e) {
                        setError(explain(e));
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  显示更多
                </button>
              )}
            </details>
          )}
        </>
      )}

      {step.kind === "saved" && thread?.id === step.id && <ThreadLog view={thread} />}
      {step.kind === "saved" && (
        <div className="conversation-saved">
          <p>已保存。{step.note}</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(() => resume(step.id, false))}
          >
            刷新状态
          </button>
          {/* Safe while pending too: the same request reuses its retained key. */}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(() => proceed(step.id, step.version))}
          >
            重新处理
          </button>
          <button type="button" className="button secondary" onClick={compose}>
            先换个话题
          </button>
        </div>
      )}

      {step.kind === "ask" && thread?.id === step.data.exploration_id && (
        <ThreadLog view={thread} />
      )}
      {step.kind === "ask" && (
        <div className="conversation-ask">
          {step.data.reading.current_reading && <p>{step.data.reading.current_reading}</p>}
          {usedCount > 0 && <p className="muted">参考了 {usedCount} 条已有认识。</p>}
          <h3>{step.data.question.question}</h3>
          <p className="muted">{step.data.question.intent}</p>
          {step.data.question.quick_options.length > 0 && (
            <div className="cloud-actions" aria-label="可选回答">
              {step.data.question.quick_options.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={options.includes(option)}
                  onClick={() =>
                    setOptions((all) =>
                      all.includes(option) ? all.filter((o) => o !== option) : [...all, option],
                    )
                  }
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <label>
            我的回答
            <textarea
              value={answer}
              maxLength={5000}
              rows={4}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || (!answer.trim() && options.length === 0)}
            onClick={() =>
              void run(async () => {
                const saved = await cloudMutation<{ version: number }>(
                  `/api/core/explorations/${step.data.exploration_id}/respond`,
                  {
                    expected_version: step.data.version,
                    question_id: step.data.question.id,
                    answer: answer.trim(),
                    selected_options: options,
                  },
                );
                await proceed(step.data.exploration_id, saved.version);
              })
            }
          >
            保存回答
          </button>
          <Finish
            id={step.data.exploration_id}
            version={step.data.version}
            busy={busy}
            run={run}
            done={compose}
          />
        </div>
      )}

      {step.kind === "done" && (
        <div className="conversation-result">
          {step.data.view && <ThreadLog view={step.data.view} />}
          {(step.data.claims.length > 0 ||
            step.data.processing ||
            step.data.reading?.current_reading ||
            step.data.gaps.length > 0) && (
            <details className="conversation-insights">
              <summary>
                {step.data.processing && step.data.processing.result !== "unknown"
                  ? "这次的认识变化"
                  : "查看这段对话的理解与依据"}
              </summary>
              {step.data.processing && (
                <output className="conversation-outcome">
                  <strong>{RESULT_LABEL[step.data.processing.result]}</strong>
                </output>
              )}
              {step.data.reading?.current_reading && <p>{step.data.reading.current_reading}</p>}
              {step.data.processing?.prior_effects.some(
                (item) => item.effect !== "not_assessed",
              ) && (
                <>
                  <h3>对已有认识的影响</h3>
                  <ul>
                    {step.data.processing.prior_effects
                      .filter((item) => item.effect !== "not_assessed")
                      .map((item) => (
                        <li key={item.prior_key}>
                          <strong>{EFFECT_LABEL[item.effect] ?? item.effect}</strong>：{item.text}
                          <br />
                          <span className="muted">适用范围：{item.scope}</span>
                          {item.rationale && <span className="muted"> · {item.rationale}</span>}
                        </li>
                      ))}
                  </ul>
                </>
              )}
              {usedCount > 0 && (
                <p className="muted">
                  本次参考了 {usedCount} 条已有认识；已撤回或失去依据的不作为前提。
                </p>
              )}
              {step.data.claims.length > 0 && <h3>这件事形成的认识</h3>}
              <ul>
                {step.data.claims.map((claim) => (
                  <li key={claim.claim_revision_id}>
                    {claim.text}
                    <br />
                    <span className="muted">
                      适用范围：{claim.scope} · 依据：{claim.confidence_basis}
                    </span>
                    <div className="cloud-actions">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setCorrecting(claim.claim_revision_id);
                          setCorrectionNote("");
                        }}
                      >
                        纠正这条
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await cloudMutation(
                              `/api/core/claim-revisions/${claim.claim_revision_id}/withdraw`,
                              {},
                            );
                            await resume(step.data.exploration_id, false);
                            setNotice("已停用这条认识，之后的回答和首页不会再使用它。");
                          })
                        }
                      >
                        以后不要再用这条
                      </button>
                    </div>
                    {correcting === claim.claim_revision_id && (
                      <div className="conversation-correct">
                        <label>
                          纠正类型
                          <select
                            value={correctionType}
                            onChange={(e) => setCorrectionType(e.target.value)}
                          >
                            {CORRECTION_TYPES.map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          说明
                          <textarea
                            value={correctionNote}
                            maxLength={4000}
                            rows={3}
                            onChange={(e) => setCorrectionNote(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="button primary"
                          disabled={busy || !correctionNote.trim()}
                          onClick={() =>
                            void run(async () => {
                              const saved = await cloudMutation<{
                                version: number;
                                correction_source_id: string;
                              }>(`/api/core/explorations/${step.data.exploration_id}/corrections`, {
                                expected_version: step.data.version,
                                claim_revision_ids: [claim.claim_revision_id],
                                correction: { type: correctionType, note: correctionNote.trim() },
                              });
                              setCorrecting(null);
                              await processCorrection(
                                step.data.exploration_id,
                                saved.version,
                                saved.correction_source_id,
                              );
                            })
                          }
                        >
                          保存纠正
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {step.data.gaps.length > 0 && (
                <>
                  <h3>仍不确定</h3>
                  <ul>
                    {step.data.gaps.map((gap) => (
                      <li key={gap.id ?? gap.key ?? gap.question}>{gap.question}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
          {!!step.data.view?.pending?.corrections.length && (
            <div className="conversation-saved">
              <h3>已保存、尚未处理的纠正</h3>
              {step.data.view.pending.corrections.map((item) => (
                <p key={item.source_id}>
                  {item.note}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        processCorrection(
                          step.data.exploration_id,
                          step.data.version,
                          item.source_id,
                        ),
                      )
                    }
                  >
                    重新处理
                  </button>
                </p>
              ))}
            </div>
          )}

          <details className="conversation-tools">
            <summary>对话选项</summary>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void run(() => proceed(step.data.exploration_id, step.data.version))}
            >
              更新认识
            </button>
            <p className="muted">需要时，再根据这段对话整理认识。</p>
          </details>
          <div className="conversation-thread">
            {step.data.view?.pending?.messages.map((item) => (
              <p key={item.source_id} className="muted">
                {replying === item.source_id
                  ? "正在回应这条消息："
                  : "这条消息已保存，还没有回应："}
                {item.message.slice(0, 60)}{" "}
                <button
                  type="button"
                  disabled={busy || replying === item.source_id}
                  onClick={() =>
                    void run(() =>
                      respond(step.data.exploration_id, step.data.version, item.source_id),
                    )
                  }
                >
                  重新处理
                </button>
              </p>
            ))}
            <div className="conversation-composer">
              <label>
                接着说
                <textarea
                  value={followUp}
                  maxLength={5000}
                  rows={3}
                  onChange={(e) => setFollowUp(e.target.value)}
                  placeholder="没听明白、想比较选择、事情有了进展，都可以直接说。"
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !!replying || !followUp.trim()}
                onClick={() =>
                  void run(async () => {
                    const generation = viewGeneration.current;
                    setOptimistic(followUp.trim());
                    const saved = await cloudMutation<{
                      version: number;
                      message_source_id: string;
                    }>(`/api/core/explorations/${step.data.exploration_id}/messages`, {
                      expected_version: step.data.version,
                      message: followUp.trim(),
                    });
                    if (generation !== viewGeneration.current) return;
                    setFollowUp("");
                    await attachView(step.data.exploration_id);
                    await resume(step.data.exploration_id, false, generation);
                    if (generation !== viewGeneration.current) return;
                    setOptimistic("");
                    await respond(step.data.exploration_id, saved.version, saved.message_source_id);
                  })
                }
              >
                发送
              </button>
            </div>
          </div>

          <div className="cloud-actions">
            {step.data.phase !== "completed" && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await cloudMutation(`/api/core/explorations/${step.data.exploration_id}/park`, {
                      expected_version: step.data.version,
                      parked: true,
                    });
                    compose();
                  })
                }
              >
                先暂缓
              </button>
            )}
            {step.data.phase !== "completed" ? (
              <Finish
                id={step.data.exploration_id}
                version={step.data.version}
                busy={busy}
                run={run}
                done={compose}
              />
            ) : (
              <button type="button" className="button secondary" onClick={compose}>
                返回
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Finish(props: {
  id: string;
  version: number;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  done: () => void;
}) {
  return (
    <button
      type="button"
      className="button secondary"
      disabled={props.busy}
      onClick={() =>
        void props.run(async () => {
          await cloudMutation(`/api/core/explorations/${props.id}/complete`, {
            expected_version: props.version,
          });
          props.done();
        })
      }
    >
      这件事先到这里
    </button>
  );
}

/** Read-only conversation log of a matter. */
function ThreadLog({ view }: { view: ExplorationView }) {
  const turns = (view.turns ?? []).filter((turn) => turn.content);
  if (!turns.length) return null;
  return (
    <div className="conversation-thread">
      {turns.map((turn) => (
        <article key={turn.id} className={turn.role === "user" ? "thread-user" : "thread-reply"}>
          <span className="thread-speaker">
            {turn.role === "user" ? (THREAD_LABEL[turn.turnKind] ?? "我") : "FindMe"}：
          </span>
          {turn.role === "user" ? (
            <p>{turn.content}</p>
          ) : (
            <div className="thread-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
