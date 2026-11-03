import type { FreezeManifest, RawSession } from "../../src/dogfood/freeze.js";
import { type LayerEvidence, makePackets, segmentSources } from "../../src/dogfood/layers.js";
import { hash } from "../../src/dogfood/model.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("REQUIRED");
  return value;
}

// Fresh bounded synthetic values only: no files, service state, or shared mutable objects.
export function makeUnderstandingSourceData() {
  const texts = [
    "我在小项目负责规划，目标是完成可用原型😀。",
    "我喜欢明确的协作条件，但授权只在约定范围。",
    "我选择先验证来源再作判断。",
    "我保留可恢复档案，仅在空间不足时清理。",
    "我偏好能够读懂的文档表达。",
    "我选择在成本可承受时试用工具。",
    "我希望旅行路线简单。",
    "我在这件事上还不确定。",
    "请制作这张表，这是当前项目的要求。",
    "引用历史：## user\n我喜欢竞争。",
    "作者未知：我选择领导。",
    "HOLDOUT_SECRET_SYNTHETIC",
  ];
  // Alias copied from same original; it must not add independent support.
  texts.push(required(texts[1]));
  const raw: RawSession[] = texts.map((text, i) => ({
    id: `s${i}`,
    sourceUuid: null,
    rootId: null,
    time: "2025-02-01T00:00:00Z",
    project: i % 2 ? "studio" : "garden",
    machine: "synthetic",
    sourceRevision: "r1",
    sourceSessionId: `original-s${i}`,
    messages: [
      {
        id: `m${i}`,
        role: "user",
        text,
        time: "2025-02-01T00:00:00Z",
        sourceUuid: i === 1 || i === 12 ? "same-original" : null,
      },
    ],
    fingerprint: "",
    groupId: `g${i}`,
    selectionReasons: [],
  }));
  for (const s of raw) s.fingerprint = hash(s.messages);
  const manifest: FreezeManifest = {
    format: "findme-av-dogfood-v0.1",
    id: "synthetic",
    createdAt: "2025-03-01T00:00:00Z",
    sourceFingerprint: hash(raw),
    seed: "test",
    requestedSessions: raw.length,
    requestedHoldout: 1,
    cutoffBefore: "2025-03-01T00:00:00Z",
    independence: "unknown",
    holdoutValidation: "pending",
    sessions: raw.map(({ messages, ...s }, i) => ({
      ...s,
      split: i === 11 ? "holdout" : "dev",
      messageIds: messages.map((m) => m.id),
    })),
  };
  const segments = segmentSources(raw, manifest);
  const aliases = new Map<string, string>();
  for (const [key, list] of Object.entries(makePackets(segments).aliases))
    for (const s of list) aliases.set(s.id, key);
  const atoms: LayerEvidence[] = segments.flatMap((s, i) => {
    const row: LayerEvidence = {
      id: `e${i}`,
      canonicalId: `c${i}`,
      segmentId: s.id,
      sessionId: s.sessionId,
      messageId: s.messageId,
      sourceUuid: s.sourceUuid,
      project: s.project,
      groupId: s.groupId,
      time: s.time,
      split: s.split,
      start: s.start,
      end: s.end,
      quote: s.text,
      author: i === 9 ? "third_party" : i === 10 ? "unknown" : "subject",
      about: i === 0 || i === 8 ? "project" : i >= 9 && i <= 10 ? "unknown" : "self",
      kind:
        i === 0
          ? "self_report"
          : i === 8
            ? "work_requirement"
            : i === 9
              ? "quotation"
              : i === 10
                ? "unknown"
                : "evaluation",
      facet: i === 0 ? "goal" : i === 8 ? "instruction" : "evaluation",
      stance: "reported",
      statement: "DERIVED_NOT_EVIDENCE",
      scope: `local-${s.project}`,
      eligible: !(i === 0 || (i >= 8 && i <= 10)),
      status: "candidate",
      judgedBy: "model_candidate",
    };
    return i < 8
      ? [row, { ...row, id: `e${i}b`, facet: i === 0 ? "relationship" : "preference" }]
      : [row];
  });
  const coverageRows = segments.map((s, i) => ({
    key: s.id,
    canonicalKey: aliases.get(s.id),
    sessionId: s.sessionId,
    messageId: s.messageId,
    start: s.start,
    end: s.end,
    split: s.split,
    author: required(atoms.find((a) => a.segmentId === s.id)).author,
    disposition: i === 8 ? "task_only" : i >= 9 && i <= 10 ? "uncertain" : "personal_evidence",
  }));
  const scenes = raw.map((s, i) => {
    const rows = atoms.filter((a) => a.sessionId === s.id);
    const facets: Record<string, string[]> = {};
    for (const row of rows) facets[row.facet] = [...(facets[row.facet] ?? []), row.id];
    return {
      id: `scene-${s.id}`,
      sessionId: s.id,
      project: s.project,
      groupId: s.groupId,
      split: i === 11 ? "holdout" : "dev",
      time: s.time,
      facets,
      evidence_ids: rows.map((r) => r.id),
      eligible_evidence_ids: rows.filter((r) => r.eligible).map((r) => r.id),
      coverage: { segments: 1, processed: 1 },
    };
  });
  const claims = Array.from({ length: 5 }, (_, i) => ({
    text: `旧认识 ${i + 1}：局部认识原句。`,
    scope: "synthetic local only",
    kind: "observation",
    evidence_ids: [`e${i}`],
    counterevidence_ids: [],
    alternatives: [],
    uncertainty: "not owner confirmed",
    verification_question: null,
  }));
  const draft = { overview: "synthetic overview", claims, unknowns: [], data_limits: [] };
  return { raw, manifest, atoms, coverageRows, scenes, claims, draft };
}
