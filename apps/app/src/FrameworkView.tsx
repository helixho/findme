import type {
  FrameworkAssertion,
  FrameworkCatalog,
  FrameworkDomainAssessment,
  FrameworkRunView,
} from "@findme/core";
import { useEffect, useMemo, useState } from "react";
import { getAccessToken, privateUnderstandingMode } from "./api";
import {
  FrameworkApiError,
  type FrameworkAuthFetch,
  type FrameworkEvidence,
  createFrameworkApi,
} from "./framework-api";
import "./understanding.css";

const errors: Record<string, string> = {
  DRAFT_DISABLED: "内部草稿尚未开放运行；需要服务端明确启用。",
  FRAMEWORK_PROVIDER_DISABLED: "分析出口未启用；回答仍可保存。",
  U4_BUDGET_EXHAUSTED: "独立 U4 调用预算不足；已保存的回答保留。",
  DEFINITION_DRIFT: "定义版本内容发生变化，已停止运行。",
  STALE_RUN_VERSION: "运行已在另一操作中更新，请刷新后继续；输入已保留。",
  AUDIT_REJECTED: "候选未通过独立复核，未发布。请更正或补充相关作答。",
  SEMANTIC_REJECTION_REQUIRES_CHANGE: "同一输入的候选曾被拒绝；需要更正或排除相关回答后继续。",
  PROVIDER_TIMEOUT: "分析超时，输出记录保留；请显式恢复。",
  ANSWER_REQUIRED: "请填写有效回答后保存。",
  DUPLICATE_ANSWER: "重复回答不计入访谈，请补充不同的具体经历。",
  FRAMEWORK_BUSY: "正在分析，请稍后刷新。",
  SOURCE_CHANGED: "回答已更正或排除，旧结果停止展示，需要重新复核。",
  GENERATION_OBSOLETE: "作答状态改变，旧输出未发布。",
};
const status: Record<FrameworkRunView["status"], string> = {
  active: "访谈进行中",
  paused: "已暂停，可从同一题恢复",
  completed: "本版本访谈与综合已完成 · 待本人评价",
  abandoned: "已放弃",
  needs_review: "来源变化 · 待复核",
};
function Assertion({
  item,
  evidence,
}: { item: FrameworkAssertion; evidence: (id: string) => void }) {
  return (
    <div>
      <p>
        {item.text}
        {item.basis === "hypothesis" && "（假说／建议）"}
      </p>
      <div className="u3-actions">
        {item.refs.map((r, i) => (
          <button type="button" key={`${r.source_id}:${i}`} onClick={() => evidence(r.source_id)}>
            依据 {i + 1} · {r.start}–{r.end}
          </button>
        ))}
      </div>
    </div>
  );
}
function Domain({
  assessment: a,
  run,
  evidence,
}: {
  assessment: FrameworkDomainAssessment;
  run: FrameworkRunView;
  evidence: (id: string) => void;
}) {
  const d = run.definition;
  return (
    <section className="home-section">
      <h2>{d.domains.find((x) => x.key === a.domain)?.title}</h2>
      <p>
        {a.evidence_status === "not_asked"
          ? "尚未询问"
          : a.evidence_status === "unknown"
            ? "资料不足，等级与阶段未知"
            : `${d.levels.find((x) => x.key === a.level)?.key} · ${d.phases.find((x) => x.key === a.phase)?.key}`}
      </p>
      <p>{a.reason}</p>
      {a.rationale && <Assertion item={a.rationale} evidence={evidence} />}
      {(
        [
          ["知识", a.knowledge],
          ["经历", a.experience],
          ["技能", a.skill],
        ] as const
      ).map(([label, t]) => (
        <div key={label}>
          <h3>{label}</h3>
          {t.assessment ? (
            <Assertion item={t.assessment} evidence={evidence} />
          ) : (
            <p>
              {t.status === "not_asked" ? "尚未询问" : "未知"} · {t.reason}
            </p>
          )}
        </div>
      ))}
      {(
        [
          ["优势", a.strengths],
          ["限制", a.limitations],
          ["知识与实践的差异", a.practice_mismatch],
          ["情境中的退步", a.regression],
          ["强烈投入与代价", a.channels],
        ] as const
      ).map(
        ([label, items]) =>
          items.length > 0 && (
            <div key={label}>
              <h3>{label}</h3>
              {items.map((item) => (
                <Assertion key={item.id} item={item} evidence={evidence} />
              ))}
            </div>
          ),
      )}
    </section>
  );
}
export function FrameworkView({
  authFetch,
  draftScope,
}: { authFetch: FrameworkAuthFetch; draftScope?: string }) {
  const api = useMemo(() => createFrameworkApi(authFetch), [authFetch]);
  const [scope, setScope] = useState(draftScope ?? "");
  const [catalog, setCatalog] = useState<FrameworkCatalog | null>(null);
  const [run, setRun] = useState<FrameworkRunView | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exact, setExact] = useState<FrameworkEvidence | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string; reason: string } | null>(null);
  const [abandonConfirm, setAbandonConfirm] = useState(false);
  // Tab-local drafts and mutation identities survive normal page navigation. The
  // private path uses a token digest, never a shared "static" owner bucket.
  useEffect(() => {
    if (draftScope) {
      setScope(draftScope);
      return;
    }
    let live = true;
    const token = getAccessToken();
    if (!token) return;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then((bytes) => {
      if (live)
        setScope(
          `${privateUnderstandingMode ? "private" : "legacy"}:${Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("")}`,
        );
    });
    return () => {
      live = false;
    };
  }, [draftScope]);
  const storageKey = (kind: string, identity: string) =>
    `findme_framework:${JSON.stringify([scope, kind, identity])}`;
  const draftKey = (r: FrameworkRunView | null) =>
    r?.open_question && scope ? storageKey("answer", `${r.id}:${r.open_question.id}`) : null;
  const keyFor = (identity: string) => {
    const name = storageKey("mutation", identity);
    const old = sessionStorage.getItem(name);
    if (old) return old;
    const key = crypto.randomUUID();
    sessionStorage.setItem(name, key);
    return key;
  };
  const saveDraft = (value: string) => {
    const key = draftKey(run);
    if (key) {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    }
    setText(value);
  };
  const currentDraftKey = draftKey(run);
  useEffect(() => {
    setText(currentDraftKey ? (sessionStorage.getItem(currentDraftKey) ?? "") : "");
  }, [currentDraftKey]);
  useEffect(() => {
    let live = true;
    api
      .catalog()
      .then((c) => {
        if (live) setCatalog(c);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [api]);
  function message(e: unknown) {
    const code = e instanceof FrameworkApiError ? e.code : "FRAMEWORK_REQUEST_FAILED";
    return errors[code] ?? `操作未完成（${code}）；回答草稿保留。`;
  }
  async function act(fn: () => Promise<FrameworkRunView>, clear = false) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (clear) {
        const key = draftKey(run);
        if (key) sessionStorage.removeItem(key);
        setText("");
        setSaved(true);
      }
      setRun(r);
      if (r.error) setError(errors[r.error] ?? `分析未完成（${r.error}）`);
      setCatalog(await api.catalog());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function showEvidence(id: string) {
    if (!run) return;
    try {
      setExact(await api.evidence(run.id, id));
    } catch (e) {
      setError(message(e));
    }
  }
  const canContinue =
    run &&
    ["active", "paused", "needs_review"].includes(run.status) &&
    (!run.open_question || run.status === "needs_review" || run.status === "paused");
  const synthesis = run?.result?.synthesis;
  if (!scope) return <p>正在确认当前访谈身份…</p>;
  return (
    <div className="current-page u3-page">
      <p className="eyebrow">FRAMEWORK VIEW</p>
      <h1>按框架理解自己</h1>
      <p>独立框架视角。逐题保存，另行分析；结果与原生认识分开，发展建议不会自动变成任务。</p>
      {error && (
        <p className="global-error" role="alert">
          {error}
        </p>
      )}
      {catalog && (
        <p>
          分析{catalog.capabilities.provider_enabled ? "已启用" : "未启用"} · U4 独立剩余调用{" "}
          {catalog.capabilities.remaining_u4_calls}。读取与保存不调用模型。
        </p>
      )}
      {!run &&
        catalog?.definitions.map(({ definition: d, available, blocked_reason }) => (
          <section className="home-section" key={d.key + d.version}>
            <h2>{d.title}</h2>
            <p>
              {d.version} · {d.publication_status === "draft" ? "内部草稿" : d.publication_status}
            </p>
            <p>{d.disclaimer}</p>
            <p>
              {d.domains
                .map((x) => `${x.title}：${x.min_answers}–${x.max_answers} 个有效作答`)
                .join("；")}
            </p>
            {!available && <p>{errors[blocked_reason ?? ""] ?? blocked_reason}</p>}
            <button
              className="button secondary"
              type="button"
              disabled={busy || !available || !scope}
              onClick={() =>
                act(async () => {
                  const identity = `start:${d.content_hash}`;
                  const started = await api.start(
                    { key: d.key, definition_version: d.version, definition_hash: d.content_hash },
                    keyFor(identity),
                  );
                  sessionStorage.removeItem(storageKey("mutation", identity));
                  return started;
                })
              }
            >
              开始独立访谈
            </button>
            <details>
              <summary>来源与执行边界</summary>
              <p>{d.creator}</p>
              <p>{d.source_status}</p>
              {d.source_refs.map((s) => (
                <p key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.attribution}
                  </a>
                </p>
              ))}
              {d.boundaries.map((b) => (
                <p key={b}>{b}</p>
              ))}
            </details>
          </section>
        ))}
      {!run && (
        <section className="home-section">
          <h2>恢复已有访谈</h2>
          {catalog?.runs.length === 0 && <p>尚无运行。不会从历史材料自动生成评分。</p>}
          {catalog?.runs.map((r) => (
            <button
              className="home-claim"
              type="button"
              disabled={busy}
              key={r.id}
              onClick={() => act(() => api.get(r.id))}
            >
              <span>
                <strong>{r.title}</strong>
                <small>
                  {status[r.status]} · {new Date(r.updated_at).toLocaleString()}
                </small>
              </span>
            </button>
          ))}
        </section>
      )}
      {run && (
        <>
          <div className="u3-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRun(null);
                setText("");
                setEdit(null);
                setExact(null);
                setSaved(false);
                setAbandonConfirm(false);
              }}
            >
              返回框架列表
            </button>
            <button type="button" disabled={busy} onClick={() => act(() => api.get(run.id))}>
              刷新运行状态
            </button>
          </div>
          <p>
            {run.definition.title} · {run.definition.version} · 运行版本 {run.version}
          </p>
          <output>
            {status[run.status]}
            {busy || run.processing ? " · 正在处理，请勿重复提交" : ""}
          </output>
          <p>{run.definition.disclaimer}</p>
          <p>
            {run.mode === "history_adapted"
              ? "历史适配结果，不能标作原协议完成。"
              : "本轮直接作答，不自动复制历史材料。"}
          </p>
          <details>
            <summary>来源、等级含义与执行限制</summary>
            <p>{run.definition.source_status}</p>
            {run.definition.source_refs.map((s) => (
              <p key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.attribution}
                </a>
              </p>
            ))}
            {[...run.definition.levels, ...run.definition.phases, ...run.definition.concepts].map(
              (x) => (
                <p key={x.key}>{x.meaning}</p>
              ),
            )}
            {run.definition.boundaries.map((b) => (
              <p key={b}>{b}</p>
            ))}
            <p>定义指纹：{run.definition.content_hash}</p>
          </details>
          <p>
            {run.definition.domains
              .map(
                (d) =>
                  `${d.title} ${run.answers.filter((a) => a.domain === d.key && a.status === "valid").length}/${d.min_answers}（最多 ${d.max_answers}）`,
              )
              .join(" · ")}
          </p>
          {run.open_question && (
            <section className="u3-feedback">
              <h2>
                {run.definition.domains.find((d) => d.key === run.open_question?.domain)?.title}
              </h2>
              <p>{run.open_question.text}</p>
              <label>
                你的回答
                <textarea
                  rows={6}
                  value={text}
                  maxLength={12000}
                  onChange={(e) => {
                    saveDraft(e.target.value);
                    setSaved(false);
                  }}
                  disabled={busy || run.processing}
                />
              </label>
              {saved && <output>原话已保存，尚未分析。</output>}
              <button
                className="button secondary"
                type="button"
                disabled={
                  busy || !scope || run.processing || !text.trim() || run.status !== "active"
                }
                onClick={() =>
                  act(
                    () => api.respond(run, text, keyFor(`answer:${run.id}:${run.version}:${text}`)),
                    true,
                  )
                }
              >
                仅保存回答
              </button>
              {run.status === "active" && (
                <button
                  type="button"
                  disabled={busy || run.processing}
                  onClick={() =>
                    act(() => api.skip(run, keyFor(`skip:${run.id}:${run.version}`)), true)
                  }
                >
                  跳过这一题
                </button>
              )}
            </section>
          )}
          {run.status === "active" && (
            <button
              type="button"
              disabled={busy || run.processing}
              onClick={() => act(() => api.pause(run, keyFor(`pause:${run.id}:${run.version}`)))}
            >
              暂停访谈
            </button>
          )}
          {saved && !run.open_question && <output>原话已保存。点击继续分析才会调用模型。</output>}
          {canContinue && (
            <button
              className="button secondary"
              type="button"
              disabled={busy || (run.processing && !run.recovery_required)}
              onClick={() =>
                act(() =>
                  api.continue(
                    run,
                    run.recovery_required,
                    keyFor(`continue:${run.id}:${run.version}:${run.recovery_required}`),
                  ),
                )
              }
            >
              {run.recovery_required
                ? "显式恢复分析"
                : run.status === "paused" && run.open_question
                  ? "恢复同一题"
                  : run.status === "needs_review" && run.open_question
                    ? "恢复作答"
                    : "继续分析（生成并独立复核）"}
            </button>
          )}
          {run.result && (
            <section className="u3-report">
              <h2>本版本框架报告</h2>
              {run.result.domains.map((a) => (
                <Domain key={a.domain} assessment={a} run={run} evidence={showEvidence} />
              ))}
              {synthesis && (
                <>
                  <h2>生活整合</h2>
                  <Assertion item={synthesis.integration} evidence={showEvidence} />
                  <h3>生活方式：{synthesis.lifestyle.name}</h3>
                  <Assertion item={synthesis.lifestyle.assessment} evidence={showEvidence} />
                  <h3>本次动态命名：{synthesis.metatype.name}</h3>
                  <Assertion item={synthesis.metatype.assessment} evidence={showEvidence} />
                  <h3>跨领域关系</h3>
                  {synthesis.cross_domain_links.map((l) => (
                    <Assertion key={l.assessment.id} item={l.assessment} evidence={showEvidence} />
                  ))}
                  <h3>核心问题假说</h3>
                  <Assertion item={synthesis.core_problem} evidence={showEvidence} />
                  {synthesis.plans.map((p) => (
                    <section key={p.horizon}>
                      <h3>{p.horizon} · 可选发展建议</h3>
                      {p.proposals.map((a) => (
                        <Assertion key={a.id} item={a} evidence={showEvidence} />
                      ))}
                    </section>
                  ))}
                  {synthesis.glitch_risks.length > 0 && (
                    <section>
                      <h3>高风险加速概念的风险说明</h3>
                      {synthesis.glitch_risks.map((a) => (
                        <Assertion key={a.id} item={a} evidence={showEvidence} />
                      ))}
                    </section>
                  )}
                </>
              )}
            </section>
          )}
          {run.status !== "abandoned" && (
            <section className="home-section">
              <h2>已保存回答与更正</h2>
              {run.answers
                .filter((a) => a.status === "valid")
                .map((a, i) => (
                  <article key={a.id}>
                    <h3>
                      回答 {i + 1} · {run.definition.domains.find((d) => d.key === a.domain)?.title}
                    </h3>
                    <p>{a.text}</p>
                    <p>{new Date(a.saved_at).toLocaleString()}</p>
                    <div className="u3-actions">
                      <button type="button" onClick={() => showEvidence(a.id)}>
                        查看原话定位
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setEdit({ id: a.id, text: a.text ?? "", reason: "" })}
                      >
                        更正或排除
                      </button>
                    </div>
                  </article>
                ))}
            </section>
          )}
          {edit && (
            <section className="u3-feedback">
              <h2>修订回答</h2>
              <p>旧原话保留为历史，停止用作当前依据；报告需重新复核。</p>
              <label>
                更正后的原话
                <textarea
                  rows={5}
                  value={edit.text}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  maxLength={12000}
                />
              </label>
              <label>
                修订原因
                <textarea
                  rows={2}
                  value={edit.reason}
                  onChange={(e) => setEdit({ ...edit, reason: e.target.value })}
                  maxLength={1000}
                />
              </label>
              <div className="u3-actions">
                {(["correct", "exclude"] as const).map((action) => (
                  <button
                    type="button"
                    key={action}
                    disabled={
                      busy || !edit.reason.trim() || (action === "correct" && !edit.text.trim())
                    }
                    onClick={async () => {
                      try {
                        setBusy(true);
                        setError("");
                        const updated = await api.amend(
                          run,
                          edit.id,
                          action,
                          edit.text,
                          edit.reason,
                          keyFor(
                            `amend:${run.id}:${run.version}:${action}:${JSON.stringify(edit)}`,
                          ),
                        );
                        setRun(updated);
                        setEdit(null);
                        setExact(null);
                        setCatalog(await api.catalog());
                      } catch (e) {
                        setError(message(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {action === "correct" ? "保存更正" : "确认排除此回答"}
                  </button>
                ))}
                <button type="button" disabled={busy} onClick={() => setEdit(null)}>
                  取消
                </button>
              </div>
            </section>
          )}
          {run.status !== "abandoned" && (
            <section>
              <button type="button" disabled={busy} onClick={() => setAbandonConfirm(true)}>
                放弃此轮访谈
              </button>
              {abandonConfirm && (
                <div className="u3-feedback">
                  <p>
                    确认结束此轮？已保存原话保留在私有历史，结果停止展示，正在生成的输出不会发布。
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      await act(() => api.abandon(run, keyFor(`abandon:${run.id}:${run.version}`)));
                      setAbandonConfirm(false);
                      setExact(null);
                    }}
                  >
                    确认放弃
                  </button>
                  <button type="button" onClick={() => setAbandonConfirm(false)}>
                    取消
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
      {exact && (
        <section className="u3-feedback" aria-label="精确作答依据">
          <h2>精确作答依据</h2>
          <p>问题：{exact.question}</p>
          <blockquote>{exact.text}</blockquote>
          <p>
            {exact.saved_at} · 原文位置 {exact.start}–{exact.end}（UTF-16）
          </p>
          <details>
            <summary>来源身份</summary>
            <p>{exact.id}</p>
            <p>原文指纹：{exact.hash}</p>
          </details>
          <button type="button" onClick={() => setExact(null)}>
            关闭依据
          </button>
        </section>
      )}
    </div>
  );
}
