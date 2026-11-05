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
import { AccountGate } from "./cloud/AccountGate";
import { CloudReadingHome } from "./cloud/CloudReadingHome";
import { ConversationView } from "./cloud/ConversationView";
import { DataPanel } from "./cloud/DataPanel";
import { type ReportPane, RunDetail } from "./cloud/RunDetail";
import { SettingsPanel } from "./cloud/SettingsPanel";
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
    | "knowledge"
    | "support"
    | "perspective"
    | "data"
    | "settings"
    | "frameworks"
  >("home");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [talkTarget, setTalkTarget] = useState<string | null>(null);
  const [detailPane, setDetailPane] = useState<ReportPane>("read");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [domain, setDomain] = useState("self_understanding");
  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    setLoading(true);
    try {
      const value = await cloudRequest<Session | null>("/api/auth/get-session", {}, false);
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
      if (document.visibilityState === "visible")
        void refreshRuns().catch((e) => setError(message(e)));
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
        <p>恢复账号与资料…</p>
      </main>
    );
  if (!session)
    return (
      <>
        <AccountGate ready={() => void refreshSession()} />
        {error && <p className="global-error">{error}</p>}
      </>
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
        <details className="fm-account">
          <summary>{session.user.name || "我的资料"}</summary>
          <div>
            <label>
              我的资料
              <select
                aria-label="切换个人资料"
                value={profile}
                onChange={(e) => {
                  switchProfile(e.target.value);
                  // The account popover must not cover report actions on narrow screens.
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                {profiles
                  .filter((p) => p.status === "active")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name ?? "我的资料"}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                void action(async () => {
                  await cloudMutation("/api/auth/sign-out", {}, "POST", false);
                  sessionRequest.current++;
                  runsRequest.current++;
                  resetCloudSession();
                  setSession(null);
                  setProfile("");
                  setSelectedRun(null);
                  setRuns([]);
                })
              }
            >
              退出账号
            </button>
          </div>
        </details>
      </header>
      <nav className="fm-shell-nav fm-nav" aria-label="主导航">
        {(
          [
            ["home", "首页", Home],
            ["talk", "对话", MessageCircle],
            ["topics", "专题阅读", BookOpenText],
            ["history", "纠正与修订", History],
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
        {view === "support" && profile && <SpecialistView key={profile} />}
        {view === "perspective" && profile && <PerspectiveView key={profile} />}
        {view === "data" && profile && <DataPanel key={profile} />}
        {view === "settings" && <SettingsPanel />}
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
                ["settings", "模型设置"],
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
        <details className="cloud-profile-admin">
          <summary>管理个人 Profile</summary>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const name = window.prompt("新 Profile 名称：");
                if (!name) return;
                const created = await cloudMutation<Profile>(
                  "/api/profiles",
                  { name },
                  "POST",
                  false,
                );
                setProfiles(await cloudRequest("/api/profiles", {}, false));
                switchProfile(created.id);
              })
            }
          >
            创建独立 Profile
          </button>
          {profiles.map((p) => (
            <div key={p.id}>
              <span>
                {p.name ?? "我的资料"} · {p.status}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const name = window.prompt("修改名称：", p.name ?? "");
                    if (!name) return;
                    await cloudMutation(
                      `/api/profiles/${p.id}`,
                      { expected_version: p.version, name },
                      "PATCH",
                      false,
                    );
                    setProfiles(await cloudRequest("/api/profiles", {}, false));
                  })
                }
              >
                改名
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (
                      !window.confirm(
                        p.status === "active"
                          ? "归档此 Profile 并停止排队中的处理？资料不会删除。"
                          : "恢复此 Profile？不会自动恢复模型任务。",
                      )
                    )
                      return;
                    await cloudMutation(
                      `/api/profiles/${p.id}`,
                      {
                        expected_version: p.version,
                        status: p.status === "active" ? "archived" : "active",
                      },
                      "PATCH",
                      false,
                    );
                    await refreshSession();
                  })
                }
              >
                {p.status === "active" ? "归档" : "恢复"}
              </button>
            </div>
          ))}
        </details>
      </main>
    </div>
  );
}
