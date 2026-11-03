# FindMe — 交付裁剪与制品适用性矩阵

> 本文是历史核对记录：文中提到的执行记录、Current Status、Runbook、迁移方案与 `deployment/README.md` 不在公开仓库中，当前运行方式见 [As-Is](as-is.md) 与[单节点部署](../deployment/standalone/README.md)。

> **状态：已确认（2026-10-22）。** 本人确认 43 行处理方式、`owner-entry-v1` 范围、仓库文件任务主权及新文件位置；ART-NFR 在 G1 先写最小定义与验证方向，G2 补详细度量。按 Helix Delivery Kit（`helix-delivery-kit` 仓库，v0.2-draft）的 P01 来源核实与范围澄清及项目裁剪说明编制，对应制品 ART-GOVERNANCE。矩阵确认不等于各制品内容或任何阶段门已经批准；“现状”只说明位置和缺口。Kit 本身仍是候选方法。

**2026-10-30 范围更新。** 沿用已确认的单人角色、文档职责和 43 类制品裁剪；当前范围改由[第一阶段个人理解与对话](delivery/phase-1-personal-understanding.md)承接。旧 owner-entry-v1 的 G1 与专属文件仍作历史证据；新需求不继承旧通过状态。下表更新当前引用与实际验证边界，不新增一套审批或平行制品体系。

## 1. 项目对象

| 维度 | FindMe 的情况 |
| --- | --- |
| 交付类型 | 改造：已有源码与部署资产，正从多条运行路径收敛到账号模式（[ADR D23](adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役)） |
| 本轮交付范围 | [第一阶段范围与验收](delivery/phase-1-personal-understanding.md)；当前需求基线，实际完成状态见 Current Status |
| 不在本轮 | 以[第一阶段的后续能力边界](delivery/phase-1-personal-understanding.md#6-后续能力与方案选择)为准；既有全量内容和框架义务继续跟踪 |
| 领域与外部系统 | 单一个人理解领域，内部分个人证据、方法内容、外部框架三条谱系（DA §3.1、§3.4）；既有 Cloudflare/PostgreSQL/模型出口资产可复用，具体可用依赖在方案阶段核对 |
| 数据与权限 | 个人私密数据；账号/Profile 作用域与 RLS；付费调用默认关闭、预算为 0 |
| 部署与运行 | 本人负责；实际依赖、部署观察时间与停用决定统一见 Current Status |
| 参与角色 | 本人一人；Agent 执行；尚无独立测试或运维团队 |

## 2. 角色与独立性

Kit 的角色合并为三类，职责差异保留：

| 角色 | 承担的 Kit 角色 | 职责 |
| --- | --- | --- |
| 本人 | business-owner、各门接收人、发布授权、运维接收 | 决定范围与取舍；确认 G1/G2；业务接受（G6A）与发布授权（G6B） |
| 执行 Agent | requirements-lead、architect、domain-lead、development-lead、test-lead、delivery-coordinator、operations-lead | 起草与维护制品、实现、运行验证、记录结果 |
| 独立评审 | reviewer | 由另一会话或另一模型评审设计与结果，不由同一执行会话自评；评审结论不替代本人接受 |

## 3. 仓库职责与任务主权

单仓 `helixho/findme` 兼任 definition（`docs/`）、engineering（`apps/`、`packages/`、`migrations`、`scripts/`、`deployment/`）与 verification（`apps/api/test/`）。source 职责分两部分：方法研究来源在 `docs/research/`；AV 原始材料与私人加工产物在仓库外，不进入 Git。

任务主权（谁是“当前在做什么”的唯一可写来源）为仓库文件；Current Status §2 NEXT 保存当前安排，执行结果在 `docs/execution/`。任务执行服务只做投影，不与仓库分别编辑同一任务状态。

## 4. 制品适用性矩阵

判断取值：required（需要独立表达）、merged（并入已有文件，给出位置）、not_applicable（有依据的不适用）、deferred（延期，给出阻塞的门）。“需到位的门”沿用原单人交付裁剪；当前内容深度按第一阶段的实际差异核对。带 owner-entry-v1 的待建专属路径是历史选址，只有相关迁移/测试工作包实际采用时才复用或调整，不据文件名复制一套新制品。文件存在不代表相应验收通过。

### D0 项目

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-PROJECT 项目定义 | merged | [Overview](overview.md) §1–2 | G1 | 已有 |
| ART-STAKEHOLDERS 利益相关方 | merged | 本文 §2 | G1 | 单人项目，以角色条目表达 |
| ART-OUTCOMES 目标与成功标准 | merged | [Overview](overview.md) §6；[第一阶段范围](delivery/phase-1-personal-understanding.md) §4 | G1 | 已按新愿景写明能力、回答质量与本人效用，实际效果待验证 |
| ART-SCOPE 范围与约束 | required | [第一阶段范围与验收](delivery/phase-1-personal-understanding.md) §1–2、§6 | G1 | 当前范围、有界覆盖及后续能力明确；不继承旧范围验收 |
| ART-GOVERNANCE 交付治理 | required | 本文 | G1 | 处理方式与任务主权已确认；阶段门仍按实际决定 |
| ART-ROADMAP 过渡与交付策略 | merged | [Roadmap](roadmap.md) | G1 | 已有 |

### D1 系统

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-BUSINESS 业务能力与流程 | merged | [BA](ba.md) | G1 | 已有 |
| ART-SYSREQ 系统需求与验收依据 | merged | [第一阶段范围](delivery/phase-1-personal-understanding.md) §3；业务来源为 [BA](ba.md) | G1 | P1-AC-01–09 已明确；正式路径与本人效用仍需实际验证 |
| ART-CONTEXT 系统上下文 | merged | [TA](ta.md) §2.1；第一阶段范围 §5 | G1 | 旧上下文保留供复用，新对话/来源/知识反馈与运行依赖按当前范围补齐 |
| ART-ARCHITECTURE 总体架构 | merged | [Overview](overview.md) §5；[AA](aa.md)；[TA](ta.md) | G2 | 已有 |
| ART-NFR 系统质量要求 | required | [TA](ta.md) §2–5；旧 [G1 质量场景](ta.md#owner-entry-nfr-g1) | G1 最小定义；G2 详细度量 | 保留旧场景并补持续对话、纠正后使用与有据支持的质量要求；量化阈值依实际候选确定 |
| ART-INTEGRATION 集成与部署原则 | merged | [TA](ta.md) §2.1；`deployment/README.md` | G2 | 需补：实际可用账号运行依赖与部署拓扑，不能把旧 Neon 恢复当默认前置 |

### D2 领域

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-GLOSSARY 领域语言 | required | [术语与编号](glossary.md) | G2 | 已集中解释核心术语与代号；Roadmap 改用 GAP-n，与交付门 G1–G7 区分 |
| ART-CONTEXTMAP 领域边界 | merged | [DA](da.md) §3.1、§3.4 | G2 | 已区分三条谱系；单领域不另拆上下文 |
| ART-DOMAIN 领域模型 | merged | [DA](da.md) | G2 | 已有 |
| ART-SUBSYSTEM 子系统设计 | merged | [AA](aa.md) §2 | G2 | 已有 |
| ART-DATAOWNERSHIP 数据所有权与生命周期 | merged | [DA](da.md) §9；[TA](ta.md) §2.1；ADR D23 | G2 | 已有 |
| ART-CROSSFLOW 跨域业务流程 | merged | [AA](aa.md) §3 | G2 | 已有 |
| ART-INTERFACES 接口目录 | deferred | 待定 | 开放第二人（T4）或开源前 | 本人内测只用自有客户端；路由与契约在代码中 |
| ART-QUALITYALLOC 质量要求分配 | merged | 随 ART-NFR 写在 [TA](ta.md) 同一节 | G2 | 缺：随 NFR 一并补 |

### D3 设计

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-FEATURE 功能规格与场景 | merged | `docs/implementation/` 各契约，主要为 [C 系列契约](implementation/c-series-cloud-runtime.md) | G2 | 已有 |
| ART-UX 交互与信息设计 | merged | [B 方向设计规范](../design-demos/spec.md)；[统一 App 契约](implementation/av-understanding-app-delivery.md) §5 | G2 | 已有；账号模式页面的异常与权限反馈未单独成文 |
| ART-API API 与事件契约 | merged | `packages/core/src/` 的 Zod 契约；[可靠性契约](implementation/t1-r1.md) §7–10 | G2 | 机器契约在代码中 |
| ART-DATA 详细数据设计 | merged | `packages/db/src/schema-*.ts`；`packages/db/migrations/` | G2 | 物理定义在代码中 |
| ART-AUTH 身份权限设计 | merged | [C 系列契约](implementation/c-series-cloud-runtime.md) §1；[TA](ta.md) §3；[Roadmap](roadmap.md) 安全与运行边界核验 | G2 | 交互式 owner-account:create 已有，绑定现有 owner scope；真实开通未由文档证明 |
| ART-BEHAVIOR 状态时序与并发 | merged | [可靠性契约](implementation/t1-r1.md) §3–6；[C 系列契约](implementation/c-series-cloud-runtime.md) §2 | G2 | 已有 |
| ART-RECOVERY 异常与恢复设计 | merged | [可靠性契约](implementation/t1-r1.md) §7；[C 系列契约](implementation/c-series-cloud-runtime.md) §2、§4 | G2 | 导入与迁移的失败恢复随 ART-MIGRATION 补 |
| ART-MIGRATION 迁移与兼容设计 | required | 第一阶段迁移与兼容 | G2 | journal归档接管顺序、角色、导入与兼容已成文；实际目标依赖、迁移/对账及快照退役仍未验证 |

### D4 准备

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-WORK 实施工作包 | merged | Current Status §2 NEXT | G2 | 需补：每步开始前写明边界、结果与检查 |
| ART-BUILD 构建与工程检查 | merged | [Commands](commands.md) §2–3；`scripts/verify.sh` | G3 | 已有本地构建与回归记录；后续按候选差异选择验证入口及配置 |
| ART-TESTPLAN 分层测试计划 | required | [第一阶段测试计划](delivery/phase-1-test-plan.md) | G2 | 已定义本地/数据库验证、当前 AC 关联与进入退出；浏览器、真实模型和本人效用未因此完成 |
| ART-TESTCASES 用例与覆盖设计 | merged | `apps/api/test/`；[测试计划](delivery/phase-1-test-plan.md) | G3 | 已按变更/AC 说明相关套件与未覆盖层；不是全部 AC 已有自动用例 |
| ART-TESTENV 测试数据环境与组合 | merged | [测试计划](delivery/phase-1-test-plan.md)“工程入口” | G3 | 临时 PostgreSQL、迁移及分离角色由运行器准备；真实部署组合仍未覆盖 |
| ART-TESTENTRY 正式送测包 | merged | 测试计划的“进入、退出与候选记录” | G3 | 候选、选测范围、日志和未测项随执行记录固定，不代替完整产品送测 |
| ART-RUNBOOK 部署与恢复规程 | required | 运行与恢复规程 | G3 | 已集中既有发布、回滚与停用保护；新账号运行依赖和真实迁移方案仍待确定，不恢复原 Neon |

### D5 证据

| 制品 | 判断 | 位置 | 需到位的门 | 现状与依据 |
| --- | --- | --- | --- | --- |
| ART-CANDIDATE 候选与产物清单 | merged | 本轮送测与发布执行记录（`docs/execution/`）中的“候选”一节：提交、构建产物、配置与迁移层级 | G3 首次固定；G6B 引用 | 单人项目不单独建清单；正式送测前固定候选，变更时产生新候选并核对证据适用性 |
| ART-RUN 执行与验证记录 | merged | `docs/execution/` | G3–G7 | 已有 |
| ART-DEFECT 缺陷及复验 | merged | 发现时记入对应执行记录；条件性线索在 [Roadmap](roadmap.md) 安全与运行边界核验 | 按需 | 无问题不编造 |
| ART-REVIEW 评审 | merged | 对应执行记录中的“评审”一节，注明评审者与范围 | G2、G6A | 需补：迁移设计与本轮结果须有独立评审 |
| ART-ACCEPTANCE 业务接受记录 | required | [第一阶段业务接受记录](delivery/acceptance.md) | G6A | 已有 P1-AC-01–09 未执行记录；本人接受仍未执行，不代填体验 |
| ART-DEPLOYMENT 实际部署记录 | merged | `docs/execution/`，每次部署一份 | G7 | 已有先例 |
| ART-ASBUILT As-Built 与运行交接 | merged | [As-Is](as-is.md)（实现）；Current Status §1（部署实况） | G7 | 已有 |
| ART-HANDOFF 会话与工作交接 | merged | Current Status | 全程 | 已有 |

## 5. 门与当前范围的关系

产品层 BA/AA/DA/TA 已按新愿景更新；`owner-entry-v1` 的 G1 评审仅证明旧范围已接收。当前第一阶段先完成范围和设计差异核对，沿用已有裁剪；工程、实际模型与本人效用各按对应证据判断，不重复制造完整制品或追加形式门。原门职责继续如下：

| 门 | 需补制品 |
| --- | --- |
| G1 需求基线 | 旧范围已有接收记录；新 P1 需求及其关联设计按本轮变更核对，不将文档一致性或旧门结果当作新范围运行验收 |
| G2 开发就绪 | ART-MIGRATION、ART-NFR 详细度量与 ART-QUALITYALLOC、ART-GLOSSARY、ART-AUTH 补充、ART-TESTPLAN、迁移设计评审 |
| G3 正式集成送测 | ART-RUNBOOK、ART-TESTENV（测试库）、AC 与用例映射，固定 ART-CANDIDATE |
| G6A/G6B | ART-ACCEPTANCE，引用 G3 起固定的候选；生产专属 AC 未测时须单独决定是否有条件推进 |

