import { useCallback, useEffect, useState } from "react";
import { CloudApiError, cloudMutation, cloudRequest, isProcessingReply } from "../cloud-api";
import type {
  ClaimView,
  CoreModelStatus,
  CurrentUnderstandingResponse,
  ExplorationListResponse,
  ExplorationView,
  GapView,
  GuidedQuestion,
  PriorSelectionView,
  ProcessingView,
  StartResponse,
} from "../types";
import { message } from "./shared";

// Account-mode conversation: every input is saved first, then processed with
// the current understanding from earlier experiences. The visible result says
// what changed; nothing here substitutes for the owner's own judgement.

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
};
type Step =
  | { kind: "compose" }
  | { kind: "saved"; id: string; version: number; note: string; pending?: boolean }
  | { kind: "ask"; data: Ask }
  | { kind: "done"; data: Done };

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

function explain(error: unknown) {
  if (error instanceof CloudApiError) {
    if (error.code === "CORE_MODEL_LIMIT_REACHED")
      return "最近 24 小时的自动处理次数已用完。你的输入已保存，稍后可以继续处理。";
    if (error.code === "LLM_UNAVAILABLE") return "自动处理尚未启用。你的输入已保存。";
    if (error.code === "STALE_VERSION") return "这次交流已在其他地方更新，请重新打开。";
  }
  return message(error);
}

export function ConversationView() {
  const [status, setStatus] = useState<CoreModelStatus | null>(null);
  const [current, setCurrent] = useState<CurrentUnderstandingResponse | null>(null);
  const [active, setActive] = useState<ExplorationListResponse["items"][number] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "compose" });
  const [event, setEvent] = useState("");
  const [answer, setAnswer] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correctionType, setCorrectionType] = useState<string>("missing_context");
  const [correctionNote, setCorrectionNote] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const [s, c, list] = await Promise.all([
      cloudRequest<CoreModelStatus>("/api/core/model-status"),
      cloudRequest<CurrentUnderstandingResponse>("/api/core/understanding"),
      cloudRequest<ExplorationListResponse>("/api/core/explorations?status=active&limit=1"),
    ]);
    setStatus(s);
    setCurrent(c);
    setActive(list.items[0] ?? null);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(explain(e)));
  }, [refresh]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
      void refresh().catch(() => undefined);
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
      setStep(
        next.phase === "awaiting_answer"
          ? { kind: "ask", data: next as Ask }
          : { kind: "done", data: next as Done },
      );
    } catch (e) {
      setStep({ kind: "saved", id, version, note: explain(e) });
    }
  }

  async function resume(id: string, allowProceed = true) {
    const view = await cloudRequest<ExplorationView>(`/api/core/explorations/${id}`);
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
    if (view.phase === "ready_to_plan")
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
      },
    });
  }

  const usedCount =
    step.kind === "ask" || step.kind === "done"
      ? (step.data.prior_understanding?.used.length ?? 0)
      : 0;

  return (
    <section className="home-section conversation-view" aria-labelledby="conversation-title">
      <h2 id="conversation-title">对话与新经历</h2>
      <p className="muted">
        {current?.claims.length
          ? `当前理解中有 ${current.claims.length} 条有效认识；新的交流会使用其中相关的部分，并说明这次输入带来了什么变化。`
          : "还没有已形成的认识。可以从一件具体的事开始，不需要先整理成结论。"}
      </p>
      {status && !status.enabled && (
        <output className="form-error">
          自动处理尚未启用：输入可以保存，但暂时不会形成新的认识。
        </output>
      )}
      {status?.enabled && (
        <output className="muted">
          最近 {status.window_hours} 小时已自动处理 {status.operations_used}/
          {status.operation_limit} 次。
        </output>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}

      {step.kind === "compose" && (
        <>
          {active && (
            <p>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void run(() => resume(active.id))}
              >
                继续上次：{active.summary.slice(0, 40)}
              </button>
            </p>
          )}
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
            onClick={() =>
              void run(async () => {
                const started = await cloudMutation<StartResponse>("/api/core/explorations", {
                  event: event.trim(),
                });
                setEvent("");
                await proceed(started.exploration.id, started.exploration.version);
              })
            }
          >
            保存并继续
          </button>
        </>
      )}

      {step.kind === "saved" && (
        <div className="conversation-saved">
          <p>已保存。{step.note}</p>
          {step.pending && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void run(() => resume(step.id, false))}
            >
              刷新状态
            </button>
          )}
          {/* Safe while pending too: the same request reuses its retained key. */}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(() => proceed(step.id, step.version))}
          >
            重新处理
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setStep({ kind: "compose" })}
          >
            先换个话题
          </button>
        </div>
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
            done={() => setStep({ kind: "compose" })}
          />
        </div>
      )}

      {step.kind === "done" && (
        <div className="conversation-result">
          {step.data.processing && (
            <output className="conversation-outcome">
              <strong>{RESULT_LABEL[step.data.processing.result]}</strong>
            </output>
          )}
          {step.data.reading?.current_reading && <p>{step.data.reading.current_reading}</p>}
          {step.data.processing?.prior_effects.some((item) => item.effect !== "not_assessed") && (
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
          <h3>这次形成的认识</h3>
          {step.data.claims.length === 0 && <p className="muted">这次没有形成新的认识。</p>}
          <ul>
            {step.data.claims.map((claim) => (
              <li key={claim.claim_revision_id}>
                {claim.text}
                <br />
                <span className="muted">
                  适用范围：{claim.scope} · 依据：{claim.confidence_basis}
                </span>
                <br />
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
                          const revised = await cloudMutation<
                            (Done & { change_summary: string }) | { status: "processing" }
                          >(`/api/core/explorations/${step.data.exploration_id}/correct`, {
                            expected_version: step.data.version,
                            claim_revision_ids: [claim.claim_revision_id],
                            correction: { type: correctionType, note: correctionNote.trim() },
                          });
                          if (isProcessingReply(revised)) {
                            // Keep the editor: saving again reuses the same request.
                            setNotice("纠正仍在处理，稍后再点“保存纠正”查看结果。");
                            return;
                          }
                          setCorrecting(null);
                          // The response holds only the corrected claims; reload
                          // the whole exploration so untouched claims stay visible.
                          await resume(step.data.exploration_id);
                          setNotice(`已修订：${revised.change_summary}`);
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
          <Finish
            id={step.data.exploration_id}
            version={step.data.version}
            busy={busy}
            run={run}
            done={() => setStep({ kind: "compose" })}
          />
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
      结束这次，换个话题
    </button>
  );
}
