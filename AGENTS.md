# FindMe — 文档索引

本文件只说明资料用途、边界和查找入口，不保存业务正文、配置值、部署快照或执行记录。

| 文档 | 用途与边界 |
| --- | --- |
| [Overview](docs/overview.md) | 产品定位、需求边界；不列功能完成情况 |
| [第一阶段范围与验收](docs/delivery/phase-1-personal-understanding.md) | 当前产品阶段的结果、必需需求与验收；不表示已形成完整赛博分身 |
| [BA](docs/ba.md) | 业务规则、业务过程与业务验收条件 |
| [AA](docs/aa.md) | 应用职责、功能协作与逻辑契约 |
| [DA](docs/da.md) | 领域语义、来源、证据、修订与数据生命周期 |
| [TA](docs/ta.md) | 技术选择、工程约束、数据安全与适度验证原则 |
| [C2–C4 云端实现](docs/implementation/c-series-cloud-runtime.md) | 账号/Profile、云端处理、原档、导入与生命周期的源码边界；不自动授权启用 |
| [As-Is](docs/as-is.md) | 已实现行为、实现限制和源码入口；不保存测试或部署历史 |
| [交付依据与历史裁剪](docs/delivery-tailoring.md) | 当前交付依据及旧裁剪的历史查阅入口；旧制品矩阵和阶段门不约束当前任务 |
| [owner-entry-v1 范围与验收条件](docs/delivery/owner-entry-v1.md) | 旧本人入口的历史 G1 基线；有效要求由当前第一阶段承接，不覆盖新增需求或恢复旧生产依赖 |
| [Roadmap](docs/roadmap.md) | 待解决问题、优先级与进入条件；不重复实现清单 |
| [ADR](docs/adr.md) | 重要选择的理由和取舍；不作日常变更日志 |
| [术语与编号](docs/glossary.md) | 区分 GAP 差距、历史 G 阶段门及领域状态，历史编号按映射解释 |
| [第一阶段测试计划](docs/delivery/phase-1-test-plan.md) | 可重复测试入口、环境、选测范围与未覆盖层；不代替本人效用验收 |
| [单节点部署](deployment/standalone/README.md) | 一键部署、配置与数据位置、换节点与故障定位；不保存实例状态 |
| [第一阶段业务接受记录](docs/delivery/acceptance.md) | P1-AC-01–09 的本人接受及证据入口；未执行不代签 |
| [债务逐项核对](docs/delivery/debt-resolution.md) | 原始 CD/AD/TD/DOC 编号映射、反证、修复与真实未完边界 |
| [审查说明](REVIEW.md) | 本项目的阻断范围、次要上限、不审范围、必查项、证据要求与审查轮次上限；人工与自动审查共用 |
| [Commands](docs/commands.md) | 已有命令、配置查找方式与副作用；不保存配置副本或运行结果 |
| [开发环境](docs/implementation/development-environment.md) | 本机/Codex Cloud 依赖、无生产连接的预览与凭据边界；不保存生产配置或部署状态 |
| [可靠性契约](docs/implementation/t1-r1.md) | 探索幂等、并发、恢复、来源传播与空结果的具体实现契约 |
| [单次探索契约](docs/implementation/t1-purposeful-exploration.md) | 输入保存、Ask/Stop、最终综合、输入修订与移动端交互的具体实现契约 |
| [AV 本人内测](docs/implementation/av-dogfood-v0.1.md) | 小批 AV 样本、片段归属、共享证据、成本与真实内测验收边界 |
| [AV 全量分层](docs/implementation/av-full-layers.md) | 经明确授权的全量 L1–L3 加工、覆盖/引用/预算及留出隔离边界 |
| [第一阶段主链](docs/implementation/p1-main-chain.md) | 对话使用当前认识、新输入的处理结果与账号自动处理上限的设计与契约；不含运行资源或部署 |
| [最小跨事件契约](docs/implementation/t1-r2-cross-experience.md) | 内测所需的认识身份、证据独立性、修订失效与回放契约 |
| [跨事件设计问题](docs/implementation/next-cross-experience.md) | 更完整跨事件能力的设计问题；当前内测范围以最小跨事件契约为准 |
| [框架与洞察分析契约](docs/implementation/frameworks-and-insight-analysis.md) | 外部 Framework Runtime 与 Insight Analysis Profile 的实现契约；不替代 BA/DA 语义真源，也不作当前开工授权 |
| [知识与专项路径](docs/implementation/knowledge-and-specialized-paths.md) | 知识加工主链、HUMAN 3.0、作品视角和 ADHD 路径的开发任务与测试用例；状态见文首 |
| [B 方向设计规范](design-demos/spec.md) | 统一 App 的设计输入与呈现基线；功能契约见整体理解与统一 App 交付 |
| [Assets](assets/README.md) | 品牌和 UI 资产入口 |
| [个人理解与对话交付计划](docs/implementation/diagnostic-product-plan.md) | 复用既有诊断/云端切片完成第一阶段的开发依赖；保留路径名以稳定引用，不将诊断作为整个产品终点 |
| [C1 诊断预览契约](docs/implementation/c1-diagnostic-preview.md) | 诊断阅读、关键补问、纠正与版本演练；明确合成预览和正式在线产品的边界 |
| [真实取证与受约束复评](docs/implementation/diagnostic-evidence-reasoning.md) | 有限原文取证、立场保真、分析与语义复核、复评幅度和可追溯候选的运行契约 |
| [整体理解与统一 App 交付](docs/implementation/av-understanding-app-delivery.md) | 全量材料的内容去向、个人理解基线、统一 App 内容结构、框架交付与真实修订验收；不是完成声明 |
| [U2 理解基线契约](docs/implementation/u2-understanding-baseline.md) | U1用途修复、命题与领域关系、专题/总览和旧认识校正；不等于U3页面已接通 |

按任务选择相关文档：产品问题看 Overview/BA，功能问题看 AA 及对应实现契约，数据问题看 DA，工程问题看 TA/Commands；核对具体实现看 As-Is 与源码，确定未来范围和进入条件看 Roadmap。

每项事实只在职责所属位置定义。文档间链接用于导航，不复制测试数字、版本号、部署状态等快照，也不依赖多份文档同步更新同一数据。配置和实际行为以对应配置、代码、schema 为源；旧对话和外部副本不成为平行正文。执行交接记录独立于这些正文管理。

