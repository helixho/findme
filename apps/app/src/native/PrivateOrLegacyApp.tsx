import type { CoreReportTarget, UnderstandingAppView } from "@findme/core";
import { useEffect, useState } from "react";
import { FrameworkView } from "../FrameworkView";
import UnderstandingView from "../UnderstandingView";
import {
  ApiError,
  clearAccessToken,
  coreApi,
  getAccessToken,
  privateUnderstandingMode,
  understandingApi,
} from "../api";
import { frameworkAuthFetch } from "../framework-access";
import { NativeApp } from "./NativeApp";
import type { View } from "./model";
import { type ReportBridgeState, readReportBridge, storeReportBridge } from "./report-bridge";
import { AccessGate, AppHeader, LoadingMark } from "./shell";

/** Capability detection happens before native requests. Only a normal-mode 404 falls back. */
export function PrivateOrLegacyApp() {
  const [frameworkOpen, setFrameworkOpen] = useState(false);
  const [frameworkVisited, setFrameworkVisited] = useState(false);
  const [mode, setMode] = useState<"native" | "understanding" | null>(null);
  const [data, setData] = useState<UnderstandingAppView | null>(null);
  const [checking, setChecking] = useState(Boolean(getAccessToken()));
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("home");
  const startFeedback = 0;
  const [unavailable, setUnavailable] = useState("");
  const [nativeReportAvailable, setNativeReportAvailable] = useState(false);
  const [reportEntry, setReportEntry] = useState<ReportBridgeState | null>(null);
  const [returnTarget, setReturnTarget] = useState<CoreReportTarget | null>(null);
  async function detect() {
    try {
      const next = await understandingApi.read();
      setData(next);
      let available = false;
      if (!privateUnderstandingMode && next.capabilities.native_core === "available") {
        try {
          const capabilities = await coreApi.capabilities();
          available = capabilities.native_core === true && capabilities.report_bridge === true;
        } catch {
          /* Missing or unreadable capability is unavailable. */
        }
      }
      setNativeReportAvailable(available);
      const stored = readReportBridge();
      if (available && stored?.active) setReportEntry(stored);
      setMode("understanding");
      setError("");
    } catch (err) {
      if (!privateUnderstandingMode && err instanceof ApiError && err.status === 404) {
        await coreApi.me();
        setMode("native");
        return;
      }
      throw err;
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: access detection runs once on load.
  useEffect(() => {
    if (!getAccessToken()) return;
    void detect()
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) clearAccessToken();
        else setError(err instanceof ApiError ? `读取失败：${err.code}` : "连接失败，请重试。");
      })
      .finally(() => setChecking(false));
  }, []);
  if (checking) return <LoadingMark label="正在读取当前理解…" />;
  if (mode === "native") return <NativeApp />;
  if (mode === "understanding" && nativeReportAvailable && reportEntry)
    return (
      <NativeApp
        reportEntry={reportEntry}
        reportTitles={{
          overall: "整体理解",
          ...Object.fromEntries((data?.topics ?? []).map((topic) => [topic.domain, topic.title])),
        }}
        onReturnReport={(target) => {
          setReturnTarget(target);
          setReportEntry(null);
          setView("current");
          void understandingApi
            .read()
            .then((next) => {
              setData(next);
              setUnavailable("");
            })
            .catch((err) =>
              setUnavailable(
                err instanceof ApiError ? `当前来源读取失败：${err.code}` : "当前来源连接失败",
              ),
            );
        }}
      />
    );
  if (!mode)
    return (
      <>
        <AccessGate validate={detect} onReady={() => {}} />
        {error && <p className="global-error">{error}</p>}
      </>
    );
  if (!data) return <LoadingMark label="正在读取当前理解…" />;
  return (
    <div className="app-root">
      <AppHeader
        onHome={() => {
          setFrameworkOpen(false);
          setView("home");
        }}
      />
      <main className="app-main">
        {privateUnderstandingMode && (
          <details className="fm-secondary-nav">
            <summary>更多理解方式</summary>
            <nav className="u3-actions" aria-label="理解与独立框架">
              <button
                type="button"
                aria-pressed={!frameworkOpen}
                onClick={() => setFrameworkOpen(false)}
              >
                个人理解
              </button>
              <button
                type="button"
                aria-pressed={frameworkOpen}
                onClick={() => {
                  setFrameworkVisited(true);
                  setFrameworkOpen(true);
                }}
              >
                独立框架访谈
              </button>
            </nav>
          </details>
        )}
        {frameworkVisited && (
          <div hidden={!frameworkOpen}>
            <FrameworkView authFetch={frameworkAuthFetch} />
          </div>
        )}
        <div hidden={frameworkOpen}>
          <UnderstandingView
            data={data}
            view={view === "home" ? "home" : "current"}
            onCurrent={() => setView("current")}
            onHome={() => setView("home")}
            startFeedback={startFeedback}
            unavailable={unavailable}
            returnTarget={returnTarget}
            onExplore={
              nativeReportAvailable && !unavailable
                ? (target) => {
                    const entry = { target, active: true };
                    storeReportBridge(entry);
                    setReportEntry(entry);
                    setReturnTarget(null);
                  }
                : undefined
            }
            onReload={async () => {
              try {
                const next = await understandingApi.read();
                setData(next);
                setUnavailable("");
              } catch (err) {
                setUnavailable(
                  err instanceof ApiError ? `当前来源读取失败：${err.code}` : "当前来源连接失败",
                );
                throw err;
              }
            }}
          />
        </div>
      </main>
    </div>
  );
}
