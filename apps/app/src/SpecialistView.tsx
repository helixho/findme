import { useEffect, useState } from "react";
import { CloudApiError, cloudMutation, cloudRequest } from "./cloud-api";

type Session = {
  id: string;
  version: number;
  status: "open" | "paused" | "completed";
  pathway: "general" | "adhd";
  goal: string | null;
  setting: string | null;
  difficulty: string | null;
  environment: string | null;
  existingSupports: string | null;
  selfReportedDiagnosis: string | null;
  difficultyCategories: string[];
  environmentCategories: string[];
  scopeFlags: string[];
  burden: string | null;
};
type Proposal = {
  id: string;
  version: number;
  status: "proposed" | "accepted" | "rejected" | "paused";
  actionText: string;
  burden: string;
  cost: string;
  unknowns: string;
  contentBasis: {
    title: string;
    version: string;
    claim: { text: string };
    sources: { title: string; url: string }[];
  };
};
type Trial = {
  id: string;
  version: number;
  proposalId: string;
  acceptedAction: string;
  status: string;
  latestExecution: string | null;
  latestOutcome: string | null;
  reviewHistory?: { related_claim_revision_id?: string | null; source_id?: string }[];
};
type SessionBundle = { session: Session; proposals: Proposal[]; trials: Trial[] };
type Candidate = {
  content_id: string;
  version: string;
  title: string;
  claim_id: string;
  claim_text: string;
  candidate_options: string[];
  applicable_when: string[];
  not_applicable_when: string[];
  burdens?: string[];
  costs?: string[];
  unknowns?: string[];
  limits: string[];
  sources: { title: string; url: string }[];
  eligibility: { matched_keys: string[]; excluded_by: string[] };
};
type CandidateList = { status: string; items: Candidate[]; missing?: string[] };
type RelatedClaim = { id: string; text: string; topic: string };

const difficultyChoices = [
  ["task_start", "开始任务"],
  ["task_sustain", "维持专注"],
  ["task_switch", "任务切换"],
  ["time_estimation", "估计时间"],
  ["organization", "整理步骤"],
  ["distraction", "容易受干扰"],
  ["noise", "噪声"],
  ["light", "光线"],
  ["seating", "座位安排"],
  ["movement_break", "活动休息"],
  ["written_instructions", "口头要求难保留"],
] as const;

const root = "/api/specialist";
function message(error: unknown) {
  return error instanceof CloudApiError
    ? error.code
    : error instanceof Error
      ? error.message
      : "操作失败";
}

function TrialReviewForm({
  trial,
  busy,
  relatedClaims,
  onReview,
}: {
  trial: Trial;
  busy: boolean;
  relatedClaims: RelatedClaim[];
  onReview: (review: {
    expected_version: number;
    execution: string;
    outcome: string;
    observation: string;
    related_claim_revision_id?: string;
    continue_trial: boolean;
  }) => void;
}) {
  const [execution, setExecution] = useState("unknown");
  const [outcome, setOutcome] = useState("unknown");
  const [observation, setObservation] = useState("");
  const [relatedClaimId, setRelatedClaimId] = useState("");
  const [continueTrial, setContinueTrial] = useState(false);
  return (
    <details>
      <summary>记录实际情况</summary>
      <label>
        实际做了多少
        <select
          value={execution}
          onChange={(event) => {
            setExecution(event.target.value);
            if (event.target.value === "not_executed") setOutcome("unknown");
          }}
        >
          <option value="unknown">暂不确定</option>
          <option value="not_executed">没有执行</option>
          <option value="partly_executed">执行了一部分</option>
          <option value="completed">已执行</option>
        </select>
      </label>
      <label>
        实际作用
        <select
          value={outcome}
          disabled={execution === "not_executed"}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="unknown">尚不清楚</option>
          <option value="helpful">有帮助</option>
          <option value="no_effect">没有明显作用</option>
          <option value="mixed">有利有弊</option>
          <option value="worse">更难了</option>
        </select>
      </label>
      <label>
        观察到什么
        <textarea
          rows={2}
          value={observation}
          onChange={(event) => setObservation(event.target.value)}
        />
      </label>
      {!!relatedClaims.length && (
        <label>
          如果这次经历影响一条已有认识，可选关联；实际执行后该认识会标为待复核
          <select
            value={relatedClaimId}
            onChange={(event) => setRelatedClaimId(event.target.value)}
          >
            <option value="">暂不关联</option>
            {relatedClaims.map((claim) => (
              <option value={claim.id} key={claim.id}>
                {claim.topic} · {claim.text.slice(0, 100)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="cloud-choice">
        <input
          type="checkbox"
          checked={continueTrial}
          onChange={(event) => setContinueTrial(event.target.checked)}
        />
        继续保留这项尝试
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onReview({
            expected_version: trial.version,
            execution,
            outcome,
            observation,
            ...(relatedClaimId ? { related_claim_revision_id: relatedClaimId } : {}),
            continue_trial: continueTrial,
          })
        }
      >
        保存回顾
      </button>
      <p>
        <small>未执行、无效或暂停都是有效记录，不用于给你下人格判断。</small>
      </p>
    </details>
  );
}

export function SpecialistView() {
  const [sessions, setSessions] = useState<SessionBundle[]>([]);
  const [relatedClaims, setRelatedClaims] = useState<RelatedClaim[]>([]);
  const [selected, setSelected] = useState<SessionBundle | null>(null);
  const [editing, setEditing] = useState(false);
  const [candidates, setCandidates] = useState<CandidateList | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [applicabilityConfirmed, setApplicabilityConfirmed] = useState(false);
  const [pathway, setPathway] = useState<"general" | "adhd">("adhd");
  const [goal, setGoal] = useState("");
  const [setting, setSetting] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [difficultyCategories, setDifficultyCategories] = useState<string[]>([]);
  const [environmentCategories, setEnvironmentCategories] = useState<string[]>([]);
  const [scopeFlags, setScopeFlags] = useState<string[]>([]);
  const [environment, setEnvironment] = useState("");
  const [existingSupports, setExistingSupports] = useState("");
  const [burden, setBurden] = useState("");
  const [diagnosis, setDiagnosis] = useState("prefer_not_to_say");
  const [adjustmentKind, setAdjustmentKind] = useState("environment");
  const [actionText, setActionText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh(preferredId?: string) {
    const [list, topics] = await Promise.all([
      cloudRequest<{ items: SessionBundle[] }>(`${root}/adhd/sessions`),
      cloudRequest<
        {
          result: { title: string; findings: { claim_revision_id: string; text: string }[] } | null;
        }[]
      >("/api/knowledge/topics"),
    ]);
    setSessions(list.items);
    setRelatedClaims(
      topics.flatMap((topic) =>
        (topic.result?.findings ?? []).map((finding) => ({
          id: finding.claim_revision_id,
          text: finding.text,
          topic: topic.result?.title ?? "专题",
        })),
      ),
    );
    const id = preferredId ?? selected?.session.id;
    if (id) setSelected(list.items.find((item) => item.session.id === id) ?? null);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial read; mutations refresh explicitly.
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
  }, []);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(item: SessionBundle) {
    setSelected(item);
    setEditing(false);
    setCandidate(null);
    setCandidates(
      await cloudRequest<CandidateList>(
        `${root}/adhd/content-candidates?session_id=${item.session.id}`,
      ),
    );
  }

  function editContext() {
    if (!selected) return;
    const s = selected.session;
    setPathway(s.pathway);
    setGoal(s.goal ?? "");
    setSetting(s.setting ?? "");
    setDifficulty(s.difficulty ?? "");
    setDifficultyCategories(s.difficultyCategories);
    setEnvironment(s.environment ?? "");
    setEnvironmentCategories(s.environmentCategories);
    setScopeFlags(s.scopeFlags ?? []);
    setExistingSupports(s.existingSupports ?? "");
    setBurden(s.burden ?? "");
    setDiagnosis(s.selfReportedDiagnosis ?? "prefer_not_to_say");
    setEditing(true);
    setCandidate(null);
  }

  return (
    <section className="specialist-view">
      <h1>具体困难与可选调整</h1>
      <p>
        从一件具体事和你的目标出发。ADHD
        相关入口由你选择；这里不推断诊断。建议须同时有你的情境和已发布内容依据，确认后才会成为尝试。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="cloud-actions">
        <button type="button" disabled={busy} onClick={() => void act(() => refresh())}>
          刷新
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setEditing(false);
            setGoal("");
            setSetting("");
            setDifficulty("");
            setDifficultyCategories([]);
            setEnvironment("");
            setEnvironmentCategories([]);
            setScopeFlags([]);
            setExistingSupports("");
            setBurden("");
            setDiagnosis("prefer_not_to_say");
            setCandidates(null);
            setCandidate(null);
          }}
        >
          开始另一件事
        </button>
      </div>
      {!!sessions.length && (
        <details>
          <summary>已保存的情境 · {sessions.length}</summary>
          {sessions.map((item) => (
            <button
              type="button"
              className="cloud-run"
              key={item.session.id}
              disabled={busy}
              onClick={() => void act(() => open(item))}
            >
              <strong>{item.session.goal || "尚未写下目标"}</strong>
              <span>
                {item.session.pathway === "adhd" ? "ADHD 相关支持" : "一般调整"} · 建议{" "}
                {item.proposals.length} · 尝试 {item.trials.length}
              </span>
            </button>
          ))}
        </details>
      )}
      {(!selected || editing) && (
        <section className="home-section">
          <h2>{selected ? "补全或修改这件事的情境" : "先说一件具体事"}</h2>
          <label>
            选择入口
            <select
              disabled={!!selected}
              value={pathway}
              onChange={(e) => setPathway(e.target.value as "general" | "adhd")}
            >
              <option value="adhd">ADHD 相关执行困难</option>
              <option value="general">一般任务与环境调整</option>
            </select>
          </label>
          <label>
            你希望这件事有什么变化
            <input
              maxLength={800}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：更容易开始一项工作"
            />
          </label>
          <label>
            发生在什么场景
            <input
              maxLength={300}
              value={setting}
              onChange={(e) => setSetting(e.target.value)}
              placeholder="例如：在家处理邮件"
            />
          </label>
          <label>
            具体卡在哪里
            <textarea
              rows={2}
              maxLength={800}
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>选择最贴近的困难（由你选择，系统不据此诊断）</legend>
            {difficultyChoices.map(([value, label]) => (
              <label className="cloud-choice" key={value}>
                <input
                  type="checkbox"
                  checked={difficultyCategories.includes(value)}
                  onChange={(e) =>
                    setDifficultyCategories((items) =>
                      e.target.checked ? [...items, value] : items.filter((item) => item !== value),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <details>
            <summary>可跳过：环境、已有支持与负担</summary>
            <label>
              环境中有什么影响
              <textarea
                rows={2}
                maxLength={800}
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>环境因素（可跳过）</legend>
              {difficultyChoices
                .filter(([value]) =>
                  [
                    "distraction",
                    "noise",
                    "light",
                    "seating",
                    "movement_break",
                    "written_instructions",
                  ].includes(value),
                )
                .map(([value, label]) => (
                  <label className="cloud-choice" key={value}>
                    <input
                      type="checkbox"
                      checked={environmentCategories.includes(value)}
                      onChange={(e) =>
                        setEnvironmentCategories((items) =>
                          e.target.checked
                            ? [...items, value]
                            : items.filter((item) => item !== value),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
            </fieldset>
            <label>
              已经试过或正在使用什么支持
              <textarea
                rows={2}
                maxLength={800}
                value={existingSupports}
                onChange={(e) => setExistingSupports(e.target.value)}
              />
            </label>
            <label>
              这件事目前带来什么负担
              <textarea
                rows={2}
                maxLength={500}
                value={burden}
                onChange={(e) => setBurden(e.target.value)}
              />
            </label>
          </details>
          {pathway === "adhd" && (
            <label>
              关于诊断的自报情况（可跳过）
              <select value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)}>
                <option value="prefer_not_to_say">不记录</option>
                <option value="diagnosed">本人说已有诊断</option>
                <option value="concern">本人有疑虑，未报告诊断</option>
                <option value="none">未报告诊断</option>
              </select>
            </label>
          )}
          <fieldset>
            <legend>以下情况是否适用于这件事（可不选）</legend>
            {(
              [
                ["urgent_or_crisis_support", "现在需要紧急支持"],
                ["clinical_decision", "我需要诊断或治疗判断"],
                ["safety_constraint", "这项调整会影响安全或他人必要工作"],
              ] as const
            ).map(([value, label]) => (
              <label className="cloud-choice" key={value}>
                <input
                  type="checkbox"
                  checked={scopeFlags.includes(value)}
                  onChange={(e) =>
                    setScopeFlags((items) =>
                      e.target.checked ? [...items, value] : items.filter((item) => item !== value),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="button primary"
            disabled={busy || !goal.trim()}
            onClick={() =>
              void act(async () => {
                const response = await cloudMutation<{ session: Session }>(
                  selected
                    ? `${root}/adhd/sessions/${selected.session.id}`
                    : `${root}/adhd/sessions`,
                  {
                    ...(selected
                      ? { expected_version: selected.session.version }
                      : { pathway, voluntary: true }),
                    goal,
                    setting,
                    difficulty,
                    difficulty_categories: difficultyCategories,
                    environment,
                    environment_categories: environmentCategories,
                    scope_flags: scopeFlags,
                    existing_supports: existingSupports,
                    burden,
                    ...(pathway === "adhd" ? { self_reported_diagnosis: diagnosis } : {}),
                  },
                  selected ? "PATCH" : "POST",
                );
                setEditing(false);
                await refresh(response.session.id);
                setCandidates(
                  await cloudRequest<CandidateList>(
                    `${root}/adhd/content-candidates?session_id=${response.session.id}`,
                  ),
                );
              })
            }
          >
            {selected ? "保存情境补充" : "保存情境"}
          </button>
          {selected && (
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              取消修改
            </button>
          )}
          <p>
            <small>可以只保存情境，不接受任何建议。空缺步骤不会变成诊断结论。</small>
          </p>
        </section>
      )}
      {selected && !editing && (
        <>
          <section className="home-section">
            <h2>你的情境</h2>
            <p>目标：{selected.session.goal || "尚未记录"}</p>
            <p>
              场景：{selected.session.setting || "尚未记录"} · 困难：
              {selected.session.difficulty || "尚未记录"}
            </p>
            <p>本人所选困难类别：{selected.session.difficultyCategories.join("、") || "未选择"}</p>
            <p>
              环境：{selected.session.environment || "尚未记录"} · 已有支持：
              {selected.session.existingSupports || "尚未记录"}
            </p>
            {selected.session.pathway === "adhd" && (
              <small>
                诊断状态仅为本人自报：{selected.session.selfReportedDiagnosis || "未记录"}
                ；不会由上述困难推断。
              </small>
            )}
            <div className="cloud-actions">
              <button
                type="button"
                disabled={busy || selected.session.status === "completed"}
                onClick={editContext}
              >
                补全或修改情境
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const operation = selected.session.status === "paused" ? "resume" : "pause";
                    await cloudMutation(
                      `${root}/adhd/sessions/${selected.session.id}/${operation}`,
                      { expected_version: selected.session.version },
                    );
                    await refresh(selected.session.id);
                    setCandidates(null);
                  })
                }
              >
                {selected.session.status === "paused" ? "恢复这件事" : "暂停这件事"}
              </button>
            </div>
          </section>
          <section className="home-section">
            <h2>可考虑的方法依据</h2>
            {!candidates && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setCandidates(
                      await cloudRequest<CandidateList>(
                        `${root}/adhd/content-candidates?session_id=${selected.session.id}`,
                      ),
                    );
                  })
                }
              >
                读取已发布内容
              </button>
            )}
            {candidates?.status === "insufficient_personal_context" && (
              <p>还缺少可判断适用性的个人场景；可以先停在这里，不生成建议。</p>
            )}
            {candidates?.status === "no_applicable_published_content" && (
              <p>当前没有适合这个场景的已发布方法内容，因此暂不生成建议。</p>
            )}
            {candidates?.items.map((item) => (
              <article key={`${item.content_id}:${item.version}:${item.claim_id}`}>
                <h3>{item.title}</h3>
                <p>{item.claim_text}</p>
                <small>内容版本 {item.version} · 适用条件须由你核对；这不证明方法对你有效。</small>
                <details>
                  <summary>来源、限制和代价</summary>
                  {item.sources.map((source) => (
                    <p key={source.url}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>
                    </p>
                  ))}
                  <p>适用：{item.applicable_when.join("；")}</p>
                  <p>不适用：{item.not_applicable_when.join("；")}</p>
                  <p>负担：{item.burdens?.join("；") || "需要按个人情境判断"}</p>
                  <p>代价：{item.costs?.join("；") || "需要按个人情境判断"}</p>
                  <p>未知：{item.unknowns?.join("；") || "实际效果尚未知"}</p>
                  <p>限制：{item.limits.join("；")}</p>
                </details>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCandidate(item);
                    setActionText(item.candidate_options[0] ?? "");
                    setApplicabilityConfirmed(false);
                  }}
                >
                  考虑一项小调整
                </button>
              </article>
            ))}
            {candidate && (
              <section>
                <h3>把候选缩成一次尝试</h3>
                <p>{candidate.claim_text}</p>
                <label>
                  调整类型
                  <select
                    value={adjustmentKind}
                    onChange={(e) => setAdjustmentKind(e.target.value)}
                  >
                    <option value="environment">环境</option>
                    <option value="task_structure">任务结构</option>
                    <option value="written_instruction">书面说明</option>
                    <option value="distraction_reduction">减少干扰</option>
                    <option value="movement_break">活动休息</option>
                  </select>
                </label>
                <label>
                  选一项小调整
                  <select value={actionText} onChange={(e) => setActionText(e.target.value)}>
                    {candidate.candidate_options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <p>可能的负担：{candidate.burdens?.join("；")}</p>
                <p>可能的代价：{candidate.costs?.join("；")}</p>
                <p>仍不知道：{candidate.unknowns?.join("；")}</p>
                <label className="cloud-choice">
                  <input
                    type="checkbox"
                    checked={applicabilityConfirmed}
                    onChange={(e) => setApplicabilityConfirmed(e.target.checked)}
                  />
                  我核对过上述适用范围，愿意把它保留为候选建议
                </label>
                <div className="cloud-actions">
                  <button
                    type="button"
                    disabled={busy || !actionText.trim() || !applicabilityConfirmed}
                    onClick={() =>
                      void act(async () => {
                        await cloudMutation(
                          `${root}/adhd/sessions/${selected.session.id}/proposals`,
                          {
                            content_id: candidate.content_id,
                            content_version: candidate.version,
                            claim_id: candidate.claim_id,
                            adjustment_kind: adjustmentKind,
                            action_text: actionText,
                            applicability_confirmed: candidate.eligibility.matched_keys,
                            scope_reviewed: true,
                          },
                        );
                        setCandidate(null);
                        await refresh(selected.session.id);
                      })
                    }
                  >
                    保存为候选建议
                  </button>
                  <button type="button" onClick={() => setCandidate(null)}>
                    不采用
                  </button>
                </div>
              </section>
            )}
          </section>
          {!!selected.proposals.length && (
            <section className="home-section">
              <h2>建议由你决定</h2>
              {selected.proposals.map((proposal) => (
                <article key={proposal.id}>
                  <h3>{proposal.actionText}</h3>
                  <p>
                    状态：{proposal.status} · 负担：{proposal.burden} · 代价：{proposal.cost}
                  </p>
                  <p>未知：{proposal.unknowns}</p>
                  <small>
                    方法依据：{proposal.contentBasis.title} v{proposal.contentBasis.version}；
                    {proposal.contentBasis.claim.text}
                  </small>
                  {proposal.status === "proposed" && (
                    <div className="cloud-actions">
                      {(["confirm", "reject", "pause"] as const).map((decision) => (
                        <button
                          type="button"
                          key={decision}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await cloudMutation(`${root}/proposals/${proposal.id}/${decision}`, {
                                expected_version: proposal.version,
                              });
                              await refresh(selected.session.id);
                            })
                          }
                        >
                          {decision === "confirm"
                            ? "确认尝试"
                            : decision === "reject"
                              ? "拒绝"
                              : "暂停"}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}
          {!!selected.trials.length && (
            <section className="home-section">
              <h2>尝试与回顾</h2>
              {selected.trials.map((trial) => (
                <article key={trial.id}>
                  <h3>{trial.acceptedAction}</h3>
                  <p>
                    上次记录：{trial.latestExecution ?? "尚未回顾"} ·{" "}
                    {trial.latestOutcome ?? "作用未知"}
                  </p>
                  {!!trial.reviewHistory?.length && (
                    <small>
                      本人回顾已保存为个人来源，可在“我的资料”中核对。
                      {trial.reviewHistory.at(-1)?.related_claim_revision_id &&
                      ["completed", "partly_executed"].includes(trial.latestExecution ?? "")
                        ? "所选的已有认识已标为待复核。"
                        : ""}
                    </small>
                  )}
                  <button
                    type="button"
                    disabled={busy || trial.status === "completed"}
                    onClick={() =>
                      void act(async () => {
                        await cloudMutation(
                          `${root}/trials/${trial.id}/${trial.status === "paused" ? "resume" : "pause"}`,
                          { expected_version: trial.version },
                        );
                        await refresh(selected.session.id);
                      })
                    }
                  >
                    {trial.status === "paused" ? "恢复尝试" : "暂停尝试"}
                  </button>
                  <TrialReviewForm
                    trial={trial}
                    busy={busy}
                    relatedClaims={relatedClaims}
                    onReview={(review) =>
                      void act(async () => {
                        await cloudMutation(`${root}/trials/${trial.id}/review`, review);
                        await refresh(selected.session.id);
                      })
                    }
                  />
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
