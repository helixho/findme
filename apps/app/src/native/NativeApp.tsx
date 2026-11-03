import type { CoreReportTarget } from "@findme/core";
import { ArrowLeft, X } from "lucide-react";
import { ApiError, coreApi } from "../api";
import {
  ComposeView,
  CurrentView,
  HomeView,
  PlanningView,
  QuestionView,
} from "./exploration-views";
import type { ReportBridgeState } from "./report-bridge";
import { ResultView } from "./result";
import { AccessGate, AppHeader, BottomNav, LoadingMark } from "./shell";
import { useNativeExploration } from "./useNativeExploration";

export function NativeApp({
  reportEntry,
  onReturnReport,
  reportTitles,
}: {
  reportEntry?: ReportBridgeState;
  reportTitles?: Record<string, string>;
  onReturnReport?: (target: CoreReportTarget | null) => void;
}) {
  const {
    authed,
    setAuthed,
    checking,
    view,
    setView,
    resumeFailed,
    setResumeFailed,
    event,
    setEvent,
    reportTarget,
    explorationId,
    reportSources,
    selectedSource,
    setSelectedSource,
    transferStatus,
    setTransferStatus,
    pendingPlan,
    setPendingPlan,
    answer,
    setAnswer,
    selectedOptions,
    setSelectedOptions,
    questionData,
    savedLabel,
    result,
    revision,
    current,
    activeExploration,
    currentLoading,
    busy,
    setBusy,
    correcting,
    continuing,
    busySourceId,
    overlay,
    setOverlay,
    error,
    setError,
    refreshCurrent,
    refreshActiveExploration,
    returnToReport,
    refreshReportSources,
    transferReportSource,
    goHome,
    begin,
    planNext,
    applyExplorationView,
    resumeActive,
    startExploration,
    respond,
    correct,
    continueCurrent,
    completeCurrent,
    amendEvidence,
    updateEvidenceSource,
  } = useNativeExploration({ reportEntry, onReturnReport });

  if (checking) return <LoadingMark label="正在进入 FindMe…" />;
  if (!authed)
    return (
      <AccessGate
        onReady={() => {
          setAuthed(true);
          void refreshCurrent();
          void refreshActiveExploration();
        }}
      />
    );

  const showShellHeader = view === "home" || view === "current";

  return (
    <div className="app-root">
      {showShellHeader && <AppHeader onHome={goHome} />}
      <main className="app-main">
        {onReturnReport && (
          <section className="home-section" aria-label="报告探索上下文">
            <button
              type="button"
              className="button secondary"
              disabled={busy || continuing || correcting}
              onClick={returnToReport}
            >
              <ArrowLeft size={16} /> 返回原报告目标
            </button>
            {reportTarget ? (
              <p>
                来自：{reportTitles?.[reportTarget.domain] ?? "当前专题"}
                {reportTarget.question && ` · ${reportTarget.question}`}
              </p>
            ) : (
              <p>这次探索没有已保存的报告目标，不能转成报告回应。</p>
            )}
            <p>报告目标只作为上下文。下面填写和保存的是你自己的具体事件。</p>
          </section>
        )}
        {error && (
          <div className="global-error">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {view === "home" && (
          <HomeView
            current={current}
            activeExploration={activeExploration}
            onStart={begin}
            onResume={resumeActive}
            onCurrent={() => {
              setView("current");
              void refreshCurrent();
            }}
          />
        )}
        {view === "compose" && (
          <ComposeView
            event={event}
            setEvent={setEvent}
            busy={busy}
            onBack={goHome}
            onSubmit={startExploration}
          />
        )}
        {view === "planning" &&
          (resumeFailed ? (
            <section className="flow-page">
              <h1>暂时无法恢复已保存的探索</h1>
              <p>未开始新的判断。请重新读取已保存的原事件和报告目标。</p>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  if (!explorationId) return;
                  setBusy(true);
                  setError("");
                  void coreApi
                    .exploration(explorationId)
                    .then(async (loaded) => {
                      setResumeFailed(false);
                      await applyExplorationView(loaded);
                    })
                    .catch((err) =>
                      setError(
                        err instanceof ApiError ? `恢复失败：${err.code}` : "暂时无法恢复。",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                重新读取探索
              </button>
            </section>
          ) : pendingPlan ? (
            <section className="flow-page">
              <h1>原始材料已保存</h1>
              <p>{event}</p>
              <p>保存和读取不会调用模型。继续判断会调用模型。</p>
              <button
                type="button"
                className="button primary"
                disabled={busy || continuing}
                onClick={() => {
                  const pending = pendingPlan;
                  setPendingPlan(null);
                  void planNext(pending.id, pending.version);
                }}
              >
                继续这次探索
              </button>
            </section>
          ) : (
            <PlanningView event={event} savedLabel={savedLabel} />
          ))}
        {view === "question" && questionData && (
          <QuestionView
            event={event}
            data={questionData}
            answer={answer}
            setAnswer={setAnswer}
            selectedOptions={selectedOptions}
            setSelectedOptions={setSelectedOptions}
            busy={busy}
            onBack={goHome}
            onSubmit={respond}
          />
        )}
        {view === "result" && result && (
          <ResultView
            data={result}
            revision={revision}
            overlay={overlay}
            setOverlay={setOverlay}
            onCorrect={correct}
            correcting={correcting}
            onContinue={continueCurrent}
            onComplete={completeCurrent}
            continuing={continuing}
            onSourceAction={updateEvidenceSource}
            onAmend={amendEvidence}
            busySourceId={busySourceId}
            onDone={goHome}
          />
        )}
        {onReturnReport && reportTarget && explorationId && (
          <section className="home-section" aria-label="选原始材料回应报告">
            <h2>选择一条原始材料回应报告</h2>
            <p>只保存你明确选中的完整原话；保存后仍需显式分析和独立审核。</p>
            <button
              type="button"
              disabled={busy || continuing || correcting}
              onClick={() => {
                setBusy(true);
                setSelectedSource("");
                setError("");
                void refreshReportSources(explorationId)
                  .catch((err) =>
                    setError(err instanceof ApiError ? `读取失败：${err.code}` : "来源读取失败。"),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              重新读取原始材料
            </button>
            {reportSources.map((source, index) => (
              <label key={source.source_id}>
                <input
                  type="radio"
                  name="report-original-source"
                  checked={selectedSource === source.source_id}
                  disabled={busy || continuing || correcting}
                  onChange={() => {
                    setSelectedSource(source.source_id);
                    setTransferStatus("");
                  }}
                />
                原始材料 {index + 1} · {source.disclosed_at}
                <blockquote>{source.content}</blockquote>
                {source.content.length > 2400 && (
                  <p>这条完整原文超过报告回应上限，不能截取后保存。</p>
                )}
              </label>
            ))}
            {!reportSources.length && <p>暂没有可选择的原始材料。</p>}
            <button
              type="button"
              className="button primary"
              disabled={
                busy ||
                continuing ||
                correcting ||
                !selectedSource ||
                (reportSources.find((source) => source.source_id === selectedSource)?.content
                  .length ?? Number.POSITIVE_INFINITY) > 2400
              }
              onClick={transferReportSource}
            >
              把所选完整原话保存为报告回应
            </button>
            {/* biome-ignore lint/a11y/useSemanticElements: status text is a paragraph; <output> is for computed results. */}
            {transferStatus && <p role="status">{transferStatus}</p>}
          </section>
        )}
        {view === "current" && (
          <CurrentView data={current} loading={currentLoading} onStart={begin} />
        )}
      </main>
      <BottomNav
        view={view}
        onHome={goHome}
        onCurrent={() => {
          setView("current");
          void refreshCurrent();
        }}
        onStart={begin}
      />
    </div>
  );
}
