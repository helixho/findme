import {
  BookOpenText,
  Check,
  CircleHelp,
  Compass,
  FileText,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ClaimView, EvidenceView, RevisionResponse, UnderstandingResponse } from "../types";
import type { Overlay } from "./model";

export const correctionOptions = [
  ["missing_context", "缺少重要背景", "还有影响判断的信息没有看到"],
  ["overinterpreted", "解释得太远", "现有材料还不足以支持这个原因"],
  ["wrong_fact", "事实不准确", "事情本身被理解错了"],
  ["changed_now", "现在已经不同", "过去可能成立，但现在情况变了"],
  ["not_mine", "这不是我的想法", "引用、转述或归属出现了问题"],
] as const;

export const amendmentOptions = [
  ["supplements", "补充一点", "原来的内容仍然成立，只是还有重要信息没说完整"],
  ["corrects", "刚才说得不准确", "保留原记录，但旧内容停止参与当前分析"],
  ["updates", "现在已经不同", "过去的情况仍然保留，这次补充描述当前变化"],
] as const;

export function Confidence({ level }: { level: string }) {
  const label = level === "high" ? "依据较充分" : level === "medium" ? "暂有支持" : "仍很初步";
  return <span className={`confidence ${level}`}>{label}</span>;
}

export function ClaimCard({ claim }: { claim: ClaimView }) {
  const meta =
    claim.mode === "interpretation"
      ? { label: "一种可能的解释", cls: "interpretation", icon: Sparkles }
      : claim.mode === "self_report"
        ? { label: "你的自述", cls: "self-report", icon: FileText }
        : { label: "目前能看到什么", cls: "observation", icon: Compass };
  const Icon = meta.icon;
  return (
    <article className={`claim-card ${meta.cls}`}>
      <div className="claim-head">
        <div className="claim-label">
          <span className="claim-icon">
            <Icon size={15} />
          </span>
          <span>{meta.label}</span>
        </div>
        <Confidence level={claim.confidence_level} />
      </div>
      <p className="claim-text">{claim.text}</p>
      <div className="claim-scope">
        <span>适用范围</span>
        <p>{claim.scope}</p>
      </div>
    </article>
  );
}

export function EvidenceSheet({
  evidence,
  onClose,
  onSourceAction,
  onAmendRequest,
  busySourceId,
}: {
  evidence: EvidenceView[];
  onClose: () => void;
  onSourceAction: (item: EvidenceView, action: "exclude" | "not_mine") => void;
  onAmendRequest: (item: EvidenceView) => void;
  busySourceId: string | null;
}) {
  return (
    <div className="overlay" role="presentation">
      <button type="button" className="overlay-backdrop" onClick={onClose} aria-label="关闭" />
      <section className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <p className="eyebrow">EVIDENCE</p>
            <h2>这次理解依据什么？</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="sheet-intro">
          这里展示的是当前理解实际使用的材料。材料被引用，不等于它能证明所有解释。
        </p>
        <div className="evidence-list">
          {evidence.map((item, index) => (
            <article className="evidence-item" key={item.spanId}>
              <div className="evidence-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <div className="evidence-meta">
                  <span>
                    {item.attributionStatus === "confirmed_other"
                      ? "已更正：非本人表达"
                      : item.attributionStatus === "quoted_other"
                        ? "引用他人表达"
                        : item.authorKind === "subject"
                          ? "本人直接提供"
                          : item.authorKind}
                  </span>
                  <span>
                    {item.eligibility === "eligible"
                      ? "可用于本次理解"
                      : item.eligibility === "context_only"
                        ? "仅作为情境保留"
                        : "已停止参与分析"}
                  </span>
                </div>
                <blockquote>{item.quote}</blockquote>
                {item.assessmentVersion && item.eligibility === "eligible" && (
                  <div className="evidence-actions">
                    <button
                      type="button"
                      disabled={busySourceId === item.sourceItemId}
                      onClick={() => onAmendRequest(item)}
                    >
                      补充 / 修改
                    </button>
                    <button
                      type="button"
                      disabled={busySourceId === item.sourceItemId}
                      onClick={() => onSourceAction(item, "not_mine")}
                    >
                      这不是我的表达
                    </button>
                    <button
                      type="button"
                      disabled={busySourceId === item.sourceItemId}
                      onClick={() => onSourceAction(item, "exclude")}
                    >
                      不用于分析
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function AmendmentSheet({
  item,
  onClose,
  onSubmit,
  busy,
}: {
  item: EvidenceView;
  onClose: () => void;
  onSubmit: (type: "supplements" | "corrects" | "updates", note: string) => void;
  busy: boolean;
}) {
  const [type, setType] = useState<"supplements" | "corrects" | "updates">("supplements");
  const [note, setNote] = useState("");
  return (
    <div className="overlay">
      <button type="button" className="overlay-backdrop" onClick={onClose} aria-label="关闭" />
      <section className="sheet correction-sheet">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <p className="eyebrow">AMEND INPUT</p>
            <h2>补充或修改这条输入</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <blockquote className="amend-source-quote">{item.quote}</blockquote>
        <p className="sheet-intro">
          原始记录会保留。FindMe 会根据你的选择决定旧内容是否继续参与当前分析。
        </p>
        <div className="correction-options">
          {amendmentOptions.map(([value, title, detail]) => (
            <button
              type="button"
              key={value}
              className={type === value ? "correction-option selected" : "correction-option"}
              onClick={() => setType(value)}
            >
              <span className="radio">{type === value && <Check size={12} />}</span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
        <textarea
          className="correction-note"
          placeholder={
            type === "corrects"
              ? "正确的情况是……"
              : type === "updates"
                ? "现在的情况是……"
                : "还需要补充的是……"
          }
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className="button primary wide"
          disabled={busy || !note.trim()}
          onClick={() => onSubmit(type, note.trim())}
        >
          {busy ? "正在保存…" : "保存并重新判断"}
        </button>
      </section>
    </div>
  );
}

export function CorrectionSheet({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (type: string, note: string) => void;
  busy: boolean;
}) {
  const [type, setType] = useState<string>("missing_context");
  const [note, setNote] = useState("");
  return (
    <div className="overlay">
      <button type="button" className="overlay-backdrop" onClick={onClose} aria-label="关闭" />
      <section className="sheet correction-sheet">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <p className="eyebrow">REVISE</p>
            <h2>哪里需要调整？</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="sheet-intro">这是在纠正 FindMe 的理解，不是在要求你“纠正自己”。</p>
        <div className="correction-options">
          {correctionOptions.map(([value, title, detail]) => (
            <button
              type="button"
              key={value}
              className={type === value ? "correction-option selected" : "correction-option"}
              onClick={() => setType(value)}
            >
              <span className="radio">{type === value && <Check size={12} />}</span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
        <textarea
          className="correction-note"
          placeholder="补充最关键的背景或纠正…"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className="button primary wide"
          disabled={busy || !note.trim()}
          onClick={() => onSubmit(type, note)}
        >
          {busy ? "正在重新理解…" : "提交调整"}
        </button>
      </section>
    </div>
  );
}

export function ResultView({
  data,
  revision,
  overlay,
  setOverlay,
  onCorrect,
  correcting,
  onContinue,
  onComplete,
  continuing,
  onSourceAction,
  onAmend,
  busySourceId,
  onDone,
}: {
  data: UnderstandingResponse;
  revision?: RevisionResponse | null;
  overlay: Overlay;
  setOverlay: (value: Overlay) => void;
  onCorrect: (type: string, note: string) => void;
  correcting: boolean;
  onContinue: () => void;
  onComplete: () => void;
  continuing: boolean;
  onSourceAction: (item: EvidenceView, action: "exclude" | "not_mine") => void;
  onAmend: (item: EvidenceView, type: "supplements" | "corrects" | "updates", note: string) => void;
  busySourceId: string | null;
  onDone: () => void;
}) {
  const [amendTarget, setAmendTarget] = useState<EvidenceView | null>(null);
  const visibleClaims = revision?.claims ?? data.claims;
  const gaps = revision?.gaps ?? data.gaps;
  const evidence = revision?.evidence ?? data.evidence;
  const needsReview = revision?.needs_review ?? data.needs_review ?? [];
  const outcome = revision?.outcome ?? data.outcome;
  const heading =
    needsReview.length > 0
      ? "有一条依据发生了变化。"
      : outcome === "insufficient"
        ? "现在还不足以形成一个可靠的认识。"
        : outcome === "withdrawn"
          ? "这次理解已经撤回。"
          : "先形成一个有限的理解。";
  const intro =
    needsReview.length > 0
      ? "受影响的认识已经停止作为有效当前认识展示。你可以先查看发生了什么，再决定是否继续探索。"
      : outcome === "insufficient"
        ? "目前更重要的是保留未知，而不是为了完整而制造结论。"
        : outcome === "withdrawn"
          ? "你补充的信息使原先的理解不再成立，目前没有足够依据形成替代认识。"
          : "它可以被补充、缩小或推翻，不是关于“你是谁”的最终结论。";
  return (
    <>
      <div className="flow-page result-page">
        <div className="flow-topline">
          <button type="button" className="icon-button quiet" onClick={onDone}>
            <X size={20} />
          </button>
          <div className="flow-progress">
            <span className="complete" />
            <span className="complete" />
            <span className="complete" />
          </div>
          <span className="flow-step">完成</span>
        </div>

        <div className="result-heading">
          <p className="eyebrow">CURRENT UNDERSTANDING</p>
          <h1 className="editorial">{heading}</h1>
          <p>{intro}</p>
        </div>

        {data.reading && (
          <section className="reading-card result-reading">
            <div>
              <span>这轮看清了一点</span>
              <p>{data.reading.current_reading}</p>
            </div>
            {data.reading.stop_reason && (
              <div className="reading-uncertainty">
                <span>为什么先停在这里</span>
                <p>{data.reading.stop_reason}</p>
              </div>
            )}
          </section>
        )}

        {revision && (
          <article className="revision-banner">
            <RefreshCw size={17} />
            <div>
              <strong>理解已经更新</strong>
              <p>{revision.change_summary}</p>
            </div>
          </article>
        )}

        {needsReview.length > 0 && (
          <section className="needs-review-card">
            <strong>这些认识暂时需要复核</strong>
            {needsReview.map((claim) => (
              <div key={claim.claim_revision_id}>
                <p>{claim.text}</p>
                <small>{claim.invalidation_reason ?? "依赖的来源或证据状态发生了变化。"}</small>
              </div>
            ))}
          </section>
        )}

        {visibleClaims.length > 0 && (
          <div className="claims-stack">
            {visibleClaims.map((claim) => (
              <ClaimCard key={claim.claim_revision_id} claim={claim} />
            ))}
          </div>
        )}

        {gaps.length > 0 && (
          <section className="unknown-card">
            <div className="unknown-title">
              <CircleHelp size={17} />
              <strong>现在还不能确定</strong>
            </div>
            {gaps.map((gap, index) => (
              <div className="gap-row" key={gap.key ?? gap.gapKey ?? index}>
                <p>{gap.question}</p>
                <small>{gap.why_it_matters ?? gap.whyItMatters}</small>
              </div>
            ))}
          </section>
        )}

        <div className="result-actions">
          {evidence.length > 0 && (
            <button
              type="button"
              className="button secondary wide"
              onClick={() => setOverlay("evidence")}
            >
              <BookOpenText size={17} />
              查看依据 <span>{evidence.length}</span>
            </button>
          )}
          {visibleClaims.length > 0 && (
            <button
              type="button"
              className="button ghost wide"
              onClick={() => setOverlay("correction")}
            >
              哪里不对？调整这条理解
            </button>
          )}
        </div>
        <button
          type="button"
          className="button primary wide"
          disabled={continuing}
          onClick={onContinue}
        >
          {continuing ? "正在判断是否值得继续…" : "再深入一次"}
        </button>
        <button type="button" className="button ghost wide" onClick={onComplete}>
          先到这里
        </button>
      </div>
      {overlay === "evidence" && (
        <EvidenceSheet
          evidence={evidence}
          busySourceId={busySourceId}
          onClose={() => setOverlay(null)}
          onSourceAction={onSourceAction}
          onAmendRequest={(item) => {
            setAmendTarget(item);
            setOverlay("amendment");
          }}
        />
      )}
      {overlay === "amendment" && amendTarget && (
        <AmendmentSheet
          item={amendTarget}
          busy={busySourceId === amendTarget.sourceItemId}
          onClose={() => {
            setAmendTarget(null);
            setOverlay("evidence");
          }}
          onSubmit={(type, note) => onAmend(amendTarget, type, note)}
        />
      )}
      {overlay === "correction" && (
        <CorrectionSheet busy={correcting} onClose={() => setOverlay(null)} onSubmit={onCorrect} />
      )}
    </>
  );
}
