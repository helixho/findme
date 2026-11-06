import { useCallback, useEffect, useState } from "react";
import { cloudMutation, cloudRequest } from "../cloud-api";
import type { CurrentUnderstandingResponse, UnderstandingChange } from "../types";
import { message } from "./shared";

const CORRECTION_TYPES = [
  ["wrong_fact", "事实不对"],
  ["missing_context", "缺少情境"],
  ["overinterpreted", "解释过度"],
  ["changed_now", "现在已经不同"],
  ["not_mine", "不是我的表达"],
  ["other", "其他"],
] as const;
const CHANGE_LABEL: Record<UnderstandingChange["change"], string> = {
  added: "新形成",
  revised: "已修订",
  withdrawn: "已停用",
};

/** The conversation a claim came from: claim keys are "<exploration id>/<key>". */
function conversationOf(key: string) {
  const id = key.split("/")[0] ?? "";
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

/**
 * Every judgement the system currently uses, so each one can be checked,
 * traced back to its conversation, corrected or stopped from one place.
 */
export function UnderstandingList({ onTalk }: { onTalk: (explorationId: string) => void }) {
  const [current, setCurrent] = useState<CurrentUnderstandingResponse | null>(null);
  const [changes, setChanges] = useState<UnderstandingChange[]>([]);
  const [search, setSearch] = useState("");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [type, setType] = useState("missing_context");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const [c, log] = await Promise.all([
      cloudRequest<CurrentUnderstandingResponse>("/api/core/understanding"),
      cloudRequest<{ items: UnderstandingChange[] }>("/api/core/understanding/changes?limit=50"),
    ]);
    setCurrent(c);
    setChanges(log.items ?? []);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
  }, [refresh]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      void refresh().catch(() => undefined);
    }
  }

  const claims = [...(current?.claims ?? []), ...(current?.needs_review ?? [])].filter(
    (claim) =>
      !search.trim() || claim.text.includes(search.trim()) || claim.scope.includes(search.trim()),
  );

  return (
    <section className="home-section">
      <h2>全部认识</h2>
      <p className="muted">
        这里保留当前认识和待核对的判断。有异议的内容会标明，核对前不作为无争议前提。觉得不对可以纠正，也可以停用。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      <label>
        查找
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {current && !claims.length && <p className="muted">还没有认识。</p>}
      <ul>
        {claims.map((claim) => {
          const conversation = conversationOf(claim.key);
          return (
            <li key={claim.claim_revision_id}>
              {claim.text}
              {claim.pending_feedback && <span className="fm-status">有本人反馈待核对</span>}
              {claim.evidence_status !== "valid" && (
                <span className="fm-status">依据已变化，待重新确认</span>
              )}
              <br />
              <span className="muted">
                适用范围：{claim.scope} · 依据：{claim.confidence_basis}
              </span>
              <div className="cloud-actions">
                {conversation && (
                  <button type="button" onClick={() => onTalk(conversation)}>
                    回到原对话
                  </button>
                )}
                {conversation && (
                  <button
                    type="button"
                    onClick={() => {
                      setCorrecting(claim.claim_revision_id);
                      setNote("");
                    }}
                  >
                    纠正这条
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await cloudMutation(
                        `/api/core/claim-revisions/${claim.claim_revision_id}/withdraw`,
                        {},
                      );
                      setNotice("已停用这条认识，之后的回答和首页不会再使用它。");
                    })
                  }
                >
                  以后不要再用这条
                </button>
              </div>
              {correcting === claim.claim_revision_id && (
                <div className="conversation-correct">
                  <label>
                    纠正类型
                    <select value={type} onChange={(e) => setType(e.target.value)}>
                      {CORRECTION_TYPES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    说明
                    <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      void act(async () => {
                        const saved = await cloudMutation<{
                          exploration_id: string;
                          version: number;
                          correction_source_id: string;
                        }>(`/api/core/claim-revisions/${claim.claim_revision_id}/corrections`, {
                          correction: { type, note: note.trim() },
                        });
                        setCorrecting(null);
                        try {
                          const revised = await cloudMutation<{ change_summary?: string }>(
                            `/api/core/explorations/${saved.exploration_id}/correct`,
                            {
                              expected_version: saved.version,
                              correction_source_id: saved.correction_source_id,
                            },
                          );
                          setNotice(
                            revised.change_summary
                              ? `已修订：${revised.change_summary}`
                              : "纠正已保存，仍在处理中。",
                          );
                        } catch (e) {
                          setNotice(`纠正已保存，暂未处理：${message(e)}。可在原对话里重新处理。`);
                        }
                      })
                    }
                  >
                    保存纠正
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {changes.length > 0 && (
        <details className="fm-secondary-nav">
          <summary>认识的变化记录</summary>
          <ul>
            {changes.map((change) => (
              <li key={change.claim_revision_id}>
                <span className="fm-status">{CHANGE_LABEL[change.change]}</span> {change.text}
                <br />
                <span className="muted">
                  {new Date(change.changed_at).toLocaleDateString("zh-CN")}
                  {change.reason ? ` · ${change.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
