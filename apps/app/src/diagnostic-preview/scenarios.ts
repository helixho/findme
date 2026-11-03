import { DiagnosticRun } from "@findme/core";
import type { DiagnosticFinding, DiagnosticSourceSnapshot, ReportRevision } from "@findme/core";

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing diagnostic fixture reference");
  return value;
}

export const CASE_IDS = ["zero", "fire", "rich"] as const;
export type CaseId = (typeof CASE_IDS)[number];
const CREATED = "2026-01-01T00:00:00.000Z";
export const METHOD = {
  id: "bounded-conceptualization",
  version: "c1-r0-1",
  protocol_id: "r0-reference-script",
  protocol_version: "1",
  adaptation: "native" as const,
  adaptation_notes: "R0 阅读版的合成脚本；未执行访谈、测验或模型分析。",
  input_complete: false,
  required_evidence_ids: [],
};

function source(
  id: string,
  text: string,
  overrides: Partial<DiagnosticSourceSnapshot> = {},
): DiagnosticSourceSnapshot {
  return {
    id,
    version: 1,
    original_text: text,
    occurred_at: "合成案例所述时段，具体日期未知",
    reported_at: "R0 合成案例初次给定",
    submitter: "subject",
    content_author: "subject",
    about: "subject",
    expression: "self_report",
    stance: "reported",
    elicitation: "当前困惑的合成起步材料",
    reuse: "direct",
    event_group: id,
    availability: "local_snapshot",
    ...overrides,
  };
}
function finding(
  caseId: CaseId,
  n: number,
  title: string,
  text: string,
  scope: string,
  supports: string[],
  challenges: string[],
  contexts: string[],
  alternatives: string[],
  wouldChange: string,
): DiagnosticFinding {
  return {
    id: `${caseId}-f${n}`,
    version: 1,
    priority: n,
    mode: "interpretation",
    status: "candidate",
    title,
    text,
    scope,
    method_id: METHOD.id,
    evidence_sufficiency: "partial",
    framework_grade: null,
    evidence: [
      ...supports.map((id) => ({ evidence_id: `${id}-quote`, relation: "supports" as const })),
      ...challenges.map((id) => ({ evidence_id: `${id}-quote`, relation: "challenges" as const })),
      ...contexts.map((id) => ({
        evidence_id: `${id}-quote`,
        relation: "contextualizes" as const,
      })),
    ],
    required_evidence_ids: supports.map((id) => `${id}-quote`),
    alternatives,
    would_change: wouldChange,
  };
}
export const scenarios = {
  zero: {
    label: "零历史",
    subtitle: "最近工作没劲",
    question: "最近工作没劲，是不是应该辞职？",
    scope: "本轮短输入；近六周工作与周末木工。最多两个补问，不作整体人生判断。",
    headline: "先判断工作内容能否调整，再决定去留。",
    sources: [
      source("Z1", "工作稳定，但近六周没劲。我还没决定要换工作。", { occurred_at: "近六周" }),
      source("Z2", "两个月前，我从独立分析改为大量排会协调。此前喜欢把模糊问题整理成方案。", {
        occurred_at: "两个月前至今",
      }),
      source("Z3", "周末做木工时仍能专心，也有满足感。我不想轻易丢掉稳定收入。", {
        occurred_at: "近期周末",
      }),
      source("Z4", "这轮我最多愿意回答两个问题。其他生活状态还没有说明。", {
        expression: "instruction",
        about: "unknown",
      }),
    ],
    findings: [
      finding(
        "zero",
        1,
        "优先检查任务内容与负荷",
        "没劲与岗位内容变化时间接近，先检查分析、形成方案的机会是否减少。时间接近不证明因果，也不足以断言你不适合协调工作。",
        "当前岗位变化后的工作体验",
        ["Z1", "Z2"],
        [],
        ["Z4"],
        ["协调负荷过大", "权限或成果反馈不足", "岗位适应期"],
        "相近负荷下的分析与协调体验；有成效的协调是否也满足。",
      ),
      finding(
        "zero",
        2,
        "投入能力仍有一个可见出口",
        "木工中的专注与满足，是可用资源，削弱了对一切都没热情的概括；不能替代对其他生活变化的了解。",
        "近期周末木工，不推广到全部生活",
        ["Z3"],
        [],
        ["Z4"],
        ["工作情境的消耗", "未说明的精力变化"],
        "如果工作外也持续失去投入感，需要重新了解范围。",
      ),
      finding(
        "zero",
        3,
        "稳定收入是选择边界",
        "谨慎保留收入不代表不愿成长。木工有满足感也不直接等于应转行；先比较可调整空间，允许暂不改变。",
        "本次去留选择",
        ["Z3"],
        [],
        ["Z1"],
        ["内部任务调整", "逐步比较其他岗位"],
        "调整空间与可承受的收入变化会改变下一步。",
      ),
    ],
    resources: ["仍能投入木工", "能辨认喜欢的分析任务", "稳定收入提供比较空间"],
    constraints: ["只愿投入两个补问", "权限、总负荷与其他生活状态未知"],
    questions: [
      {
        text: "现岗位能否恢复一项分析任务，而不额外增加工作量？",
        uncertainty: "内容匹配还是机会限制",
        missing: "已有材料没有说明调整权限。",
        options: [
          ["room", "可以替换一项现有任务", "先做一次等量替换，比较体验；还不能确认原因。"],
          ["no-room", "没有调整空间", "当前机会受限，先比较内部或其他岗位；不建议硬加任务。"],
        ],
      },
      {
        text: "没劲是否主要局限于工作？",
        uncertainty: "局部工作体验还是更广的精力变化",
        missing: "只有木工这一个工作外例子。",
        options: [
          [
            "work-only",
            "演示：其他活动大致照常",
            "暂把范围保留在工作，仍不证明岗位内容是唯一原因。",
          ],
          ["broader", "演示：其他活动也明显没劲", "木工例外不能代表整体；需要了解更广的精力变化。"],
        ],
      },
    ],
    proposal: {
      purpose: "区分内容匹配与负荷解释",
      step: "若有空间，用一项分析任务替换现有工作，保持总工作量相近。",
      constraints: "不额外加班；需要岗位允许。",
      interpretation: "体验差异支持内容线索；只要减量就改善则转向负荷。一次比较不证明因果。",
      stop: "无调整权限或负担增加就停止。",
      review: "一次任务后回看投入感、疲劳与实际成果；无需决定离职。",
    },
    later: source("Z5", "后来，协调解决了一次真实冲突后，我的满意感很强。", {
      reported_at: "R0 后续合成反例",
      occurred_at: "原初评之后",
    }),
    branchHeadline: "协调也能带来满足：区分任务类型、成果反馈与过载。",
    branchText:
      "这条新经历让把协调整体视为不匹配的解释更弱。真实冲突被解决也带来强满足，应把比较收窄到排会与解决问题的任务类型、成果反馈和负荷；不把满意当作异常。",
  },
  fire: {
    label: "少量经历",
    subtitle: "FIRE 后的方向",
    question: "经济自由后生活无趣，接下来做什么？",
    scope: "停止全职后的六个月与少量活动体验；不定义终身使命。",
    headline: "寻找能留下满足感的参与方式，同时保留自由。",
    sources: [
      source("S1", "停止全职工作六个月了。旅行和购物的兴奋越来越短。", {
        occurred_at: "停止全职后六个月",
      }),
      source("S2", "我喜欢自由安排时间，不愿回到固定全职。"),
      source("S3", "帮朋友修车后，两天过去了，我仍然满足。"),
      source("S4", "一次志愿活动很累，组织也混乱，我不想继续。"),
      source("S5", "我不爱大聚会，但每周和两位老朋友共同活动很自在。"),
      source(
        "S6",
        "我转发了别人的评价：精神贫乏，应该做慈善。我自己只觉得主动参与的观察值得考虑。",
        { content_author: "mixed", expression: "quotation", stance: "not_endorsed" },
      ),
    ],
    findings: [
      finding(
        "fire",
        1,
        "比较满足如何留下来",
        "修车后的持续满足和消费兴奋变短形成线索。掌握感、可见成果、与朋友的具体联系可并存；他人的回应是否必要仍待区分，不能把帮助别人写成唯一意义。",
        "这几次活动及本次方向问题",
        ["S1", "S3"],
        [],
        ["S2"],
        ["亲手解决问题", "可见成果", "与朋友发生具体联系", "新鲜感"],
        "无人看见或获益时，完成一个项目是否仍有满足。",
      ),
      finding(
        "fire",
        2,
        "自在的小范围关系已经是资源",
        "与两位老朋友共同活动自在，不爱大聚会不等于缺少归属。这里有一种可保留的参与方式，不要求扩张社交规模。",
        "已给定的小范围共同活动",
        ["S5"],
        [],
        [],
        ["活动本身的兴趣", "熟悉关系的舒适感"],
        "不同独处和共同活动的体验可能改变关系的重要性。",
      ),
      finding(
        "fire",
        3,
        "一次混乱的志愿体验不定义贡献意愿",
        "疲劳与组织混乱混在一起，不能据此定性不愿贡献，也不要求继续来证明意义。他人的精神贫乏评价不是本人自述或系统核实的事实。",
        "这次志愿体验与转发归属",
        ["S4"],
        [],
        ["S6", "S2"],
        ["组织条件不适合", "活动负担不适合"],
        "更可控的活动体验会改变判断；可以不做公益。",
      ),
    ],
    resources: ["自主安排时间", "亲手解决问题的体验", "自在的小范围共同活动"],
    constraints: ["不愿回固定全职", "样本少；兴趣、顺序与新鲜感可能混杂"],
    questions: [
      {
        text: "修车的哪一部分，即使没有朋友看见也值得做？",
        uncertainty: "掌握、成果与关系分别起什么作用",
        missing: "现有修车同时包含解决问题与朋友联系。",
        options: [
          [
            "independent",
            "演示：解决问题本身就值得",
            "独自完成的对照更值得尝试；他人回应可能不是必要条件。",
          ],
          ["together", "演示：一起做才有吸引力", "关系线索更值得检验；不等于必须被需要或做慈善。"],
        ],
      },
    ],
    proposal: {
      purpose: "比较掌握、创造与关系线索",
      step: "选一个自己可掌控、成果可见的小项目；可以独自做，也不必公益或职业化。",
      constraints: "保留自由安排，不承担长期义务。",
      interpretation: "独做也满足支持掌握/创造；仅共同做满足提示关系；都只有首次兴奋则检查新鲜感。",
      stop: "负担超过愿投入的时间，或已经没有兴趣，就停止。",
      review: "做完与两天后各记录一次感受；只形成线索，不宣布人生定位。",
    },
    later: source("S7", "后来，我独自修好了家具，无人看见或获益，仍然满足了好几天。", {
      reported_at: "R0 后续合成反例",
      occurred_at: "原初评之后",
    }),
    branchHeadline: "独自创造也能留下满足：他人的认可不是必要条件。",
    branchText:
      "这条后续经历提供无人看见或获益的满足体验，削弱必须被他人需要或认可的解释。掌握与创造现在有更直接的线索，关系仍是可选资源；一次家具修复仍不能宣布稳定人生定位。",
  },
  rich: {
    label: "丰富历史",
    subtitle: "工作授权与质量",
    question: "高标准还是过度控制？也想看生活各领域的联系。",
    scope: "多月工作片段、少量非工作反例与部分生活自述；同项目不重复计算成独立事件。",
    headline: "先把质量责任变成可授权的协作边界。",
    sources: [
      source("H1", "这个项目此前确有交付失败，我纠正了失真的引用。", {
        event_group: "work-project",
        reuse: "historical",
      }),
      source("H2", "同一项目里，我重复要求提供真正可用的文件。", {
        event_group: "work-project",
        expression: "instruction",
        reuse: "historical",
      }),
      source("H3", "我让同事自己选方法，自己负最终责任并验收。", {
        event_group: "work-project",
        reuse: "historical",
      }),
      source(
        "H4",
        "客户转发材料要求控制每一步。我说明：这段是客户要求，不代表我同意这种管理方式。",
        {
          content_author: "mixed",
          expression: "quotation",
          stance: "not_endorsed",
          reuse: "historical",
        },
      ),
      source("H5", "骑行时，我喜欢让朋友临时决定路线。", { reuse: "historical" }),
      source("H6", "低成本试验失败后，我接受结果并转向。", { reuse: "historical" }),
      source("H7", "明确交接后，两周里我没有查中间过程，验收也满意。", {
        reuse: "historical",
        occurred_at: "一次明确交接后的两周",
      }),
      source("H8", "两晚临时加班后精力差，此前睡眠规律。", {
        reuse: "historical",
        occurred_at: "两晚临时加班之后",
      }),
      source("H9", "我固定运动，伴侣关系满意。", { reuse: "historical" }),
      source("H10", "一位同事说我控制欲强。我说自己只想把风险说清楚。", {
        content_author: "mixed",
        expression: "third_party_evaluation",
        reuse: "historical",
      }),
      source("H11", "新合作方还没有稳定交付记录时，我仍会频繁检查。", { reuse: "historical" }),
      source("H12", "这些材料含多日期记录和重复摘要；它们不自动代表多个独立事件。", {
        content_author: "unknown",
        about: "unknown",
        expression: "summary",
        reuse: "historical",
      }),
    ],
    findings: [
      finding(
        "rich",
        1,
        "风险把关是优先候选，尚非唯一解释",
        "交付可信度不足时检查更多，明确边界后曾不查过程。情境中的风险把关比任何时候都不能放手更值得检验；目的合理仍可能有互动成本。",
        "所述工作授权与质量情境",
        ["H1", "H3", "H7", "H11"],
        [],
        ["H2", "H12", "H10"],
        ["检查习惯", "验收边界不清", "个人担忧"],
        "可靠合作方持续合格后仍查无关细节，会削弱风险单一解释。",
      ),
      finding(
        "rich",
        2,
        "保留授权能力，也正视一位同事的体验",
        "能接受小实验失败，也能在骑行中不做计划，是资源而非否定同事体验的许可证。只知道一位同事的评价，不能写成所有人都这么看；H4 是不背书，不等于明确反对。",
        "给定的非工作反例、同事评价与客户引文",
        ["H5", "H6"],
        [],
        ["H4", "H10"],
        ["临时加码或检查频率带来成本", "独立决定边界不清"],
        "需要还原那一次具体互动和对方体验。",
      ),
      finding(
        "rich",
        3,
        "工作负担可能外溢，其他领域仅部分可见",
        "短期加班与精力差提供跨领域线索。规律运动和关系满意是正向自述，但不能证明全无问题；工作材料多也不表示身体或关系发展低。",
        "短期加班与部分生活自述，不作全域评级",
        ["H8", "H9"],
        [],
        [],
        ["短期安排的代价", "尚未说明的其他生活变化"],
        "只有持续观察到跨领域变化，才更支持外溢模式。",
      ),
    ],
    resources: [
      "发现事实错误",
      "曾明确交接并不查过程",
      "接受低成本试验失败",
      "部分运动与关系正向自述",
    ],
    constraints: ["工作材料偏多；同项目片段并非独立验证", "客户引文与同事评价不当作本人立场"],
    questions: [
      {
        text: "可靠合作方连续合格交付后，会减少检查吗？",
        uncertainty: "外部风险与检查习惯如何区分",
        missing: "原材料还没有连续可靠交付后的检查记录。",
        options: [
          ["reduce", "演示：会减少到约定节点", "更支持情境条件解释；仍要看对方体验与实际代价。"],
          [
            "continue",
            "演示：仍查无关验收的细节",
            "风险不能单独解释，需辨别担忧与习惯；不自动诊断控制欲。",
          ],
        ],
      },
    ],
    proposal: {
      purpose: "检验协作边界能否减少无效检查",
      step: "选低风险任务，共同约定验收、异常上报与检查节点；节点间不临时加码。",
      constraints: "只在双方愿意且风险低时尝试。",
      interpretation: "同时看交付、返工、耗时与对方体验；可靠后仍查无关细节就重新检验解释。",
      stop: "出现实际风险、返工扩大或对方负担增加时调整或停止。",
      review: "一次交付后共同回看；不把合格交付等同于互动没有成本。",
    },
    later: source("H13", "后来，新合作方连续三次合格交付，我仍反复检查与验收无关的细节。", {
      reported_at: "R0 后续合成反例",
      occurred_at: "原初评之后",
    }),
    branchHeadline: "可靠交付后仍查无关细节，风险已不足以解释全部检查。",
    branchText:
      "这条新经历削弱完全由合作方不可靠导致检查的解释，也指出与验收无关的检查不成比例。现在需要了解这些检查在保护什么，比较担忧、习惯或竞争承诺；不能据此给普遍控制欲定性。",
  },
} satisfies Record<CaseId, unknown>;

export function appendSource(run: DiagnosticRun, s: DiagnosticSourceSnapshot) {
  if (run.sources.some((x) => x.id === s.id)) return;
  run.sources.push(s);
  run.assessments.push({
    source_id: s.id,
    source_version: 1,
    version: 1,
    eligibility:
      ["instruction", "quotation", "summary"].includes(s.expression) || s.content_author === "mixed"
        ? "context_only"
        : "eligible",
    correction: "initial",
    note: "合成脚本来源，非用户新确认。",
    effective_at: CREATED,
  });
  run.evidence.push({
    id: `${s.id}-quote`,
    source_id: s.id,
    source_version: 1,
    start: 0,
    end: s.original_text.length,
    quote: s.original_text,
  });
}
export function createRun(caseId: CaseId): DiagnosticRun {
  const c = scenarios[caseId];
  const findings = structuredClone(c.findings);
  const target = (n = 0) => [{ finding_id: required(findings[n]).id, version: 1 }];
  const report: ReportRevision = {
    id: `${caseId}-report-1`,
    run_id: `${caseId}-run`,
    version: 1,
    previous_report_id: null,
    created_at: CREATED,
    reason: "R0 合成阅读版初评，脚本展示。",
    status: "candidate",
    question: c.question,
    summary: { text: c.headline, status: "candidate", targets: target() },
    coverage_scope: c.scope,
    coverage:
      caseId === "rich"
        ? [
            {
              area: "工作与协作",
              coverage: "observed",
              note: "材料较多，含同源片段",
              evidence_ids: ["H1-quote", "H3-quote", "H7-quote"],
            },
            {
              area: "身体与精力",
              coverage: "partial",
              note: "运动、睡眠与短期加班自述",
              evidence_ids: ["H8-quote", "H9-quote"],
            },
            {
              area: "关系",
              coverage: "partial",
              note: "伴侣与一位同事的有限线索",
              evidence_ids: ["H9-quote"],
            },
            {
              area: "生活方向",
              coverage: "unknown",
              note: "没有足够材料；不评级",
              evidence_ids: [],
            },
          ]
        : [],
    source_refs: c.sources.map((s) => ({ source_id: s.id, version: 1, assessment_version: 1 })),
    findings,
    resources: c.resources.map((text, i) => ({
      text,
      status: "available",
      evidence_ids: required(
        (caseId === "zero"
          ? [["Z3"], ["Z2"], ["Z3"]]
          : caseId === "fire"
            ? [["S2"], ["S3"], ["S5"]]
            : [["H1"], ["H7"], ["H6"], ["H9"]])[i],
      ).map((id) => `${id}-quote`),
    })),
    constraints: c.constraints,
    questions: c.questions.map((q, i) => ({
      id: `${caseId}-q${i + 1}`,
      targets: target(i),
      text: q.text,
      target_uncertainty: q.uncertainty,
      why_missing: q.missing,
      branches: q.options.map(([id, sample_answer, consequence]) => ({
        id: required(id),
        sample_answer: required(sample_answer),
        consequence: required(consequence),
      })),
    })),
    proposals: [
      { id: `${caseId}-experiment`, targets: target(), status: "offered", ...c.proposal },
    ],
  };
  const run: DiagnosticRun = {
    id: `${caseId}-run`,
    version: 1,
    subject_kind: "synthetic",
    method: METHOD,
    sources: [],
    assessments: [],
    evidence: [],
    reports: [report],
    current_report_id: report.id,
    feedback: [],
  };
  for (const s of c.sources) appendSource(run, s);
  return DiagnosticRun.parse(run);
}
