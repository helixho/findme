import { ArrowLeft, Check, ChevronRight, LocateFixed } from "lucide-react";
import type {
  ContinueAskResponse,
  CurrentUnderstandingResponse,
  ExplorationSummary,
} from "../types";
import { ClaimCard } from "./result";
import { LoadingMark, Mark } from "./shell";

export function HomeView({
  current,
  activeExploration,
  onStart,
  onCurrent,
  onResume,
}: {
  current: CurrentUnderstandingResponse | null;
  activeExploration: ExplorationSummary | null;
  onStart: () => void;
  onCurrent: () => void;
  onResume: () => void;
}) {
  const preview = current?.claims.slice(0, 2) ?? [];
  return (
    <div className="home-page">
      <section className="home-hero">
        <div className="home-symbol">
          <Mark size={76} />
        </div>
        <p className="eyebrow">FINDME</p>
        <h1 className="editorial">看清自己。</h1>
        <p className="hero-sub">不从标签开始。先从一件真实发生过的事，慢慢看清当时的你。</p>
        <button type="button" className="button primary hero-action" onClick={onStart}>
          从一个事件开始
          <ChevronRight size={18} />
        </button>
      </section>

      {activeExploration && (
        <section className="home-section resume-section">
          <button type="button" className="resume-card" onClick={onResume}>
            <div>
              <p className="eyebrow">CONTINUE</p>
              <strong>继续上次探索</strong>
              <span>{activeExploration.summary}</span>
            </div>
            <ChevronRight size={18} />
          </button>
        </section>
      )}

      <section className="home-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">NOW</p>
            <h2>当前认识</h2>
          </div>
          <button type="button" className="text-button" onClick={onCurrent}>
            查看全部
          </button>
        </div>
        {preview.length ? (
          <div className="home-claim-list">
            {preview.map((claim) => (
              <button
                type="button"
                className="home-claim"
                key={claim.claim_revision_id}
                onClick={onCurrent}
              >
                <span className={`mode-dot ${claim.mode}`} />
                <span>
                  <strong>{claim.text}</strong>
                  <small>{claim.scope}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-current">
            <LocateFixed size={21} />
            <div>
              <strong>还没有形成当前认识</strong>
              <p>这不是空白档案。FindMe 会在真实材料足够时再形成判断。</p>
            </div>
          </div>
        )}
      </section>

      <section className="home-section compact">
        <div className="principle-note">
          <span>01</span>
          <p>
            <strong>你不是一个等待被定义的结论。</strong>
            <br />
            每一次理解都应该允许被新的经历修订。
          </p>
        </div>
      </section>
    </div>
  );
}

export function ComposeView({
  event,
  setEvent,
  busy,
  onBack,
  onSubmit,
}: {
  event: string;
  setEvent: (value: string) => void;
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flow-page compose-page">
      <div className="flow-topline">
        <button type="button" className="icon-button quiet" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <div className="flow-progress">
          <span className="active" />
          <span />
          <span />
        </div>
        <span className="flow-step">1 / 3</span>
      </div>
      {busy ? (
        <LoadingMark label="正在找到最值得追问的一点…" />
      ) : (
        <>
          <div className="flow-heading">
            <p className="eyebrow">ONE REAL MOMENT</p>
            <h1 className="editorial">发生了什么？</h1>
            <p>不用总结自己，也不用找“正确答案”。写下一件最近让你停了一下的具体事情。</p>
          </div>
          <textarea
            className="event-input"
            placeholder="例如：上周的会议上，我其实有一些想法，但最后没有发言……"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          />
          <div className="input-hint">
            <span>具体的人、场景、选择，比“我总是……”更有用。</span>
            <span>{event.trim().length}</span>
          </div>
          <div className="flow-footer">
            <button
              type="button"
              className="button primary wide"
              disabled={!event.trim()}
              onClick={onSubmit}
            >
              继续
              <ChevronRight size={17} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function PlanningView({ event, savedLabel }: { event: string; savedLabel: string }) {
  return (
    <div className="flow-page planning-page">
      <div className="flow-topline">
        <span />
        <div className="flow-progress">
          <span className="complete" />
          <span className="active" />
          <span />
        </div>
        <span className="flow-step">整理中</span>
      </div>
      <div className="save-confirmation">
        <span className="save-check">
          <Check size={18} />
        </span>
        <div>
          <strong>{savedLabel}</strong>
          <p>你的原始表达已经记录，不需要等模型完成才算保存。</p>
        </div>
      </div>
      <div className="event-echo planning-echo">
        <span>这次探索</span>
        <p>{event}</p>
      </div>
      <LoadingMark label="正在判断是否还有一个值得追问的问题…" />
    </div>
  );
}

export function QuestionView({
  event,
  data,
  answer,
  setAnswer,
  selectedOptions,
  setSelectedOptions,
  busy,
  onBack,
  onSubmit,
}: {
  event: string;
  data: ContinueAskResponse;
  answer: string;
  setAnswer: (value: string) => void;
  selectedOptions: string[];
  setSelectedOptions: (value: string[]) => void;
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const options = data.question.quick_options ?? [];
  const toggleOption = (option: string) => {
    setSelectedOptions(
      selectedOptions.includes(option)
        ? selectedOptions.filter((item) => item !== option)
        : [...selectedOptions, option],
    );
  };
  const canSubmit = answer.trim().length > 0 || selectedOptions.length > 0;

  return (
    <div className="flow-page question-page">
      <div className="flow-topline">
        <button type="button" className="icon-button quiet" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <div className="flow-progress">
          <span className="complete" />
          <span className="active" />
          <span />
        </div>
        <span className="flow-step">第 {data.question_budget.asked} 问</span>
      </div>

      <div className="event-echo">
        <span>这次探索</span>
        <p>{event}</p>
      </div>

      <section className="reading-card">
        <div>
          <span>现在更清楚</span>
          <p>{data.reading.current_reading}</p>
        </div>
        {data.reading.key_uncertainty && (
          <div className="reading-uncertainty">
            <span>还不能确定</span>
            <p>{data.reading.key_uncertainty}</p>
          </div>
        )}
      </section>

      <div className="question-block">
        <p className="eyebrow">ONE PURPOSEFUL QUESTION</p>
        <h1>{data.question.question}</h1>
        <p className="question-intent">
          <strong>为什么问：</strong>
          {data.question.intent}
        </p>
      </div>

      {options.length > 0 && (
        <>
          <p className="quick-hint">可以多选，也可以直接补充；这些不是对你的分类。</p>
          <div className="quick-options">
            {options.map((option) => (
              <button
                type="button"
                key={option}
                aria-pressed={selectedOptions.includes(option)}
                className={
                  selectedOptions.includes(option) ? "quick-option selected" : "quick-option"
                }
                onClick={() => toggleOption(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </>
      )}

      <textarea
        className="answer-input"
        placeholder="补充你真实的感觉；如果选项已经够了，也可以不写。"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      <div className="flow-footer sticky-action">
        <button
          type="button"
          className="button primary wide"
          disabled={busy || !canSubmit}
          onClick={onSubmit}
        >
          {busy ? "正在保存…" : "提交这次回答"}
          {!busy && <ChevronRight size={17} />}
        </button>
      </div>
    </div>
  );
}

export function CurrentView({
  data,
  loading,
  onStart,
}: {
  data: CurrentUnderstandingResponse | null;
  loading: boolean;
  onStart: () => void;
}) {
  return (
    <div className="current-page">
      <div className="current-heading">
        <p className="eyebrow">CURRENT SELF VIEW</p>
        <h1 className="editorial">当前认识</h1>
        <p>这是目前最能被材料支持的版本。它会随着新的经历、反例和你的纠正继续变化。</p>
      </div>
      {loading ? (
        <LoadingMark label="正在读取当前认识…" />
      ) : data && (data.claims.length > 0 || data.needs_review.length > 0) ? (
        <div className="current-list">
          {data.needs_review.length > 0 && (
            <section className="needs-review-card">
              <strong>有一些认识暂时退出了“当前的我”</strong>
              {data.needs_review.map((claim) => (
                <div key={claim.claim_revision_id}>
                  <p>{claim.text}</p>
                  <small>
                    {claim.invalidation_reason ?? "依赖的依据发生了变化，需要重新评估。"}
                  </small>
                </div>
              ))}
            </section>
          )}
          {data.claims.map((claim) => (
            <ClaimCard key={claim.claim_revision_id} claim={claim} />
          ))}
        </div>
      ) : (
        <div className="current-empty">
          <Mark size={52} />
          <h2>暂时没有需要写进“当前的我”的结论。</h2>
          <p>先经历、再理解。FindMe 不会为了填满页面而制造画像。</p>
          <button type="button" className="button primary" onClick={onStart}>
            开始第一次探索
          </button>
        </div>
      )}
    </div>
  );
}
