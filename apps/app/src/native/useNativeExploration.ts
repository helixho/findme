import type { CoreReportTarget } from "@findme/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, clearAccessToken, coreApi, getAccessToken } from "../api";
import type {
  ContinueAskResponse,
  CoreReportSource,
  CurrentUnderstandingResponse,
  EvidenceView,
  ExplorationSummary,
  ExplorationView,
  RevisionResponse,
  UnderstandingResponse,
} from "../types";
import { type Overlay, type View, isUnauthorized } from "./model";
import { type ReportBridgeState, storeReportBridge } from "./report-bridge";
export function useNativeExploration({
  reportEntry,
  onReturnReport,
}: {
  reportEntry?: ReportBridgeState;
  reportTitles?: Record<string, string>;
  onReturnReport?: (target: CoreReportTarget | null) => void;
}) {
  const [authed, setAuthed] = useState(Boolean(getAccessToken()));
  const [checking, setChecking] = useState(Boolean(getAccessToken()));
  const [view, setView] = useState<View>(
    reportEntry?.explorationId ? "planning" : reportEntry ? "compose" : "home",
  );
  const [resumeFailed, setResumeFailed] = useState(false);
  const [event, setEvent] = useState(reportEntry?.event ?? "");
  const [reportTarget, setReportTarget] = useState<CoreReportTarget | null>(
    reportEntry?.target ?? null,
  );
  const [explorationId, setExplorationId] = useState<string | null>(
    reportEntry?.explorationId ?? null,
  );
  const [reportSources, setReportSources] = useState<CoreReportSource[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [transferStatus, setTransferStatus] = useState("");
  const [pendingPlan, setPendingPlan] = useState<{ id: string; version: number } | null>(null);
  const [answer, setAnswer] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [questionData, setQuestionData] = useState<ContinueAskResponse | null>(null);
  const [savedLabel, setSavedLabel] = useState("内容已保存");
  const [result, setResult] = useState<UnderstandingResponse | null>(null);
  const [revision, setRevision] = useState<RevisionResponse | null>(null);
  const [current, setCurrent] = useState<CurrentUnderstandingResponse | null>(null);
  const [activeExploration, setActiveExploration] = useState<ExplorationSummary | null>(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [error, setError] = useState("");

  const activeClaims = useMemo(() => revision?.claims ?? result?.claims ?? [], [result, revision]);

  const refreshCurrent = useCallback(async () => {
    setCurrentLoading(true);
    try {
      setCurrent(await coreApi.current());
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
    } finally {
      setCurrentLoading(false);
    }
  }, []);

  const refreshActiveExploration = useCallback(async () => {
    try {
      const list = await coreApi.explorations("active", 1);
      setActiveExploration(list.items[0] ?? null);
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (!getAccessToken()) {
      setChecking(false);
      return;
    }
    coreApi
      .me()
      .then(() => {
        setAuthed(true);
        void refreshCurrent();
        void refreshActiveExploration();
      })
      .catch(() => {
        setAuthed(false);
        clearAccessToken();
      })
      .finally(() => setChecking(false));
  }, [refreshActiveExploration, refreshCurrent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the bridge is stored when the report target changes, not on every parent callback identity.
  useEffect(() => {
    if (onReturnReport && reportTarget)
      storeReportBridge({
        target: reportTarget,
        explorationId: explorationId ?? undefined,
        event,
        active: true,
      });
  }, [reportTarget, explorationId, event]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resume runs once for the entry the page opened with.
  useEffect(() => {
    if (!reportEntry?.explorationId) return;
    setBusy(true);
    void coreApi
      .exploration(reportEntry.explorationId)
      .then(applyExplorationView)
      .catch((err) => {
        setResumeFailed(true);
        setReportTarget(null);
        setError(err instanceof ApiError ? `恢复失败：${err.code}` : "暂时没能恢复这次探索。");
      })
      .finally(() => setBusy(false));
  }, []);
  function returnToReport() {
    if (busy || continuing || correcting) return;
    const storedTarget = reportTarget ?? reportEntry?.target;
    if (storedTarget)
      storeReportBridge({
        target: storedTarget,
        explorationId: explorationId ?? undefined,
        event,
        active: false,
      });
    onReturnReport?.(reportTarget);
  }
  async function refreshReportSources(id: string) {
    if (!onReturnReport) return;
    const loaded = await coreApi.exploration(id);
    setReportTarget(loaded.report_target ?? null);
    setReportSources(loaded.report_sources ?? []);
  }
  async function waitForReportPlan(id: string, version: number) {
    setPendingPlan({ id, version });
    setView("planning");
    setReportSources([]);
    setSelectedSource("");
    setTransferStatus("");
    try {
      await refreshReportSources(id);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `原话已保存，来源读取失败：${err.code}`
          : "原话已保存，暂时无法读取来源。请重新读取。",
      );
    }
  }
  async function transferReportSource() {
    const source = reportSources.find((item) => item.source_id === selectedSource);
    if (!source || !explorationId || !reportTarget) return;
    setBusy(true);
    setError("");
    setTransferStatus("");
    try {
      const receipt = await coreApi.reportFeedback(explorationId, {
        source_id: source.source_id,
        assessment_version: source.assessment_version,
        content_hash: source.content_hash,
      });
      setTransferStatus(`原始材料已保存到报告回应（${receipt.status}），尚未自动分析或修改报告。`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `报告回应未保存：${err.code}。请重新读取来源后重试。`
          : "报告回应保存失败，所选原文仍保留。",
      );
    } finally {
      setBusy(false);
    }
  }
  function resetFlow() {
    setPendingPlan(null);
    setEvent("");
    setAnswer("");
    setSelectedOptions([]);
    setQuestionData(null);
    setSavedLabel("内容已保存");
    setResult(null);
    setRevision(null);
    setOverlay(null);
    setError("");
  }

  function goHome() {
    if (onReturnReport) {
      returnToReport();
      return;
    }
    resetFlow();
    setView("home");
    void refreshCurrent();
    void refreshActiveExploration();
  }

  function begin() {
    resetFlow();
    setExplorationId(null);
    setReportSources([]);
    setSelectedSource("");
    setTransferStatus("");
    setView("compose");
  }

  async function planNext(explorationId: string, version: number, forceDeeper = false) {
    setContinuing(true);
    setView("planning");
    setError("");
    try {
      const data = await coreApi.continue(explorationId, version, forceDeeper);
      setAnswer("");
      setSelectedOptions([]);
      setRevision(null);

      if (data.phase === "awaiting_answer") {
        setQuestionData(data);
        setResult(null);
        setView("question");
      } else {
        setQuestionData(null);
        setResult(data);
        setView("result");
        void refreshCurrent();
      }
      void refreshActiveExploration();
      await refreshReportSources(explorationId);
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthed(false);
        return;
      }
      if (err instanceof ApiError && err.code === "STALE_VERSION") {
        setError("探索已经发生变化，请重新打开最新版本。");
      } else {
        setError("内容已经保存，但暂时没能完成下一步判断。可以稍后从首页继续这次探索。");
      }
      setView("home");
      void refreshActiveExploration();
    } finally {
      setContinuing(false);
    }
  }

  async function applyExplorationView(exploration: ExplorationView) {
    setExplorationId(exploration.id);
    setReportTarget(exploration.report_target ?? null);
    setReportSources(exploration.report_sources ?? []);
    setSelectedSource("");
    setTransferStatus("");
    setPendingPlan(null);
    setEvent(exploration.experience.summary);
    setAnswer("");
    setSelectedOptions([]);
    setRevision(null);
    setOverlay(null);
    setError("");

    if (exploration.phase === "awaiting_answer" && exploration.open_question) {
      const step = exploration.latest_step;
      setQuestionData({
        exploration_id: exploration.id,
        experience_id: exploration.experience.id,
        version: exploration.version,
        phase: "awaiting_answer",
        reading: {
          current_reading:
            step?.current_reading ?? "这次经历已经记录，当前只继续确认会改变理解的部分。",
          key_uncertainty: step?.key_uncertainty ?? null,
          intent: step?.intent ?? exploration.open_question.intent,
        },
        question: exploration.open_question,
        question_budget: exploration.question_budget,
      });
      setResult(null);
      setView("question");
      return;
    }

    if (exploration.phase === "ready_to_plan") {
      setSavedLabel("内容已保存");
      setQuestionData(null);
      setResult(null);
      if (onReturnReport) {
        setPendingPlan({ id: exploration.id, version: exploration.version });
        setView("planning");
      } else {
        await planNext(exploration.id, exploration.version);
      }
      return;
    }

    setQuestionData(null);
    setResult({
      exploration_id: exploration.id,
      experience_id: exploration.experience.id,
      version: exploration.version,
      phase:
        exploration.phase === "review" ||
        exploration.phase === "insufficient" ||
        exploration.phase === "needs_review"
          ? exploration.phase
          : undefined,
      outcome: exploration.understanding.outcome,
      claims: exploration.understanding.claims,
      gaps: exploration.understanding.gaps,
      needs_review: exploration.understanding.needs_review,
      next_question: null,
      evidence: exploration.evidence,
      reading: exploration.latest_step
        ? {
            current_reading: exploration.latest_step.current_reading,
            key_uncertainty: exploration.latest_step.key_uncertainty,
            intent: exploration.latest_step.intent,
            stop_reason: exploration.latest_step.stop_reason,
          }
        : undefined,
      question_budget: exploration.question_budget,
    });
    setView("result");
  }

  async function resumeActive() {
    if (!activeExploration) return;
    setBusy(true);
    setError("");
    try {
      await applyExplorationView(await coreApi.exploration(activeExploration.id));
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else setError("暂时没能恢复这次探索，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  async function startExploration() {
    if (!event.trim()) return;
    setBusy(true);
    setError("");
    try {
      const data = await coreApi.start(
        event.trim(),
        onReturnReport ? (reportTarget ?? undefined) : undefined,
      );
      setExplorationId(data.exploration.id);
      if (reportTarget)
        storeReportBridge({
          target: reportTarget,
          explorationId: data.exploration.id,
          event,
          active: true,
        });
      setSavedLabel("事件已保存");
      setBusy(false);
      setView("planning");
      if (onReturnReport) await waitForReportPlan(data.exploration.id, data.exploration.version);
      else await planNext(data.exploration.id, data.exploration.version);
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else setError("暂时没能保存这次探索。你的文字还在页面里，可以稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  async function respond() {
    if (!questionData || (!answer.trim() && selectedOptions.length === 0)) return;
    setBusy(true);
    setError("");
    try {
      const data = await coreApi.respond(
        questionData.exploration_id,
        questionData.version,
        questionData.question.id,
        answer.trim(),
        selectedOptions,
      );
      setSavedLabel("回答已保存");
      setBusy(false);
      setAnswer("");
      setSelectedOptions([]);
      setQuestionData(null);
      setView("planning");
      if (onReturnReport) await waitForReportPlan(data.exploration_id, data.version);
      else await planNext(data.exploration_id, data.version);
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else if (err instanceof ApiError && err.code === "STALE_VERSION") {
        setError("这次探索已经变化，请重新打开最新版本后再回答。");
      } else {
        setError("回答还没有保存成功，页面里的内容仍然保留，可以直接重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  async function correct(type: string, note: string) {
    if (!result || !activeClaims.length) return;
    setCorrecting(true);
    setError("");
    try {
      const data = await coreApi.correct(
        result.exploration_id,
        revision?.version ?? result.version,
        activeClaims.map((claim) => claim.claim_revision_id),
        { type, note },
      );
      setRevision(data);
      setOverlay(null);
      void refreshCurrent();
      void refreshActiveExploration();
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else if (
        err instanceof ApiError &&
        (err.code === "STALE_VERSION" || err.code === "STALE_CLAIM_REVISION")
      ) {
        setError("这条认识刚刚发生了变化。请保留当前补充，关闭调整后重新打开最新版本。");
      } else {
        setError("调整没有保存成功。原来的理解不会被静默覆盖。");
      }
    } finally {
      setCorrecting(false);
    }
  }

  async function continueCurrent() {
    if (!result) return;
    setSavedLabel("当前认识已保存");
    await planNext(result.exploration_id, revision?.version ?? result.version, true);
  }

  async function completeCurrent() {
    if (!result) return;
    setContinuing(true);
    setError("");
    try {
      await coreApi.complete(result.exploration_id, revision?.version ?? result.version);
      goHome();
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else if (err instanceof ApiError && err.code === "STALE_VERSION") {
        setError("探索已经发生变化，请返回首页重新打开最新版本。");
      } else {
        setError("暂时没能结束这次探索，内容仍然保留。");
      }
    } finally {
      setContinuing(false);
    }
  }

  async function amendEvidence(
    item: EvidenceView,
    type: "supplements" | "corrects" | "updates",
    note: string,
  ) {
    if (!result) return;
    setBusySourceId(item.sourceItemId);
    setError("");
    try {
      const data = await coreApi.amend(
        result.exploration_id,
        revision?.version ?? result.version,
        item.sourceItemId,
        type,
        note,
      );
      setOverlay(null);
      setResult(null);
      setRevision(null);
      setSavedLabel(
        type === "corrects" ? "更正已保存" : type === "updates" ? "当前变化已保存" : "补充已保存",
      );
      setView("planning");
      if (onReturnReport) await waitForReportPlan(data.exploration_id, data.version);
      else await planNext(data.exploration_id, data.version);
      void refreshCurrent();
      void refreshActiveExploration();
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else if (
        err instanceof ApiError &&
        (err.code === "SOURCE_VERSION_CONFLICT" || err.code === "STALE_VERSION")
      ) {
        setError("这条输入刚刚发生了变化，请重新打开最新版本后再修改。");
      } else {
        setError("这次补充还没有保存成功，原来的输入不会被覆盖。");
      }
    } finally {
      setBusySourceId(null);
    }
  }

  async function updateEvidenceSource(item: EvidenceView, action: "exclude" | "not_mine") {
    if (!result || !item.assessmentVersion) return;
    setBusySourceId(item.sourceItemId);
    setError("");
    try {
      await coreApi.sourceAssessment(item.sourceItemId, item.assessmentVersion, {
        attribution_status:
          action === "not_mine"
            ? "confirmed_other"
            : (item.attributionStatus ?? "confirmed_subject"),
        context_completeness: item.contextCompleteness ?? "unknown",
        temporal_precision: item.temporalPrecision ?? "unknown",
        eligibility: action === "not_mine" ? "context_only" : "excluded",
        rationale:
          action === "not_mine"
            ? "用户明确指出这份材料不是本人表达，不应作为本人观点的分析证据。"
            : "用户明确要求这份材料停止参与后续分析。",
      });
      setOverlay(null);
      await applyExplorationView(await coreApi.exploration(result.exploration_id));
      void refreshCurrent();
      void refreshActiveExploration();
    } catch (err) {
      if (isUnauthorized(err)) setAuthed(false);
      else if (err instanceof ApiError && err.code === "SOURCE_VERSION_CONFLICT") {
        setError("这份来源刚刚发生了变化，已保留你的选择，请重新打开依据后再操作。");
      } else {
        setError("来源设置没有保存成功，当前认识不会因此被静默修改。");
      }
    } finally {
      setBusySourceId(null);
    }
  }
  return {
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
  };
}
