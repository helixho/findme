import { BookOpenText, History, Home, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FindMeMark } from "./FindMeMark";
import { FrameworkView } from "./FrameworkView";
import { KnowledgeView } from "./KnowledgeView";
import { PerspectiveView } from "./PerspectiveView";
import { SpecialistView } from "./SpecialistView";
import {
  CloudApiError,
  cloudFrameworkFetch,
  cloudMutation,
  cloudRequest,
  currentCloudProfile,
  resetCloudSession,
  selectCloudProfile,
} from "./cloud-api";
import { CloudReadingHome } from "./cloud/CloudReadingHome";
import { ConversationView } from "./cloud/ConversationView";
import { DataPanel } from "./cloud/DataPanel";
import { type ReportPane, RunDetail } from "./cloud/RunDetail";
import { UnderstandingList } from "./cloud/UnderstandingList";
import { type Profile, type Run, type Session, message } from "./cloud/shared";
import "./cloud-workspace.css";

export default function CloudWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionRequest = useRef(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const runsRequest = useRef(0);
  const [view, setView] = useState<
    | "home"
    | "talk"
    | "topics"
    | "history"
    | "understanding"
    | "knowledge"
    | "support"
    | "perspective"
    | "data"
    | "frameworks"
  >("home");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [talkTarget, setTalkTarget] = useState<string | null>(null);
  // Bumped whenever the workspace refreshes, so the home re-reads Core state too.
  const [homeToken, setHomeToken] = useState(0);
  const [detailPane, setDetailPane] = useState<ReportPane>("read");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [domain, setDomain] = useState("self_understanding");
  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    setLoading(true);
    try {
      // No sign-in: the instance acts as its single owner.
      const value = await cloudRequest<Session | null>("/api/session", {}, false);
      if (request !== sessionRequest.current) return;
      if (value) {
        const ps = await cloudRequest<Profile[]>("/api/profiles", {}, false);
        if (request !== sessionRequest.current) return;
        const stored = sessionStorage.getItem("findme_cloud:profile");
        const id =
          ps.find((p) => p.status === "active" && p.id === stored)?.id ??
          ps.find((p) => p.status === "active")?.id ??
          "";
        if (currentCloudProfile() !== id) selectCloudProfile(id);
        setProfiles(ps);
        setProfile(id);
      }
      setSession(value);
    } catch (e) {
      if (request === sessionRequest.current) setError(message(e));
    } finally {
      if (request === sessionRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  const refreshRuns = useCallback(async () => {
    if (!profile) return;
    const request = ++runsRequest.current;
    try {
      const next = await cloudRequest<Run[]>("/api/diagnostics?limit=50");
      if (request === runsRequest.current && currentCloudProfile() === profile) setRuns(next);
    } catch (e) {
      if (request !== runsRequest.current || currentCloudProfile() !== profile) return;
      setRuns([]);
      throw e;
    }
  }, [profile]);
  useEffect(() => {
    void refreshRuns().catch((e) => setError(message(e)));
  }, [refreshRuns]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setHomeToken((n) => n + 1);
        void refreshRuns().catch((e) => setError(message(e)));
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshRuns]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 401) {
        setSession(null);
        resetCloudSession();
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function switchProfile(id: string) {
    runsRequest.current++;
    selectCloudProfile(id);
    setProfile(id);
    setRuns([]);
    setSelectedRun(null);
    setView("home");
    setError("");
  }
  if (loading)
    return (
      <main className="access-page">
        <p>正在打开…</p>
      </main>
    );
  if (!session)
    return (
      <main className="access-page">
        <p>{error || "暂时连不上，请稍后刷新。"}</p>
      </main>
    );
  return (
    <div className="app-root cloud-workspace">
      <header className="cloud-header">
        <button
          type="button"
          className="brand-button fm-brand"
          aria-label="FindMe 首页"
          onClick={() => {
            setSelectedRun(null);
            setView("home");
          }}
        >
          <FindMeMark />
          <strong>
            找我 <span>FindMe</span>
          </strong>
        </button>
      </header>
      <nav className="fm-shell-nav fm-nav" aria-label="主导航">
        {(
          [
            ["home", "首页", Home],
            ["talk", "对话", MessageCircle],
            ["topics", "专题阅读", BookOpenText],
            ["understanding", "全部认识", History],
          ] as const
        ).map(([key, title, Icon]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => {
              setView(key);
              setSelectedRun(null);
              setTalkTarget(null);
              setHomeToken((n) => n + 1);
              void action(refreshRuns);
            }}
          >
            <Icon size={20} />
            <span>{title}</span>
          </button>
        ))}
      </nav>
      <main className="app-main">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {view === "frameworks" && profile && (
          <FrameworkView
            key={`${session.user.id}:${profile}`}
            draftScope={`account:${session.user.id}:profile:${profile}`}
            authFetch={cloudFrameworkFetch}
          />
        )}
        {view === "knowledge" && profile && (
          <KnowledgeView
            key={`${session.user.id}:${profile}`}
            requestScope={`${session.user.id}:${profile}`}
          />
        )}
        {view === "talk" && profile && (
          <ConversationView key={`${profile}:${talkTarget ?? ""}`} resumeId={talkTarget} />
        )}
        {view === "understanding" && profile && (
          <UnderstandingList
            key={profile}
            onTalk={(id) => {
              setTalkTarget(id);
              setView("talk");
              window.scrollTo({ top: 0, behavior: "instant" });
            }}
          />
        )}
        {view === "support" && profile && <SpecialistView key={profile} />}
        {view === "perspective" && profile && <PerspectiveView key={profile} />}
        {view === "data" && profile && <DataPanel key={profile} />}
        {(["home", "topics", "history"] as string[]).includes(view) &&
          (selectedRun ? (
            <RunDetail
              key={profile + selectedRun}
              runId={selectedRun}
              userId={session.user.id}
              initialPane={detailPane}
              onUpdated={refreshRuns}
              onBack={() => {
                setSelectedRun(null);
                void action(refreshRuns);
              }}
            />
          ) : (
            <>
              <CloudReadingHome
                key={profile}
                profile={profile}
                runs={runs}
                mode={view as "home" | "topics" | "history"}
                refreshToken={homeToken}
                onTalk={(id) => {
                  setTalkTarget(id ?? null);
                  setView("talk");
                  window.scrollTo({ top: 0, behavior: "instant" });
                }}
                onOpen={(id, pane = "read") => {
                  setSelectedRun(id);
                  setDetailPane(pane);
                  window.scrollTo({ top: 0, behavior: "instant" });
                }}
              />
              <details className="fm-secondary-nav">
                <summary>从新的经历或问题开始</summary>
                <section className="home-section">
                  <h2>开始新的理解</h2>
                  <label>
                    问题
                    <input
                      value={question}
                      maxLength={2000}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="现在想理解什么？"
                    />
                  </label>
                  <label>
                    专题
                    <select value={domain} onChange={(e) => setDomain(e.target.value)}>
                      <option value="self_understanding">自我理解</option>
                      <option value="role_direction">角色与方向</option>
                      <option value="collaboration">协作与边界</option>
                      <option value="daily_conditions">日常条件</option>
                      <option value="overall">已有专题的综合总览</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !question.trim() || !profile}
                    onClick={() =>
                      void action(async () => {
                        const run = await cloudMutation<Run>("/api/diagnostics", {
                          question,
                          domain,
                        });
                        setQuestion("");
                        await refreshRuns();
                        setSelectedRun(run.id);
                      })
                    }
                  >
                    创建专题，不调用模型
                  </button>
                </section>
              </details>
            </>
          ))}
        <details className="fm-secondary-nav">
          <summary>更多理解方式与资料</summary>
          <nav className="cloud-actions" aria-label="其他功能">
            {(
              [
                ["frameworks", "独立框架"],
                ["knowledge", "专题与来源"],
                ["support", "具体困难与尝试"],
                ["perspective", "作品视角"],
                ["data", "我的资料"],
              ] as const
            ).map(([key, title]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => {
                  setView(key);
                  setSelectedRun(null);
                }}
              >
                {title}
              </button>
            ))}
          </nav>
        </details>
      </main>
    </div>
  );
}
