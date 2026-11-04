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

type V2 = Extract<UnderstandingImport, { format: "findme-understanding-import@2" }>;

/** Synthetic dialogue for the experience-group and answer-binding contract (no real content). */
export function understandingImportV2Fixture(namespace = "synthetic-dialogue-v2"): V2 {
  const text = {
    u1: "我家里买了一台跑步机，一年用了不到十次。",
    a1: "你当初买它时，更接近哪种情况？\n\nA. 已经有运动习惯。\nB. 希望买了以后能坚持锻炼。\nC. 价格合适就买了。",
    u2: "b",
    a2: "再核对一句：“拿到东西以后，我会安心一些。”\n\nA. 很像。\nB. 有一点。\nC. 不像。",
    u3: "a。我还打算买一套新显示器，不过还没决定。",
    u4: "现在它只用来挂衣服。",
    u5: "我今天重新开始每周跑步。",
    u6: "我去年报了一个网课，没学完。",
  };
  const sources: V2["sources"] = Object.entries(text).map(([key, value], sequence) => ({
    key,
    sequence,
    role: key.startsWith("a") ? "assistant" : "user",
    text: value,
    recorded_at: null,
    time_basis: "unknown",
  }));
  const at = (source_key: keyof typeof text, quote: string) => {
    const start = text[source_key].indexOf(quote);
    if (start < 0) throw new Error("FIXTURE_FRAGMENT_MISSING");
    return { source_key, start, end: start + quote.length, quote };
  };
  const whole = (key: keyof typeof text) => at(key, text[key]);
  const dimensions: V2["insights"][number]["revisions"][number]["dimensions"] = {
    domains: ["conditions_resources"],
    content_type: "background",
    analysis_role: "observation",
    context: { projects: [], roles: [], situations: [] },
    valid_time: { from: null, to: null, precision: "unknown", label: null },
  };
  const self = (
    key: string,
    ref: ReturnType<typeof at>,
    experience_key?: string,
  ): V2["insights"][number] => {
    const marked = experience_key ? { ...ref, experience_key } : ref;
    return {
      key,
      kind: "background",
      mode: "self_report",
      revisions: [
        {
          version: 1,
          status: "candidate",
          text: ref.quote,
          scope: "合成对话中的本人陈述",
          reason: "保留原话",
          origin: marked,
          dimensions,
          evidence: [{ ...marked, relation: "supports" }],
          relations: [],
        },
      ],
    };
  };
  const goalQuestion = at("a1", "你当初买它时，更接近哪种情况？");
  const goalOptions = [
    { label: "A", ...at("a1", "已经有运动习惯。") },
    { label: "B", ...at("a1", "希望买了以后能坚持锻炼。") },
    { label: "C", ...at("a1", "价格合适就买了。") },
  ].map(({ label, start, end, quote }) => ({ label, text: quote, start, end }));
  const goalAnswer = at("u2", "b");
  const treadmill = "exp.treadmill";
  const proposition = at("a2", "拿到东西以后，我会安心一些。");
  const optionB = goalOptions[1]!;
  return {
    format: "findme-understanding-import@2",
    namespace,
    sources,
    experiences: [
      {
        key: treadmill,
        label: "家里的跑步机：购买、使用与闲置",
        nature: "occurred",
        valid_time: { from: null, to: null, precision: "approximate", label: "约一年（本人估计）" },
      },
      {
        key: "exp.monitor_plan",
        label: "考虑购买新显示器",
        nature: "hypothetical",
        valid_time: { from: null, to: null, precision: "unknown", label: null },
      },
    ],
    insights: [
      self("u.treadmill_usage", whole("u1"), treadmill),
      self("u.treadmill_hanging", whole("u4"), treadmill),
      {
        key: "q.treadmill_goal.B",
        kind: "background",
        mode: "self_report",
        revisions: [
          {
            version: 1,
            status: "candidate",
            text: "被问到“你当初买它时，更接近哪种情况？”时，选了 B：希望买了以后能坚持锻炼（派生概括，非原话）。",
            scope: "仅对应这道选择题；选项由助手提出",
            reason: "选择题回答保留问题、全部选项与所选项",
            origin: { ...goalAnswer, experience_key: treadmill },
            dimensions,
            evidence: [
              { ...goalAnswer, experience_key: treadmill, relation: "supports" },
              { ...goalQuestion, experience_key: treadmill, relation: "contextualizes" },
              {
                source_key: "a1",
                start: optionB.start,
                end: optionB.end,
                quote: optionB.text,
                experience_key: treadmill,
                relation: "contextualizes",
              },
            ],
            relations: [],
            answer_binding: {
              relation: "elicited_by",
              text_basis: "derived_summary",
              question: goalQuestion,
              options: goalOptions,
              selected: ["B"],
              claim_label: "B",
              answer: goalAnswer,
            },
          },
        ],
      },
      {
        key: "a.relief_check",
        kind: "interpretation",
        mode: "interpretation",
        revisions: [
          {
            version: 1,
            status: "candidate",
            text: proposition.quote,
            scope: "助手提出的核对命题",
            reason: "本人回答“很像”以反馈保存，不建成本人自述",
            origin: proposition,
            dimensions: { ...dimensions, analysis_role: "hypothesis" },
            evidence: [],
            relations: [],
          },
        ],
      },
      self(
        "u.monitor_plan",
        at("u3", "我还打算买一套新显示器，不过还没决定。"),
        "exp.monitor_plan",
      ),
      self("u.running", whole("u5")),
      self("u.course", whole("u6")),
    ],
    feedback: [
      {
        key: "fb.relief_check",
        source_key: "u3",
        target: { type: "revision", key: "a.relief_check", version: 1 },
        purpose: "fact_agreement",
      },
    ],
  };
}
