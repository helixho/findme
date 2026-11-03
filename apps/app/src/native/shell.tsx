import { Home, Layers3, LocateFixed } from "lucide-react";
import { useState } from "react";
import { FindMeMark } from "../FindMeMark";
import { ApiError, clearAccessToken, coreApi, setAccessToken } from "../api";
import type { View } from "./model";

export function Mark({ size = 34 }: { size?: number }) {
  return <FindMeMark size={size} />;
}

export function LoadingMark({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <div className="loading-mark">
        <Mark size={54} />
        <span />
      </div>
      <p>{label}</p>
      <small>FindMe 正在整理材料，不急着得出结论。</small>
    </div>
  );
}

export function AccessGate({
  onReady,
  validate = () => coreApi.me(),
}: { onReady: () => void; validate?: () => Promise<unknown> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    setAccessToken(token);
    try {
      await validate();
      onReady();
    } catch (err) {
      clearAccessToken();
      setError(
        err instanceof ApiError && err.status !== 401
          ? `读取失败：${err.code}。请核对来源或连接后重试。`
          : "访问串无效或后端暂时不可用。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="access-page">
      <section className="access-card">
        <Mark size={58} />
        <div className="access-copy">
          <p className="eyebrow">FINDME · DEVELOPMENT</p>
          <h1>看清自己。</h1>
          <p>当前为个人开发访问层，不属于正式产品体验。</p>
        </div>
        <label>
          <span>开发访问串</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          type="button"
          className="button primary wide"
          disabled={busy || !token.trim()}
          onClick={submit}
        >
          {busy ? "验证中…" : "进入 FindMe"}
        </button>
      </section>
    </main>
  );
}

export function AppHeader({ onHome }: { onHome: () => void }) {
  return (
    <header className="app-header">
      <button type="button" className="brand-button" onClick={onHome} aria-label="FindMe 首页">
        <Mark />
        <strong>
          找我 <span>FindMe</span>
        </strong>
      </button>
      <div className="header-slogan">一份可以修订的自我认识</div>
    </header>
  );
}

export function BottomNav({
  view,
  onHome,
  onCurrent,
  onStart,
}: {
  view: View;
  onHome: () => void;
  onCurrent: () => void;
  onStart: () => void;
}) {
  if (view === "compose" || view === "planning" || view === "question" || view === "result")
    return null;
  return (
    <nav className="bottom-nav">
      <button type="button" className={view === "home" ? "active" : ""} onClick={onHome}>
        <Home size={19} />
        <span>首页</span>
      </button>
      <button type="button" className="nav-start" onClick={onStart} aria-label="开始探索">
        <LocateFixed size={21} />
      </button>
      <button type="button" className={view === "current" ? "active" : ""} onClick={onCurrent}>
        <Layers3 size={19} />
        <span>当前认识</span>
      </button>
    </nav>
  );
}
