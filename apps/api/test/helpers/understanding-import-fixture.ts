import type { UnderstandingImport } from "@findme/core";

export function understandingImportFixture(namespace = "synthetic-dialogue"): UnderstandingImport {
  const sources: UnderstandingImport["sources"] = [
    {
      key: "u1",
      sequence: 0,
      role: "user",
      text: "我希望先做一份能用的小样品。",
      recorded_at: null,
      time_basis: "unknown",
    },
    {
      key: "a1",
      sequence: 1,
      role: "assistant",
      text: "你可能总在准备而回避交付。",
      recorded_at: null,
      time_basis: "unknown",
    },
    {
      key: "u2",
      sequence: 2,
      role: "user",
      text: "这个判断不对，我昨天已经交付了样品。",
      recorded_at: null,
      time_basis: "unknown",
    },
    {
      key: "a2",
      sequence: 3,
      role: "assistant",
      text: "原来的解释缺乏依据，需要收回。",
      recorded_at: null,
      time_basis: "unknown",
    },
    {
      key: "u3",
      sequence: 4,
      role: "user",
      text: "这次修正对我有帮助。",
      recorded_at: null,
      time_basis: "unknown",
    },
  ];
  const ref = (key: string) => {
    const source = sources.find((s) => s.key === key)!;
    return { source_key: key, start: 0, end: source.text.length, quote: source.text };
  };
  const dimensions: UnderstandingImport["insights"][number]["revisions"][number]["dimensions"] = {
    domains: ["work_creation"],
    content_type: "explanation",
    analysis_role: "hypothesis",
    context: { projects: ["虚构样品项目"], roles: [], situations: [] },
    valid_time: { from: null, to: null, precision: "unknown", label: null },
  };
  return {
    format: "findme-understanding-import@1",
    namespace,
    sources,
    insights: [
      {
        key: "explanation",
        kind: "interpretation",
        mode: "interpretation",
        revisions: [
          {
            version: 1,
            status: "withdrawn",
            text: sources[1]!.text,
            scope: "这次虚构项目交流",
            reason: "后续明确反驳",
            origin: ref("a1"),
            dimensions,
            evidence: [{ ...ref("u1"), relation: "contextualizes" }],
            relations: [],
          },
          {
            version: 2,
            status: "candidate",
            text: sources[3]!.text,
            scope: "这次虚构项目交流",
            reason: "保留修正而不宣布新判断已验证",
            origin: ref("a2"),
            dimensions: { ...dimensions, analysis_role: "counterexample" },
            evidence: [{ ...ref("u2"), relation: "challenges" }],
            relations: [{ target_key: "explanation", target_version: 1, kind: "revises" }],
          },
        ],
      },
    ],
    feedback: [
      {
        key: "f1",
        source_key: "u3",
        target: { type: "revision", key: "explanation", version: 2 },
        purpose: "insight_usefulness",
      },
    ],
  };
}
