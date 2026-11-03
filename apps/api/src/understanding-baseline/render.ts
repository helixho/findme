import type { UnderstandingReport as Report } from "@findme/core";
import type { Assigned } from "./policy.js";
import type { Domain, Selection } from "./prepare.js";
import type { RecoveryProof } from "./recovery.js";
export type TopicResult = {
  domain: Domain;
  status: "ready_candidate" | "partial" | "no_evidence" | "context_required" | "not_selected";
  version: string;
  selection: Selection;
  candidate: Report | null;
  assigned: Assigned[];
  audit: unknown;
  recovery?: RecoveryProof;
};
export const LIMITS = [
  "Editorial domains aggregate original/proposed U1 topics, not ontology classes or personality scores.",
  "Selected originals only; canonical/source diversity does not prove independent events or exhaustive semantic interpretation.",
  "Model candidates/audits are not owner confirmation; project reports do not establish external facts.",
  "Frameworks not run. U3 App and U4 assessment are not delivered by this private staging CLI.",
];
export const DOMAIN_TITLES: Record<Domain, string> = {
  role_direction: "角色、方向与自我理解",
  collaboration: "自主协作与边界",
  judgment_learning: "判断、学习与验证",
  information_systems: "信息组织与工具使用",
  expression_design: "表达、设计与产品取舍",
  resources_tradeoffs: "资源、成本与现实选择",
  daily_conditions: "日常条件与个人偏好",
  unresolved: "待澄清的背景与指代",
};
/** Whole inventory stays local; model receives selected originals, not thousands of omitted IDs. */
export function modelSelection(selection: Selection) {
  const { omitted, ...selected } = selection;
  return {
    ...selected,
    omitted_count: omitted.length,
    omission_reasons: [...new Set(omitted.map((o) => o.reason))],
  };
}
export function reportMarkdown(baseline: {
  status: string;
  overall: Report | null;
  topics: TopicResult[];
  unresolved: unknown[];
  stageReasons?: Record<string, string>;
}) {
  const print = (r: Report) => [
    r.headline,
    "",
    r.current_understanding?.text ?? "当前材料未形成额外综合判断。",
    "",
    ...r.findings.map((f) => `- ${f.text}（范围：${f.scope}；依据：${f.evidence_ids.join(", ")}）`),
    "",
    ...r.resources_conditions_costs.map((f) => `- ${f.text}（依据：${f.evidence_ids.join(", ")}）`),
    "",
    ...r.alternatives.map((a) => `竞争解释：${a}`),
    ...r.unknowns.map((u) => `未知：${u}`),
    ...(r.question ? [`待澄清：${r.question.text}`] : []),
    ...(r.next_step ? [`可选下一步：${r.next_step}`] : []),
  ];
  return [
    "# U2 有范围的个人理解基线",
    "",
    `状态：${baseline.status}；模型候选，未经本人确认。`,
    "",
    ...(baseline.overall ? print(baseline.overall) : ["总览尚不可用。"]),
    "",
    ...baseline.topics.flatMap((t) => [
      `## ${DOMAIN_TITLES[t.domain]}`,
      "",
      `状态：${t.status}；本次选中 ${t.selection.canonical_count} 组原文；其余材料的去向可回查。`,
      "",
      ...(t.status === "ready_candidate" && t.candidate
        ? print(t.candidate)
        : [
            t.status === "context_required"
              ? "这组材料缺少明确的所指对象或语境，保留来源用于后续澄清，不从短确认词推断个人特征。"
              : t.status === "not_selected"
                ? "本次未选择此专题，尚未分析。"
                : t.status === "no_evidence"
                  ? "此专题没有合格的可用原文。"
                  : (baseline.stageReasons?.[t.domain] ??
                    stageReason(baseline.unresolved, t.domain, Boolean(t.candidate))),
          ]),
      "",
    ]),
    "## 使用范围",
    "",
    ...LIMITS.map((l) => `- ${l}`),
    "",
    `未决项目：${baseline.unresolved.length}。详见 unresolved.json。`,
    "",
  ].join("\n");
}
function stageReason(unresolved: unknown[], domain: string, hasCandidate: boolean) {
  const text = JSON.stringify(unresolved);
  // Stage reasons affect only newly rendered Markdown; canonical baseline identity is unchanged.
  const scoped = unresolved.filter(
    (u) =>
      typeof u === "object" &&
      u !== null &&
      ((u as { domain?: string }).domain === domain || (u as { kind?: string }).kind === undefined),
  );
  if (JSON.stringify(scoped).includes("cumulative_call_budget_exhausted"))
    return "调用预算已耗尽，剩余阶段未执行；这不表示原文不足。";
  if (hasCandidate)
    return "已有候选稿，独立审核尚未通过或尚未执行（audit_failed）；不能作为已复核认识。";
  return text
    ? "尚无合格候选稿（candidate_failed 或生成阶段未执行）；具体原因见未决任务。"
    : "候选生成尚未执行。";
}
