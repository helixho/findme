import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { type FreezeManifest, type RawSession, selectSessions } from "../src/dogfood/freeze.js";
import {
  L1Draft,
  L3Draft,
  checkL1,
  checkL3,
  coalesceEvidence,
  expandL1,
  groundedL3Schema,
  l1Transport,
  makePackets,
  normalizeL1,
  segmentSources,
} from "../src/dogfood/layers.js";
function fixture() {
  const raw: RawSession[] = [
    {
      id: "a",
      sourceUuid: null,
      rootId: null,
      time: "2026-01-01",
      project: "project",
      messages: [
        { id: "context", role: "assistant", text: "这是他人的观点背景", time: null },
        {
          id: "user",
          role: "user",
          text: "引用：别人说必须努力。我更重视休息。",
          time: "2026-01-01",
        },
        { id: "runtime", role: "system", text: "system task", time: null },
      ],
      fingerprint: "",
      groupId: "",
      selectionReasons: [],
    },
  ];
  const selected = selectSessions(raw, 1, 0, "test");
  const manifest: FreezeManifest = {
    format: "findme-av-dogfood-v0.1",
    id: "synthetic",
    createdAt: "2026-01-01",
    sourceFingerprint: "source",
    seed: "test",
    requestedSessions: 1,
    requestedHoldout: 0,
    sessions: selected.sessions,
    independence: "unknown",
    holdoutValidation: "pending",
  };
  return { raw: selected.raw, manifest };
}
describe("full AV layers", () => {
  it("segments only user text and preserves complete Unicode source ranges", () => {
    const { raw, manifest } = fixture();
    const segments = segmentSources(raw, manifest, 10);
    expect(segments.map((s) => s.text).join("")).toBe(raw[0]?.messages[1]?.text);
    expect(segments[0]?.context?.role).toBe("assistant");
    expect(segments.every((s) => s.messageId === "user")).toBe(true);
    const user = raw[0]?.messages[1];
    if (!user) throw new Error();
    user.text = "🙂🙂🙂🙂🙂🙂";
    expect(
      segmentSources(raw, manifest, 5)
        .map((s) => s.text)
        .join(""),
    ).toBe(user.text);
  });
  it("reuses only identical text/context/day/project within the same split", () => {
    const { raw, manifest } = fixture();
    const segments = segmentSources(raw, manifest);
    const first = segments[0];
    if (!first) throw new Error();
    const plan = makePackets([
      first,
      { ...first, id: "alias", sessionId: "other" },
      { ...first, id: "heldout", split: "holdout" },
      { ...first, id: "different-context", context: null },
    ]);
    expect(plan.representatives).toHaveLength(3);
    expect(plan.aliases[first.id]).toHaveLength(2);
    expect(plan.packets.every((p) => p.segments.every((s) => s.split === p.split))).toBe(true);
  });
  it("checks every segment is classified and every quote is exact, not assistant content", () => {
    const { raw, manifest } = fixture();
    const { packets, aliases } = makePackets(segmentSources(raw, manifest));
    const packet = packets[0];
    const key = packet?.segments[0]?.id;
    if (!packet || !key) throw new Error();
    const draft = L1Draft.parse({
      coverage: [{ key, author: "mixed", disposition: "personal_evidence", note: "混合作者" }],
      evidence: [
        {
          key,
          quote: "我更重视休息。",
          author: "subject",
          about: "self",
          kind: "evaluation",
          facet: "rest",
          stance: "明确重视",
          statement: "用户表达重视休息",
          scope: "本次讨论",
        },
      ],
    });
    expect(checkL1(packet, draft)).toEqual(draft);
    const evidence = expandL1(packet, draft, aliases);
    expect(evidence[0]?.quote).toBe("我更重视休息。");
    expect(evidence[0]?.eligible).toBe(true);
    expect(evidence[0]?.status).toBe("candidate");
    expect(() => checkL1(packet, { ...draft, coverage: [] })).toThrow("COVERAGE");
    expect(() =>
      checkL1(packet, {
        ...draft,
        evidence: [
          {
            ...(draft.evidence[0] as z.infer<typeof L1Draft>["evidence"][number]),
            quote: "这是他人的观点背景",
          },
        ],
      }),
    ).toThrow("QUOTE");
    expect(() => checkL1(packet, { ...draft, evidence: [] })).toThrow("UNSUPPORTED");
  });
  it("does not promote task requirements or pasted claims into L1 personal support", () => {
    const { raw, manifest } = fixture();
    const { packets, aliases } = makePackets(segmentSources(raw, manifest));
    const packet = packets[0];
    const key = packet?.segments[0]?.id;
    if (!packet || !key) throw new Error();
    const draft = L1Draft.parse({
      coverage: [{ key, author: "third_party", disposition: "context_only", note: "引用" }],
      evidence: [
        {
          key,
          quote: "别人说必须努力。",
          author: "third_party",
          about: "third_party",
          kind: "quotation",
          facet: "other",
          stance: "未知",
          statement: "他人观点",
          scope: "引用背景",
        },
      ],
    });
    expect(expandL1(packet, draft, aliases)[0]?.eligible).toBe(false);
  });
  it("requires a keyed coverage entry for every source at the transport boundary", () => {
    const { raw, manifest } = fixture();
    const packet = makePackets(segmentSources(raw, manifest)).packets[0];
    if (!packet) throw new Error("fixture packet missing");
    const segment = packet.segments[0];
    if (!segment) throw new Error("fixture segment missing");
    const schema = l1Transport(packet);
    expect(schema.safeParse({ coverage: {}, evidence: [] }).success).toBe(false);
    const parsed = schema.parse({
      coverage: {
        [segment.id]: { author: "unknown", disposition: "uncertain", note: "归属待核验" },
      },
      evidence: [],
    });
    expect(parsed.coverage[0]?.key).toBe(segment.id);
    expect(checkL1(packet, parsed).coverage).toHaveLength(1);
  });
  it("quarantines ungrounded candidates and downgrades unsupported classifications without weakening the strict validator", () => {
    const { raw, manifest } = fixture();
    const packet = makePackets(segmentSources(raw, manifest)).packets[0];
    const key = packet?.segments[0]?.id;
    if (!packet || !key) throw new Error("fixture missing");
    const draft = L1Draft.parse({
      coverage: [
        { key, author: "subject", disposition: "personal_evidence", note: "模型初步分类" },
      ],
      evidence: [
        {
          key,
          quote: "不存在的用户原话",
          author: "subject",
          about: "self",
          kind: "self_report",
          facet: "other",
          stance: "未核验",
          statement: "不能保留",
          scope: "未知",
        },
      ],
    });
    expect(() => checkL1(packet, draft)).toThrow("QUOTE");
    const normalized = normalizeL1(packet, draft);
    expect(normalized.evidence).toEqual([]);
    expect(normalized.coverage[0]?.disposition).toBe("uncertain");
    expect(normalized.coverage[0]?.note).toContain("校验降级");
    expect(draft.evidence).toHaveLength(1);
    expect(draft.coverage[0]?.disposition).toBe("personal_evidence");
    expect(() => normalizeL1(packet, { ...draft, coverage: [] })).toThrow("COVERAGE");
  });
  it("rechecks each reuse alias rather than inheriting unchecked source attribution", () => {
    const { raw, manifest } = fixture();
    const plan = makePackets(segmentSources(raw, manifest));
    const packet = plan.packets[0];
    const source = packet?.segments[0];
    if (!packet || !source) throw new Error("fixture missing");
    const draft = L1Draft.parse({
      coverage: [
        { key: source.id, author: "subject", disposition: "personal_evidence", note: "明确评价" },
      ],
      evidence: [
        {
          key: source.id,
          quote: "我更重视休息。",
          author: "subject",
          about: "self",
          kind: "evaluation",
          facet: "rest",
          stance: "明确",
          statement: "重视休息",
          scope: "当前",
        },
      ],
    });
    expect(() =>
      expandL1(packet, draft, { [source.id]: [{ ...source, text: "引用不匹配" }] }),
    ).toThrow("ALIAS_CONTEXT");
    expect(() =>
      expandL1(packet, draft, { [source.id]: [{ ...source, split: "holdout" }] }),
    ).toThrow("ALIAS_CONTEXT");
    expect(expandL1(packet, draft, plan.aliases)[0]?.quote).toBe("我更重视休息。");
  });
  it("limits generated L3 citations to explicit eligible IDs before semantic validation", () => {
    const schema = groundedL3Schema(new Set(["valid"]), true);
    const draft = {
      overview: "有限观察",
      claims: [
        {
          text: "观察",
          scope: "特定情境",
          kind: "observation",
          evidence_ids: ["valid"],
          counterevidence_ids: [],
          alternatives: [],
          uncertainty: "未确认",
          verification_question: null,
        },
      ],
      unknowns: [],
      data_limits: [],
    };
    expect(schema.safeParse(draft).success).toBe(true);
    expect(
      schema.safeParse({
        ...draft,
        claims: draft.claims.map((claim) => ({ ...claim, evidence_ids: ["context-only"] })),
      }).success,
    ).toBe(false);
    expect(() => groundedL3Schema(new Set())).toThrow("EMPTY_ALLOWED");
  });
  it("merges same-source IDs and makes conflicting model classifications ineligible while preserving both variants", () => {
    const { raw, manifest } = fixture();
    const plan = makePackets(segmentSources(raw, manifest));
    const packet = plan.packets[0];
    const source = packet?.segments[0];
    if (!packet || !source) throw new Error("fixture missing");
    const draft = L1Draft.parse({
      coverage: [
        { key: source.id, author: "subject", disposition: "personal_evidence", note: "评价" },
      ],
      evidence: [
        {
          key: source.id,
          quote: "我更重视休息。",
          author: "subject",
          about: "self",
          kind: "evaluation",
          facet: "rest",
          stance: "明确",
          statement: "重视休息",
          scope: "当前",
        },
      ],
    });
    const atom = expandL1(packet, draft, plan.aliases)[0];
    if (!atom) throw new Error("fixture atom missing");
    const conflict = coalesceEvidence([
      atom,
      { ...atom, kind: "work_requirement", eligible: false, facet: "instruction" },
    ]);
    expect(conflict.evidence).toHaveLength(1);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.evidence[0]?.eligible).toBe(false);
    expect(conflict.evidence[0]?.kind).toBe("unknown");
    expect(conflict.evidence[0]?.interpretationVariants).toHaveLength(2);
    expect(conflict.evidence[0]?.quote).toBe(atom.quote);
    const identical = coalesceEvidence([atom, { ...atom }]);
    expect(identical.conflicts).toEqual([]);
    expect(identical.evidence[0]?.eligible).toBe(true);
    expect(() => coalesceEvidence([atom, { ...atom, quote: "different" }])).toThrow("ID_COLLISION");
  });
  it("L3 rejects references not supplied as eligible and permits honest empty output", () => {
    const empty = L3Draft.parse({
      overview: "材料不足",
      claims: [],
      unknowns: ["未知"],
      data_limits: ["工作语料"],
    });
    expect(checkL3(empty, new Set())).toEqual(empty);
    const bad = L3Draft.parse({
      ...empty,
      claims: [
        {
          text: "有限观察",
          scope: "工作",
          kind: "observation",
          evidence_ids: ["outside"],
          counterevidence_ids: [],
          alternatives: [],
          uncertainty: "未知",
          verification_question: null,
        },
      ],
    });
    expect(() => checkL3(bad, new Set(["valid"]))).toThrow("NOT_ELIGIBLE");
  });
});
