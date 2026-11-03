import type { DiagnosticSourceSnapshot, ReportRevision } from "@findme/core";
import type { CaseId } from "./scenarios";

type Question = ReportRevision["questions"][number];
type Proposal = ReportRevision["proposals"][number];
type RevisionScript = {
  scope: string;
  wouldChange: string;
  question: Omit<Question, "id" | "targets">;
  proposal: Omit<Proposal, "id" | "targets" | "status">;
};

// These are explicit synthetic continuations, never a general interpretation of free text.
export const revisionScripts: Record<CaseId, RevisionScript> = {
  zero: {
    scope: "岗位变化与后续成功协调经历；比较具体任务，不按分析/协调二分",
    wouldChange: "若不同任务只要减量就改善，应转向负荷；若成果反馈更能解释差异，修订任务类型假设。",
    question: {
      text: "那次满意的协调，和让人没劲的排会相比，最关键的差别是什么？",
      target_uncertainty: "任务有无可见成果，还是负荷不同",
      why_missing: "新经历已说明协调也能满足，不必重复确认这一点。",
      branches: [
        {
          id: "visible-result",
          sample_answer: "演示：解决了具体问题，能看到结果",
          consequence: "优先比较成果反馈，不再把协调整体排除；负荷仍是竞争解释。",
        },
        {
          id: "manageable-load",
          sample_answer: "演示：那次任务少，没有反复催办",
          consequence: "负荷和安排更值得检验；不能仅凭任务名称判断适配。",
        },
      ],
    },
    proposal: {
      purpose: "比较任务中的成果反馈与负荷",
      step: "在已有工作中区分排会、解决冲突与分析任务，简记结果是否可见及当时负荷；不为验证额外加任务。",
      constraints: "没有调整权限也可观察现有任务；保留已经带来满足的协调。",
      interpretation:
        "相近负荷下可见成果更满足，支持成果反馈线索；各种任务减量都改善，则负荷解释更强。",
      stop: "记录本身增加负担时停止。",
      review: "比较几次现有任务，不由一次满意确认因果或决定辞职。",
    },
  },
  fire: {
    scope: "已给活动与独自修复家具的后续经历；他人回应不再作为必要条件",
    wouldChange: "重复独立活动仍满足会加强掌握/创造线索；只有首次兴奋则更支持新鲜感解释。",
    question: {
      text: "同类独立活动重复几次后，满足感还会留下来吗？",
      target_uncertainty: "持续投入与首次新鲜感如何区分",
      why_missing: "独自修家具已说明他人的看见不是必要条件，但还没有重复体验。",
      branches: [
        {
          id: "lasting",
          sample_answer: "演示：重复做仍然满足",
          consequence: "持续掌握或创造更值得探索；仍不能凭少量体验定义终身使命。",
        },
        {
          id: "novelty",
          sample_answer: "演示：只有第一次很兴奋",
          consequence: "新鲜感解释更强，考虑轮换短项目，不把持续深耕当作必须。",
        },
      ],
    },
    proposal: {
      purpose: "检验独立创造的满足能否持续",
      step: "自愿重复一次相近、可控的独立小项目，比较期待、完成后的感觉与两天后的感受。",
      constraints: "不再重复证明必须有人获益；熟人共同活动仍可以保留。",
      interpretation:
        "重复仍满足支持持续兴趣；仅首次兴奋提示新鲜感。关系可以增加价值，但不是此案例的必要条件。",
      stop: "没有兴趣或成本超过愿投入范围时停止，不承担长期义务。",
      review: "一次重复只提供线索；不把独立满足理解为关系没有价值。",
    },
  },
  rich: {
    scope: "已知可靠交付后仍检查无关细节的合作情境；不推广为全域人格",
    wouldChange: "若能按共同约定减少无关检查且质量不降，支持边界调整；仍难减少时再辨别担忧与习惯。",
    question: {
      text: "减少一项与验收无关的检查时，最担心会发生什么？",
      target_uncertainty: "个人担忧、检查习惯与遗漏的真实风险如何区分",
      why_missing: "后续经历已说明检查没有随可靠性下降；不再重复问会不会减少。",
      branches: [
        {
          id: "unspoken-risk",
          sample_answer: "演示：担心遗漏尚未说清的具体风险",
          consequence: "先核对风险与验收的真实关系；不能用担忧本身证明检查必要。",
        },
        {
          id: "habit",
          sample_answer: "演示：没有具体风险，只是习惯再看一遍",
          consequence: "检查习惯值得检验，可尝试减少一个低风险环节；不据此宣布隐藏动机。",
        },
      ],
    },
    proposal: {
      purpose: "减少一项与验收无关的检查，观察实际代价",
      step: "与可靠合作方选定一个低风险、与验收无关的细节，约定不再额外检查；保留真正的验收与异常上报。",
      constraints: "双方同意，且不省略真实风险控制；不是要求完全放手。",
      interpretation:
        "质量不降且双方负担下降，支持减少无效检查；仍难放下时，继续核对具体担忧或习惯。",
      stop: "出现事先未识别的真实风险时停止并调整边界。",
      review: "一次交付后共同比较质量、返工、检查耗时和对方体验；结果不等于人格评分。",
    },
  },
};

export function followupQuestion(caseId: CaseId, findingVersion: number): Question {
  return {
    id: `${caseId}-q-after-counterexample`,
    targets: [{ finding_id: `${caseId}-f1`, version: findingVersion }],
    ...structuredClone(revisionScripts[caseId].question),
  };
}

export function sampleAnswerSource(
  question: Question,
  branch: Question["branches"][number],
  reportedAt: string,
): DiagnosticSourceSnapshot {
  const id = `${question.id}-${branch.id}`;
  return {
    id,
    version: 1,
    original_text: `虚构案例演示回答：${branch.sample_answer}`,
    occurred_at: "虚构案例后续补问，非用户经历",
    reported_at: reportedAt,
    submitter: "subject",
    content_author: "subject",
    about: "subject",
    expression: "self_report",
    stance: "reported",
    elicitation: question.text,
    reuse: "direct",
    event_group: id,
    availability: "local_snapshot",
  };
}
