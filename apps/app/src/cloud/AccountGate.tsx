import { type FormEvent, useState } from "react";
import { FindMeMark } from "../FindMeMark";
import { cloudMutation, resetCloudSession } from "../cloud-api";
import { message } from "./shared";

export function AccountGate({ ready }: { ready: () => void }) {
  const resetToken = new URLSearchParams(location.search).get("token");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const origin = location.origin;
      if (!resetToken) {
        await cloudMutation(
          "/api/auth/sign-in/email",
          { email, password, callbackURL: origin },
          "POST",
          false,
        );
        resetCloudSession();
        ready();
      } else {
        await cloudMutation(
          "/api/auth/reset-password",
          { token: resetToken, newPassword: password },
          "POST",
          false,
        );
        history.replaceState(null, "", location.pathname);
        setPassword("");
        setStatus("密码已更新，请登录。");
      }
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="access-page">
      <section className="access-card cloud-auth">
        <FindMeMark size={58} />
        <h1>看清自己。</h1>
        <p>同一账号在手机与电脑读取同一份资料。</p>
        <form onSubmit={submit}>
          {!resetToken && (
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
          )}
          <label>
            密码
            <input
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete={resetToken ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {/* biome-ignore lint/a11y/useSemanticElements: status text is a paragraph; <output> is for computed results. */}
          {status && <p role="status">{status}</p>}
          <button type="submit" className="button primary wide" disabled={busy}>
            {busy ? "提交中…" : resetToken ? "更新密码" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
