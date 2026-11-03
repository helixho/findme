# Framework Runtime + Insight Analysis — 实施设计

> 本文定义外部 Framework Runtime 与原生 Insight Analysis Profile 的具体实现契约。业务语义以 BA/AA/DA/ADR 为准；本文不记录执行历史、测试结果或开工授权。

## 1. Outcome Anchor

本设计同时解决两件事，但不把它们做成同一套“超级画像”：

1. **Framework Runtime**：完整运行 HUMAN 3.0 等命名、版本化的外部框架，保留框架自己的维度、等级、追问、综合结果和发展计划。
2. **Insight Analysis Profile**：把高质量分析师的 reframe → structure → tension → hypothesis → verification 过程变成 FindMe 原生 A4/A5 的可复核 reasoning profile。

固定边界：

- Native Understanding 仍以 Source/Evidence/Experience/Claim/Revision 为真源。
- A8 Assessment 处理题组、量表和确定性计分；A10 Framework Runtime 处理解释/发展框架，两者不混用。
- Insight Analysis 不是第四条数据链，不拥有独立真值库。
- FrameworkResult 始终是“按某框架怎么看”；只有重新通过 A5 证据规则的内容才进入 Current Understanding。

## 2. Scope / Non-goals

本 spec 包含 definition contract、运行状态、API、持久化、模型/validator 边界、HUMAN 3.0 fidelity、Insight schema 与验收 fixture。

本 spec 不做：框架 marketplace、CMS、跨框架总分、组织管理员评估、自动执行发展计划、图数据库、把 HUMAN 3.0 宣称为已验证心理测评，实施顺序由 Roadmap 管理；完整 Framework Runtime 不阻塞 AV 本人小批内测。
## 3. 三条运行路径必须可区分

| 路径 | 定义来源 | 结果语义 | LLM 角色 | 能否直接成为原生 Claim |
| --- | --- | --- | --- | --- |
| Native Exploration | FindMe Epistemic Policy | 对个人材料的有限认识 | 语义 planner/synthesis | 经 validator 后可以 |
| Structured Assessment（A8） | 固定题目/计分规则 | 量表/检查表结果 | 不得决定确定性分数 | 不可以，需重新验证 |
| Framework Runtime（A10） | FrameworkDefinitionVersion | 某框架内等级、阶段和解释 | 可执行 semantic rubric | 不可以，需重新验证 |

Insight Analysis Profile 属于 Native Exploration 的处理 profile，不是第四条路径。它可以读取同一 EvidenceSet，并把通过校验的解释写回 Claim/Gap/Action 既有对象。

## 4. FrameworkDefinitionVersion

首版采用 repo 内版本化声明文件 + Zod contract，不先建设内容后台。逻辑字段：

```yaml
framework_key: human3
version: "2025-08-official-public-v1"
title: HUMAN 3.0
creator: Dan Koe
source_refs: [S30a, S30b, S30c]
source_status: verified_public_source
license_status: review_required
publication_status: draft | needs_review | published | retired
evaluation_mode: semantic_rubric
dimensions: [...]
levels: [...]
phases: [...]
concepts: [...]
intake: [...]
question_protocol: {...}
rubrics: {...}
synthesis_protocol: {...}
report_schema: {...}
plan_horizons: [...]
boundaries: [...]
```

DefinitionVersion 一经用于 FrameworkRun 就不可原地改写；修改任何会影响问题、等级、解释或计划的内容都必须升版本。
### 4.1 发布 gate

只有 `publication_status=published` 的定义可以进入普通产品入口。开发/内部 dogfood 可显式允许 draft，但运行页必须显示 draft 状态。

发布前至少满足：

- creator/source/version 可定位；
- 维度、level/phase、rubric、问题协议和输出结构完整；
- 内容使用/引用范围已评估，不能因网页公开就默认可全文复制；
- evaluation_mode 明确；
- 每个允许输出的等级和概念都有定义；
- 不把框架自述的“assessment”升级成 FindMe 对效度的背书；
- 高风险内容有产品执行边界。

### 4.2 首版物理位置

拟新增：

- `packages/core/src/framework.ts`：Zod contracts 与共享类型；
- `packages/core/src/frameworks/definitions/*.json`：版本化定义；
- `apps/api/src/core/framework-service.ts`：运行编排；
- `apps/api/src/core/framework-policy.ts`：gate / validator；
- `apps/api/test/framework-*.test.ts`：契约与 fixture。

不复用 legacy `apps/api/src/seed/data/questionnaires.json` 作为 Framework 真源；旧题库仍按 As-Is 路径存在，迁移另议。

## 5. HUMAN 3.0 Definition Fidelity

HUMAN 3.0 definition 以 S30 的 Dan Koe 原始公开资料为首要来源，不以二手中文 prompt 替代。首版必须覆盖：

- Quadrants：Mind / Body / Spirit / Vocation；
- Level 1.0 / 2.0 / 3.0，以及每个 level 内的 Dissonance / Uncertainty / Discovery phase；
- horizontal traits：Knowledge / Experience / Skill；
- False Transformation detection；
- Cross-Quadrant dynamics 与 regression；
- Lifestyle integration / Lifestyle Archetype；
- Metatype；
- Channels；
- core problem / problem-solving methodology；
- 结果报告与发展 roadmap。

原 prompt 规定逐题自适应访谈、每象限至少 3 题、最多 8 题，并要求一次只问一个问题。该约束进入 DefinitionVersion，不写死在通用 Framework Runtime。内部计算若框架需要可保留，但产品不得擅自增加框架未定义的公开总分。

### 5.1 Roadmap 语义

原始公开 prompt 的短中期结构为 30 / 90 天，并在完整输出中继续到 6–12 个月的 lifestyle integration。DefinitionVersion 应忠实表达来源中的实际 horizon，不将其改写成 FindMe 自己的 12 个月固定模板。

Framework 产生的所有计划项先标为 proposal；只有用户明确选择后才进入 A6 的 ActionTrial。

### 5.2 Glitches 与高风险内容

HUMAN 3.0 原始框架包含 Glitches/accelerants。FindMe 保留这个概念及“框架原文存在此判断”的语义，但执行层不因框架要求而绕过产品安全边界。

首版规则：

- 可以说明框架如何定义 Glitch、为什么它被视为高风险加速因素；
- 可以评估“用户是否在使用某类工具/做重大变化”对框架判断的影响；
- 不生成受管制药物、PED、危险财务压力或其他高风险加速手段的操作方案；
- FrameworkResult 中此类建议若出现，validator 必须删除具体操作并降级为风险提示或安全替代；
- AI dependency 可按框架定义讨论，但不将用户依赖度自动诊断为心理问题。

这属于执行边界，不改写原框架历史文本。

## 6. FrameworkRun 状态机

持久状态：

- `active`
- `completed`
- `abandoned`
- `needs_review`

派生 phase：

- `intake`
- `assessing`
- `synthesizing`
- `review`
- `completed`

运行不使用一个长事务包住 LLM。所有用户回答先保存，再进入下一步语义处理。

状态约束：

1. Start 固定 framework_key + definition_version。
2. 同时最多一个 open framework question。
3. Respond 只保存 answer Source，不等待等级判断完成。
4. Continue 执行 framework gate → semantic step/evaluation → validator。
5. DefinitionVersion 在 run 中不可切换；升级框架需新建 run 或显式 migration。
6. completed 结果若依赖来源被排除/更正，标 `needs_review`，不静默重写历史结果。

## 7. Framework 持久化

首版拟新增三张 Core 表；不把框架运行塞进 Exploration 表，也不新增一表一概念的过度设计。

### 7.1 framework_runs

必要列：

- id / tenant_id / subject_id
- framework_key / definition_version
- status / current_phase / current_dimension
- version
- started_at / last_activity_at / completed_at
- ext（只放可变的非身份元数据）

唯一运行不做强制；同一用户可以复测同一版本。

### 7.2 framework_steps

每次问题/回答/评估步骤保留：

- id / run_id / sequence
- dimension_key nullable
- step_kind = question | answer | dimension_evaluation | synthesis
- question_key / question_text / intent nullable
- source_item_id nullable（用户回答指向 SourceItem）
- status
- model_meta：policy/prompt/model/validator/input fingerprint
- created_at

用户回答新增 `SourceKind=framework_response`，并在 source_meta 记录 run_id / step_id / dimension_key / question_key。SourceAssessment 与 EvidenceSpan 沿用 Core 现有链路。

### 7.3 framework_results

必要列：

- id / run_id
- framework_key / definition_version
- version / status
- result JSONB（必须通过对应版本 Zod schema）
- evidence_status = valid | stale | invalid
- supersedes_result_id nullable
- created_at / invalidated_at / invalidation_reason

result JSONB 可保存版本化的维度结果和综合报告；tenant/subject/run/definition/version/lifecycle 不藏在 JSONB。

## 8. FrameworkResult Contract

通用结果至少包含：

```yaml
dimensions:
  - key: mind
    level: "2.0"
    phase: uncertainty
    evidence_refs: [...]
    rationale: "..."
    strengths: [...]
    gaps: [...]
    uncertainty: [...]
synthesis:
  lifestyle_archetype: {...}
  metatype: {...}
  cross_quadrant_dynamics: [...]
  core_problem: {...}
plans:
  - horizon: 30d
    proposals: [...]
boundaries: [...]
```

禁止通用 runtime 自创 `overall_level`。只有 DefinitionVersion 明确定义综合等级及生成规则时才允许产生对应字段；框架内部隐藏计算也必须保留规则版本，不能把模型“感觉像 2.7”写成分数。

## 9. Framework API

目标 Core API：

- `GET /api/core/frameworks`：只列当前可运行 definition；内部模式可带 draft。
- `GET /api/core/frameworks/:key`：返回版本、来源、边界、维度和用户可见说明，不返回未授权的大段原文。
- `POST /api/core/framework-runs`：创建 run，固定 definition version。
- `GET /api/core/framework-runs/:id`：恢复真源，返回 phase、进度、open question、已保存回答摘要和当前 result。
- `POST /api/core/framework-runs/:id/respond`：只保存回答，要求 `expected_version` + `Idempotency-Key`。
- `POST /api/core/framework-runs/:id/continue`：生成下一问题、dimension evaluation 或 synthesis。
- `POST /api/core/framework-runs/:id/abandon`：用户主动结束，不把未完成解释成发展缺陷。

所有 mutation 复用 T1-R1 的 operation/idempotency/version precondition；旧生成返回时必须检查 run version、definition version 和来源资格。

## 10. Insight Analysis Profile Contract

Profile 输入为当前问题 + 有资格的 EvidenceSet + current claims/gaps；输出只保存可向用户解释和校验的结构：

```yaml
presented_problem:
  text: "..."
  evidence_refs: [...]
reframe:
  text: "..."
  scope: "..."
  evidence_refs: [...]
  alternative_explanations: [...]
  change_conditions: [...]
life_structure:
  supports: [...]
  gaps: [...]
tensions:
  - pole_a: "..."
    pole_b: "..."
    evidence_a: [...]
    evidence_b: [...]
    scope: "..."
    interaction: "..."
hypotheses:
  - text: "..."
    evidence_for: [...]
    evidence_against: [...]
    alternatives: [...]
    confidence_level: low | medium | high
next_validation:
  type: question | experiment | stop
  target_uncertainty: "..."
  proposal: "..."
```

### 10.1 Semantics

- `presented_problem` 尽量忠实保留用户实际问题，不做解释性改写。
- `reframe` 是系统候选解释，不是用户已经承认的真实问题。
- `life_structure.gaps` 只表示“当前问题中有证据显示某支撑机制弱化/缺位”；没有采集到等于 unknown，不等于 gap。
- `tension` 必须分别有两端依据，并说明两端怎样在同一范围内形成现实取舍；“喜欢 A、不喜欢 B”不自动构成 tension。
- `hypothesis` 是解释层 Claim 候选，必须保留反例/替代解释。
- `next_validation` 只有在答案/结果真的可能改变判断时才产生；否则 stop。

Life Structure 的机制词不固定为统一维度。允许从目标、角色、关系、约束、创造/贡献、恢复、节奏、学习、掌控、探索等真实材料中长出，但这些只是可用词汇，不是用户必须填满的表。

### 10.2 Persistence Mapping

Profile 本身不新增数据库真值表：

- 已验证 reframe / tension / hypothesis → Claim/ClaimRevision；
- unresolved alternatives / discriminating question → KnowledgeGap；
- experiment candidate → ActionProposal（A6 未落地前可仅作为 generation output，不冒充已接受计划）；
- LifeStructureView / TensionView → 由当前 Claim + Gap 动态投影；
- GenerationRecord / exploration step meta → 保存 profile/prompt/model/validator/input fingerprint 和结构化候选，不保存隐藏 chain-of-thought。

## 11. Insight Validator

在现有 Understanding/Planner validator 上增加 profile-specific 检查：

1. 所有 evidence_ref 必须存在、当前用途 eligible 且属于本租户。
2. reframe 必须保留 presented problem，不得以更强断言替代原问题。
3. gap 不得仅由“用户没提过”产生。
4. tension 两端各至少有可解释依据；不得把病理标签或人格诊断当一端。
5. hypothesis 的 scope 不得超过 evidence 覆盖；因果语言需要因果依据，否则降级为“可能解释”。
6. 中高风险解释必须包含至少一个 alternative explanation 或明确说明为何没有合理替代。
7. discriminating question 必须说明不同回答会如何改变当前 hypothesis；不能只是“再多讲一点”。
8. experiment candidate 必须是可选验证，不得写成用户已决定执行。
9. “缺意义 → 做慈善”“不爱工作 → 该创业”这类一步跳到唯一处方的输出必须被拒绝或改成多个待验证解释。
10. 现有 scope-overreach / high-risk inference guard 继续生效。

confidence_level 仍是有序说明，不解释为正确概率。

## 12. 运行分层

Framework 与 Insight 都遵循 D16：

**Deterministic Gate**

- tenant/subject/definition/version；
- source eligibility；
- question lifecycle；
- framework dimension/order/question budget；
- allowed level/phase/concept；
- idempotency / stale precondition。

**Semantic Step**

- Framework：在固定 rubric 内选择高信息量追问、评估 level/phase、形成框架内 synthesis；
- Insight：reframe、structure、tension、hypothesis、alternative 和 validation candidate。

**Deterministic Validator**

- 结构 schema；
- 引用存在与资格；
- framework 输出是否超出 definition；
- insight 是否满足 evidence/scope/tension/alternative 规则；
- 输出版本与输入 fingerprint 是否仍有效。

两次语义候选都不合格时安全降级：Framework 保留 run 并返回 needs_review/retry；Native Insight 返回已有有限认识或 unknown，不为了完成报告而填空。

## 13. 最小 UI 契约

整体入口与内容结构按 [统一 App 交付](av-understanding-app-delivery.md) 集成到现有主 App 的当前认识/框架报告中。本节定义框架和洞察的局部交互，不再另建供用户在多个端口间选择的最终产品。完整框架与原生基线分开标记完成度。

### Framework

- Framework 入口与“测评/题组”在信息架构上可同区，但必须显示不同类型。
- 开始前展示：框架来源、版本、它评估什么、它不代表什么。
- 运行页显示当前 quadrant/progress；一次只展示一个问题。
- Result 页固定显示“这是 HUMAN 3.0 框架视角”，并允许查看各判断的回答依据。
- Roadmap 中的每个 proposal 可单独选择“加入我的尝试”；默认不创建任务/提醒。
- 复测显示 definition version；版本不同不自动绘制趋势线。

### Native Insight

- presented problem 与 reframe 不混成一句话。
- tension 卡允许展开“两边依据 / 适用范围 / 还有什么解释”。
- hypothesis 显示“当前判断”而不是“真相”。
- 只有存在实际区分价值时显示“帮我验证”；否则允许停在有限认识。

## 14. Acceptance Fixtures

### 14.1 Framework Runtime

1. draft/needs_review definition 在普通产品入口不可启动。
2. run 开始后 definition version 固定；文件更新不能改变历史 run。
3. Mind 的证据不能在无规则情况下直接决定 Body/Vocation level。
4. 模型输出 definition 未允许的 level/phase/concept 时被 validator 拒绝。
5. HUMAN 3.0 每象限问题数遵守其 DefinitionVersion，而不是通用 runtime 常量。
6. FrameworkResult 与其作答共享血缘，不得作为两份独立 evidence 支持同一 Claim。
7. 框架结果不能直接写 Current Understanding；经过 A5 才能产生原生 ClaimRevision。
8. 来源被 corrected/excluded 后，依赖结果进入 stale/needs_review。
9. 重试 Respond/Continue 不重复写入 source/step/result。
10. 用户中途 abandon 后保留已提交回答，不生成“未完成所以低 level”的结果。
11. Framework plan 不经用户选择不得成为 ActionTrial。
12. 高风险 Glitch 内容不能产出具体危险操作方案。

### 14.2 Insight Analysis

1. “我不知道 FIRE 后怎么玩”可形成候选 reframe，但 presented problem 仍保留原句语义。
2. 没有关系材料时不能写“关系缺失是你的结构缺口”。
3. tension 必须分别有两端证据；只有一端时降级为 hypothesis/gap。
4. 有反例时 hypothesis 能收窄 scope、降低 confidence 或撤回。
5. 至少一个 fixture 验证“意义感不足”不会直接推出“做慈善”。
6. 问题若只增加细节而不区分解释，必须 stop。
7. reality experiment 只能作为 proposal，不作为既成行为或成功证据。
8. profile 输出可重建到真实 evidence；无隐藏 chain-of-thought 字段。

## 15. 实施顺序与进入条件

本文保留 Framework Runtime 与 Insight Analysis 的候选技术契约，不单独决定默认诊断、正式数据形态或项目排期。当前交付依照 [诊断产品代码计划](diagnostic-product-plan.md)，方法选择依照 诊断方法基线研究。

现有 FrameworkDefinitionVersion / Run / Result 设计继续复用，但需与 DiagnosticRun / ReportRevision、历史预填协议、云端账号/数据和反馈修订一起检查。报告是综合呈现，不把框架与原生认识合并为统一等级或新真值库。

HUMAN 3.0 完整独立接入方向保留，默认地位不预定。具体框架原版、输入规则、术语和计划 horizon 需按选定来源版本整理成 DefinitionVersion，并记录 FindMe 适配差异；本文此前的示意 JSON 和表名不等于可直接上线的完整定义。

## 16. 实现前仍需收口的事项

R0 已提供方法组合建议与参考诊断；仍需验证真实使用价值，并收口具体 rubric/工具/语言版本、历史语料预填与原访谈的可比边界、内容使用条件，以及云端输入/诊断/修订的实际契约。公开材料可读不等于允许产品内全文复制；也不能将授权问题说成唯一待决项。

可以用合成框架和参考报告验证通用契约，不以全文复制原知识库或全量重读 AV 为前置。账号、存储、迁移和正式 provider 的核验与授权按代码计划分别推进。

## 已实现的跳过、暂停与尝试账本协议

源码定位：`framework-runtime/service.ts`、`routes.ts`、状态 schema（`schema.ts`；基线原位于 `state.ts`）及 `attempts.ts`；公开输入见 `packages/core/src/framework.ts`。下列为实现词汇，不把不同对象合成一个状态枚举。

| 对象 | 实际状态 |
| --- | --- |
| run.status | active / paused / completed / abandoned / needs_review |
| run.phase | intake / assessing / synthesizing / review / completed |
| job.status | processing / failed / rejected / obsolete / completed |
| attempt.status | reserved / ok / error / interrupted |
| answer.status | valid / corrected / excluded |

`respond` 允许显式 skip；跳过必须为空回答，记录 skipped_questions 而不制造个人证据（非空跳过拒绝 `SKIPPED_ANSWER_MUST_BE_EMPTY`）。输入不足保留 unknown，不凭跳过推断人格。暂停使用 `/runs/:id/pause`；恢复沿用 `/continue`，没有独立 resume 接口。保留的未答问题可直接恢复而不调用模型。写操作带 Idempotency-Key 与 expected_version，同键不同请求和旧版本分别拒绝；路由定义是字段与状态码的真源。

每次生成/语义审核先保留 attempt 与调用额度；attempt 保存 route/model、时间、usage、raw 和错误。超时迟到结果可保留原始记录，但不能越过 execution、版本与租约检查发布。失败续做不能假定未消耗额度，语义拒绝需要输入变化，过期执行须明确恢复；amend 使受影响作业 obsolete、结果 stale 并保留历史，再从受影响领域复核。`processing` 是框架 job 的词，云端诊断 job 的 `running` 是另一对象，不机械重命名。

路由错误映射在 `framework-runtime/routes.ts`：未找到为 404，作用域/草稿等限制为 403，旧版本/幂等冲突/忙或需要恢复为 409，其余语义输入失败为 422。完整 HUMAN 3.0 仍按其 draft/正式定义边界判断，不以协议齐全宣称真人框架验收通过。

状态契约与本机存储已分离：`framework-runtime/schema.ts` 不引入文件 IO，`private-repository.ts` 实现文件适配；旧 `state.ts` 保留兼容导出。云端 `cloud-diagnostic/frameworks.ts` 直接消费 schema 并使用 PostgresFrameworkRepository。`runtime-boundaries.test.ts` 守卫云端值导入图，不因兼容入口仍保留 private 导出而把它引入云端。
