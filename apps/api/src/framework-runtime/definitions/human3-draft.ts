import { defineFramework } from "../definition.js";

/** Internal Chinese paraphrase from coordinator's R01/R02 source review, not the full prompt. */
export const human3Draft = defineFramework({
  key: "human3",
  version: "internal-zh-draft-20261006",
  title: "HUMAN 3.0 · 中文转述适配草稿",
  creator: "Dan Koe（来源框架）／FindMe（内部适配）",
  publication_status: "draft",
  usage_status: "review_required",
  efficacy: "unverified",
  source_status: "协调者于 2026-10-06 直接读取 R01/R02；此实现依据其事实摘要，未验证协议等价性。",
  source_refs: [
    {
      id: "R01",
      url: "https://letters.thedankoe.com/p/prompt-human-30-self-discovery-and",
      attribution: "Dan Koe · HUMAN 3.0 自我发现访谈来源",
    },
    {
      id: "R02",
      url: "https://thedankoe.com/letters/a-complete-knowledge-base-of-human-3-0/",
      attribution: "Dan Koe · HUMAN 3.0 知识库来源",
    },
  ],
  disclaimer:
    "本版本是中文转述与内部适配，不是获许可的完整官方 prompt；协议等价性、内容使用和效用仍需复核。结果只是框架视角，不是心理测评或原生个人事实。",
  adaptation: {
    language: "中文转述",
    equivalence: "unverified",
    history_mode: "direct_interview_only",
  },
  domains: [
    {
      key: "mind",
      title: "Mind · 思维",
      intro_question:
        "最近一次你改变重要看法是什么？请描述发生的情境、你实际做了什么，以及变化后的影响。",
    },
    {
      key: "body",
      title: "Body · 身体",
      intro_question: "最近一周你怎样照顾身体、休息和恢复？请讲一个实际例子及其限制。",
    },
    {
      key: "spirit",
      title: "Spirit · 关系与意义",
      intro_question: "最近一次你感到连接、归属或意义的经历是什么？当时你具体做了什么？",
    },
    {
      key: "vocation",
      title: "Vocation · 工作与贡献",
      intro_question: "最近一次你通过工作或创作产生贡献的经历是什么？请描述具体实践、结果和代价。",
    },
  ].map((d) => ({
    ...d,
    min_answers: 3,
    max_answers: 8,
    rubric:
      "仅使用此领域作答，以真实实践与限制辨别知识、经历和技能。等级和阶段是有限解释，资料不足留空；不凭术语熟悉程度或缺少回答判低等级，不创造标准化量表。",
    probes: [
      "知道的理念怎样落实为重复实践？有什么具体结果或反例？",
      "不确定、压力或退步时有什么变化？",
      "有没有持续强烈投入的时期（Channel），带来什么成果与代价？",
    ],
  })),
  levels: [
    {
      key: "conformist",
      meaning: "Conformist：主要沿用外部规范和既有解释；这是来源概念的概括，不是标准化判分规则。",
    },
    { key: "individualist", meaning: "Individualist：形成独立立场、目标与探索；须在实践中核对。" },
    { key: "synthesist", meaning: "Synthesist：能结合多种视角并随情境调整实践；不等于无困难。" },
  ],
  phases: [
    { key: "dissonance", meaning: "Dissonance：既有方式与现实出现张力。" },
    { key: "uncertainty", meaning: "Uncertainty：旧方式失效后探索尚不稳定。" },
    { key: "discovery", meaning: "Discovery：发现可实践的新理解。" },
  ],
  concepts: [
    { key: "knowledge", meaning: "能说明的知识；不自动表示做过或做得好。" },
    { key: "experience", meaning: "实际接触和经历；不自动等于稳定技能。" },
    { key: "skill", meaning: "有具体实践支持的能力；不从自称或知识推出。" },
    { key: "false_transformation", meaning: "声称的变化与实践不一致的候选解释；需具体依据。" },
    { key: "regression", meaning: "特定情境中的退步或旧模式回归；不是永久缺陷。" },
    { key: "channels", meaning: "强烈持续投入的时期及其收益、成本和整合限制。" },
    { key: "glitches", meaning: "来源中的高风险加速概念；此产品仅讨论风险，不提供危险操作。" },
  ],
  lifestyle_examples: ["Workaholic", "Seeker", "Optimizer", "Drifter", "Specialist", "Integrated"],
  synthesis_protocol:
    "分别评估四域并说明整合；Lifestyle 示例并非诊断类型，Metatype 按证据动态命名。跨域阻碍/解锁必须有双方证据，框架因果概念默认是假说。提出核心问题及可选发展建议，未知明确保留。",
  plan_horizons: ["30d", "90d", "6-12month"],
  boundaries: [
    "一次只问一题，逐域自适应；每域最少3个、最多8个有效不同作答。",
    "不自动预填历史，不合并为原生认识，不提供公开数值总分。",
    "Glitch 仅风险讨论；禁止医疗、药物、化学、危险财务压力或危险 forcing-function 操作方案。",
    "计划仅 proposal，不创建任务、提醒或外部操作；效用未经验证。",
  ],
});
