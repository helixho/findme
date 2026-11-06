# FindMe — 当前实现

> 本文只描述源码已有行为与实现限制。功能契约见对应实现文档；未来差距和优先级由 Roadmap 管理。部署状态查询实际平台，测试和交接结果不在此保存。
> 赛博分身愿景及[第一阶段个人理解与对话](delivery/phase-1-personal-understanding.md)属于目标基线；个人发展诊断是其中的综合交付形式。本文仅记录已实现行为，现有探索、报告或原型不能据此改称已贯通持续对话、新信息更新、完整分身或本人效用。
> 账号模式（§13）是唯一运行方式；§4–5、§9–10 描述的本机离线流水线已冻结，不接入运行中的 App，其产物以后由导入适配器处理。

## 1. Core 已实现行为

- 目标客户端为 `apps/app`，支持单次探索、恢复与来源纠正。访问使用单用户 Bearer 鉴权；App 可用单次、可过期的 bootstrap 换取访问串并清除 fragment，保存在当前浏览器 localStorage。入口实现见 `apps/app/src/api.ts` 与 Core bootstrap 路由；这不等于多租户隔离已经实现。

- `@findme/core` 与 Core schema 独立承载来源、事件、探索、认识和修订；operation 支持幂等，step 支持决策血缘，source link 区分输入补充、更正与时间更新。物理定义见 `packages/db/src/schema-core.ts`。
- Start/Respond/Correct/Continue/Complete/SourceAssessment/Amend mutation 均走请求幂等。Start 与 Respond 先在短事务内可靠保存用户原始输入，不等待 LLM；Continue 现在固定经过 `Deterministic Gate → Semantic Planner → Deterministic Validator`：版本化策略统一执行问题预算、hard cap 与 force-deeper 边界；模型只负责关键 uncertainty/有限表述；validator 拒绝重复问题、绕过确定性 gate 的 Ask 和已知明显范围越界，重试仍不合格则安全 Stop。Stop 时才执行一次 Final Synthesis。Correct 仍在事务外生成、短事务发布，并以 `expected_version`/current revision 防止过期结果覆盖。
- Exploration 具备 `ready_to_plan/awaiting_answer/review/insufficient/needs_review/completed` 派生 phase；App 可列出并恢复 active exploration。Planner step 持久化 `current_reading/key_uncertainty/intent/stop_reason`；`model_meta` 进一步记录 policy/prompt/model/validator/input fingerprint、decision source、Planner/Synthesis latency 和 validator 状态，用于把处理版本变化与用户变化分开。后续问题持久化为真实 Question，不依赖 React 内存或 `next_question` 文本恢复。
- Understanding/Revision 在发布前检查已知范围越界与人格化推断，失败原因进入重试；重试仍失败不发布。生成与修订保留可追溯血缘，持久化位置和计时语义见单次探索契约。文本护栏有否定、引用和未知表达的正反回归，但不等同通用语义正确性判断。
- Continue 读取本人在**其他探索**中的当前有效认识，作为有界上下文提供给规划与综合（选取规则与上限见[主链契约](implementation/p1-main-chain.md)）；已撤回或失去依据的认识只作为“不得作为前提”列出。存在已有认识时，综合可对其给出 unchanged/supports/narrows/challenges，经确定性校验后为原认识新建 ClaimRevision；原修订在写入前已变化的效果记为 skipped_stale。Stop 响应与步骤血缘记录实际使用的修订 ID 和处理结果。选取只按词面相关，不是语义检索。
- `UnderstandingDraft` 允许空 claims；证据不足返回 `insufficient`，全部撤回返回并可恢复为 `withdrawn`。
- SourceAssessment 可版本化修改 attribution/eligibility；受影响 current ClaimRevision 会确定性变为 stale/invalid，Current Understanding 只展示 valid claims，并单独返回 `needs_review`。Evidence UI 可对具体材料执行“不是我的表达”“不用于分析”，也可按 supplements/corrects/updates 追加新 Source；corrects 保留旧原文但使其停止参与当前分析。
- Core API 使用稳定错误码处理 stale version/current revision/idempotency/source conflict；目标 App 会复用 mutation key、轮询 operation，并对 stale/needs_review/empty outcome 做显式呈现。
实现入口：`apps/api/src/core/`、`packages/core/src/`、`packages/db/src/schema-core.ts`、`apps/app/src/`。单次探索流程的详细契约在 `implementation/t1-purposeful-exploration.md`，可靠性契约在 `implementation/t1-r1.md`；本文不复制接口字段与策略常量。

## 2. 运行方式

唯一运行方式是单节点：一个 Node 进程提供网页、API 和后台执行器，账号模式是唯一登录方式，数据库为任意 PostgreSQL（默认同节点容器）。旧的静态/会话/私有模式、旧版速记/洞察/问卷/素材接口、旧任务队列及其数据表，以及 Cloudflare Worker 与 Neon 专用读取已从源码移除。表结构只有一份当前定义 [schema.sql](../packages/db/schema.sql)，仅在空库时建表；账号角色与行级策略见 [account-runtime.sql](../packages/db/access/account-runtime.sql)。模型服务商、密钥与预算是存在数据库 `app_settings` 中的应用设置，在 App 中修改并即时生效。登录身份的签发者固定为 `findme-account`，与实例网址无关。

## 4. AV 本人小批内测（独立 staging）

`apps/api/src/dogfood/` 保留小批历史验证的离线处理代码；原 `av-dogfood` 本地服务与 App 内 Dogfood 页面已移除，资料导入将作为独立的导入功能或适配器另行实现。AV 以只读 SQLite 事务接入；仓库外批次保留完整选定原文、固定 split、来源定位、候选片段、人工审核、生成版本与逐请求账本。普通 `role=user` 不直接决定作者和观点，归属和语义判断仍是需要复核的模型候选。

模型输出经原文引用定位和用途资格检查，抽取与生成支持有限预算、checkpoint、显式失败重试；来源更正/排除可以立即使相关候选与认识失效。结构化分析与原文对照使用同一已处理范围及必要指代上下文，未处理范围不伪装成已分析。CLI 默认 dry-run；页面读取不自动调用模型。

当前入口是本机单人 staging，不是 production Core adapter、完整原生跨事件产品或多人服务。正式 Current Understanding 不读取这些候选；后续发布仍须通过 Core 接入与证据规则。Holdout 分组的语义独立性及真实分析准确性需要本人检查，不因程序测试或模型输出合法就宣称通过。命令、副作用与运行配置入口仅由 Commands 维护。

本地内测另有 Codex CLI 适配器，可复用本机 ChatGPT 登录态经 M-X2 同形契约完成结构化抽取和综合；仅离线脚本可选，App 运行时不使用。实际 CLI/model/effort 和可见 usage 留在批次账本；超时、输出/引用校验失败不会发布候选，具体能力与限制见 Commands。


## 5. AV 全量分层 staging

`apps/api/src/dogfood/layers.ts` 为已获授权的全量冻结批次提供批量 L1 覆盖与原子抽取、L2 原会话情境索引和有引用的 L3 综合。L2 为确定性归组，并非另一轮模型画像。每个 L1 段必须完整登记处理状态，原文引用逐字定位；完全相同材料计算复用保留全部来源。主要 L3 排除 holdout，且只引用合格的 L1 证据，不把归纳摘要重复计作支持。

`av-layers-view.ts` 为只读本地查看入口，能分页查看 L1、按会话查看 L2、阅读 L3 并回溯原文。实际任务状态和真实质量需读取当前批次与本人审核，不由实现存在与测试通过推定。该链路不改变 production Core，也不提供标准量表结果。


## 6. C1 诊断阅读预览

`packages/core/src/diagnostic.ts` 定义诊断运行、报告版本、来源/精确引用、判断、方法适配、证据充分性、补问和反馈契约。原生方法不能携带未定义的框架等级；背景材料只能按 contextualizes 使用；当前版引用固定来源与评估版本。该契约未创建云端诊断表或上线评级服务。

`apps/app/src/diagnostic-preview/` 通过独立 `/diagnostic-preview` 路径呈现三个 R0 合成案例。核心判断先展示，证据与替代解释按需展开；预写反例通过 `revision-scripts.ts` 同步更新判断、范围、检验条件、后续问题和建议，过时问题不继续开放。示例回答保留已有反例，依赖该回答的建议需复核；自由文字不经脚本自动解释。历史版本可展开当时的精确引用及现在的来源资格，只读回看不恢复已排除材料。来源排除会使相关判断、资源和覆盖失效；不同意、范围变化、现在不同和有帮助分别处理，已拒绝的建议不会因后续修订恢复。

原型没有模型/API调用。自由文本仅保存为待分析反馈，不按关键词套用示例答案。报告状态在当前浏览器的独立 localStorage 命名空间中保存；未提交草稿在当前标签页 sessionStorage 保留。Web Locks 与提交前版本检查用于同浏览器标签页的互斥保存，不等于跨设备同步。存储失败、不兼容数据、范围内导出和确认重置有独立处理；其他案例和实际登录存储不清空。

合成来源不会进入实际个人资料；预览不读取 AV，不修改现有原生 App 或独立 AV 入口。其可交互性不证明真人诊断效果、完整 HUMAN 3.0 协议或 C2/C3 云端闭环已完成。


## 7. 有界真实取证与受约束复评

`packages/core/src/diagnostic-reasoning.ts` 定义本次问题/提出者、来源片段、立场与用途、分析候选和语义审核的传输契约。`apps/api/src/diagnostic-reasoning/` 提供只读取证、原生分词与词面排序、候选分析、隔离上下文的语义复核、复评检查、来源指纹再核与私有结果留存；CLI 入口由 Commands 管理，不连接原 C1 合成预览。

AV 路径读取冻结 raw/manifest、L1 和审核状态，主要分析仅选 dev；同源 canonical 与原消息关联共同去重，未知/冲突/引用保持背景用途。排除区间独立于 L1 命中，不能从相邻上下文重新进入分析。选材相关性先于来源多样性；多会话/日期/组不等于多个独立经历。明确提供的 packet 支持无需词面重筛的有界输入，零命中或资料不足不会补造个人结论。

分析与审核均得到同一本次问题、提出者、选中证据和必要情境；旧报告只提供需修订的命题，不作为独立新证据。立场升级、范围外推和无据反证等审核问题不会因 warning 标签而放行。复评的旧命题和新命题声明通过 ID 关联，`unchanged` 保留已存文字与范围；模型原始输出另存，语义变化仍由新输入、明确修订类型和审核决定。

每次仅持久化选中来源快照，不复制整个 AV；未选中的排名元数据不进入模型。调用失败、截断 JSON、审核拒绝和中断有可追溯记录，显式重试保留 usage；已接受缓存复用前仍检查来源。当前依赖失效为全批次指纹的保守实现，而非已经完成细粒度增量；自动检索的实际召回、语义可靠性与本人收益仍需持续验证。

本能力可生成可读 Markdown 及结构化诊断候选，不创建生产数据表、账号、云端运行或正式 HUMAN 3.0 评分，不改既有 L1–L3。C2/C3 的 UI 接入和多端闭环仍未因此完成；`ready_candidate` 是工程/审核状态，不代表真人诊断已证实。


## 8. 整体理解与 App 的现有边界

全量 layers 的完成标记检查输入处理与引用链，最终 L3 是压缩候选而非完整主题目录；当前源码没有整批材料到所有重要主题/未采用内容的充分覆盖验收。L2 仍是会话情境索引，不能等同已经完成跨会话事件和个人发展基线。
主 App 只有账号入口（`apps/app/src/CloudWorkspace.tsx`）；`main.tsx` 只在开发服务器中另外加载合成 `/diagnostic-preview`。账号报告与框架代码见 §12–14；页面存在不代表全量 L3 已迁入正式主库或 HUMAN 3.0 原协议已完成。
新取证/复评代码不回写既有 L1–L3；旧结果不因规则改进自动升级为新语义。主题覆盖、基线校正、真实总览/专题/框架及跨页面修订的交付义务见 [整体交付契约](implementation/av-understanding-app-delivery.md)；已有代码和仍未完成的部分按对应章节核对，不将早期缺口概括为当前全部未实现。


## 9. U1 整批内容覆盖与去向

`apps/api/src/dogfood/content-coverage.ts` 和 `apps/api/scripts/av-coverage.ts` 复用冻结批次、L1/L2 及现有来源资格检查，对原文区间、逐原子候选、旧分组归纳输入、归纳提名和最终 L3 引用分别对账。相同原消息 UUID/区间与既有 canonical 共同去重，保留所有上游定位；当前排除、失效或分类争议不会被主题归类升级成个人事实。

命名主题从开发集原话样本及整批元数据生成，再对全部可处理开发候选逐项映射；允许多主题、其他、不明确与待复核。尚未分类、已分类但未知、仅作背景、已被旧报告引用分别呈现。主题是可重建索引，不是个人诊断；会话数量不代表独立经历数。

遗漏检查包含原先未采用、不确定、背景/任务材料及已采用对照，按来源多样性选取有界窗口。恢复建议须逐字定位，程序可解析唯一原文位置，不依赖模型准确计算字符偏移；其作者归属与解释仍待复核，不自动写回原 L1。窗口外内容不被宣称已审核，holdout 只做标识与数量对账。

默认不调用模型；live 使用既有隔离 Codex Gateway，固定任务指纹、累计请求预算、限并发、原始输出与逐次 usage。已完成任务复用；失败显式重试；派生版本与进度账本写在源批次之外，输入前后指纹核对。默认盘点与真实语义处理使用不同最新指针，盘点不能覆盖已完成 live 结果。

U1 不生成新的完整个人基线、不更改旧 L3、不接入真实 App 或完成外部框架；这些仍由 U2–U4 分别验收。


## 10. U2 命题、情境与理解基线

`packages/core/src/understanding-baseline.ts` 与 `apps/api/src/understanding-baseline/` 提供私有U2投影链：核验冻结来源、U1版本和复核overlay；保留全批去向；将指定修复与项目自述候选按命题/用途检查；形成有原文依据的角色、目标、约束、选择、结果等实例和关系，随后生成专题、综合报告及旧认识处置。U2 CLI 当前默认 provider 为 DeepSeek API；Codex 只在显式选择时启用。既有输出目录一旦绑定模型，普通 live 运行遇到不同 provider/model 会在写入前拒绝，不能静默混用或重置当前指针。显式 `provider-migration.json` 可把新阶段绑定到 continuation model：历史 `model` 与已完成 job 保持原 lineage，新 job 使用 continuation model 的独立 fingerprint；migration 内容和 run 中的 migration hash 每次读取/恢复都会重新核验。真实 provider 调用另有 per-invocation `provider-call-cap`，运行层达到上限即停止。对于独立审核已明确指出的局部不支持对象，U2 可生成带来源 audit/hash 的 deterministic-prune job，零调用删除对象而不改写语义文本，后续仍必须重新独立审核。

U1主题按版本化的编辑映射组织成阅读领域，不成为人格维度或本体类。每个领域保留成员与省略记录，仅选定原文及必要上下文进入模型。用途修复的优先取证预算有限，避免新修复的项目背景挤掉原有个人表达；输入集合同时记录选材版本，变动后仅相应专题重新生成。指代不明的材料保留为待澄清导航，不从短确认词生成稳定个人判断；工作材料不自动补齐未覆盖的生活领域。

用途修复为单独overlay，保留旧分类、原始偏移、同源标识和模型来源，不写回原L1。项目中的本人报告可以形成局部report-only命题；命题推导与外部项目事实验证分开。不同命题可共享原句而不增加独立来源，兼容分面与真正作者/立场冲突分别处理。

专题与总览记录支持、挑战和背景，节点/关系的端点、类型、归属、时间与引用经过校验，另起上下文用同一输入做语义复核。整体总览只使用实际提供的原子证据，专题结果用于导航；旧认识逐项保存当前规则下的处置，不改写旧L3文件。方法检查通过不等于本人效用或诊断效度已经成立。

报告传输中的时间规范化单独留存版本及原始输出依赖：字面量“null”还原为空值；精确空串与“/null/”使用独立版本规范化，旧缓存仍按其原处理版本复算。引用跨不同表达时间时不选其中一个时间代表全部；任意时间标签和不存在于引用中的日期仍拒绝。项目背景类型与实体行为主体分开，具体主体和语义由同输入审核检查。用途审核发现明确目标命题不受支持时，可将对应请求降为unknown并再次审核一次，保留原被拒提议与旧用途；不清除全局错误、不把拒绝结果改成通过。

报告级失败审核也可作为未验证的修订线索：显式续接最多生成一版同来源新稿并独立审核，不把旧反馈当事实。成功修订在普通读取或 dry-run 时继续复用，不要求再次开启重试；语义或结构失败后，同一修订指纹不能靠重复命令继续调用。纯 provider transport 失败若没有 raw、候选和 usage，可有界技术重试；Codex CLI 仅 patch 版本变化、model/reasoning effort/adapter 相同时允许 transport migration，并把实际 `runtime_model` 单独留账，不能借机改变语义模型。旧失败与用量保留，当前审核只判断新稿及其实际原文支持。

执行采用全局累计调用预算、分阶段缓存、私有原始输出与字节完整性清单，来源变化会撤销当前指针；失败重试不清零用量或重复已成功阶段。来源绑定目前仍采用全批指纹；同输入的成功检查点复用不等于已经实现单条反馈的依赖级增量更新。配置与副作用仅由 Commands 维护。

U2 产物仍是仓库外结构化候选和可读报告；U2 CLI 本身不接入正式主库或 App，不运行完整 HUMAN 3.0，不宣称精确语义召回或完整生活图谱。U3 对这些产物的主 App 适配见 §11；真实反馈运行、集中验收、U4 框架和云端多端仍按代码计划分别推进。


## 11. 已移除的本机报告宿主与归档读取

U3 本机报告宿主、其主 App 视图、Core 报告回传接口、Neon 归档只读读取与 U2 归档导入路由都已移除。`apps/api/src/understanding-app/` 中仍被离线准备脚本使用的资格、读取与生命周期模块保留为离线代码，不在运行中的 App 挂载。

AV 加工归档两表（`av_processed_batches`、`av_processed_chunks`）保留在库中，属于旧加工流程的派生产物，App 不读取；它们仍包含在账号分页导出与 Profile 清除中。归档的后续使用由导入适配器另行设计。

## 12. 独立框架运行时

`packages/core/src/framework.ts` 与 `apps/api/src/framework-runtime/` 定义版本化框架、访谈状态、精确作答、语义步骤及独立审核。开始绑定定义内容指纹，原话先保存；一次一个问题，问题数由定义约束。逐域评估与跨域综合分别运行，证据不足保持未知，不把未作答解释成低等级，也不自动写入原生 Current Understanding。

账号 App 的 `FrameworkView.tsx` 提供框架目录、恢复访谈、单题输入、分析状态、更正／排除和报告依据，API 为 `/api/understanding/frameworks`。`cloud-diagnostic/frameworks.ts` 的 `PostgresFrameworkRepository` 按 Profile 保存运行状态；每条回答是一条本人来源（回答编号即来源编号），存储的框架状态只保留编号与校验值，读取时从来源表取回原话；更正生成替代来源，排除使来源停用。模型分析受模型设置中的框架调用额度约束，默认关闭且额度为零；读取及保存回答不调用模型。

未保存的框架回答在当前浏览器标签页内按身份、Profile、运行和问题保存草稿；草稿不是服务端已保存回答，也不承诺跨设备同步。

内置 HUMAN 3.0 定义是依据既有 R01/R02 来源整理的中文转述适配草稿，尚未验证与完整原协议等价，也未完成内容使用与实际效用复核。草稿定义在账号 App 中不可启动；完整本人运行仍须实际访谈和独立报告，不能由代码、自测或入口状态替代。


## 13. C2–C4 账号云端运行代码

账号模式通过 `auth/server.ts` 的 Better Auth/pg 具体服务、`auth/account.ts` 服务端 session 校验与 `auth/profiles.ts` 多 Profile 管理接入。默认注册关闭，需配置实际邮件发送回调才可启用；客户端 account 模式在同一 `apps/app` 使用 cookie session、Profile选择、登录/注销/密码重置，不沿用固定 owner 或静态Bearer。

`schema-auth.ts`、`schema-platform.ts`、`schema-diagnostic.ts` 与 `cloud-diagnostic/scope.ts` 分别承接账号凭据、Profile/任务/调用/导入/生命周期、报告/证据/原档及事务作用域。运行/identity/auth 数据库角色分离，scope入口拒绝特权或不正确角色。完整Core子表策略和角色授权在单独的 `access/account-runtime.sql`，每次部署幂等应用。

`CloudProcessingService` 将明确选材后的原话资格生成/独立审核与报告生成/独立审核接入持久化队列。新任务固定来源/政策/model，逐请求先预留预算，保存raw/usage/失败，不自动重试；取消、Profile归档、来源和报告版本变化使迟到结果不能发布。已审核资格与通过阶段可重建复用；普通读取和保存不调用模型。`CloudDiagnosticRepository` 发布入口只给受控队列消费，重新核验raw、审核和源版本后才更新当前head。

云端资格输入保留作者、来源类型、对象、立场、披露时间与事件时间，生成、独立审核及引用核对使用同一来源语义。新规则和输入指纹不复用旧资格检查点；缺少新证明的旧结果需复核，不自动调用模型。当前整体报告读取会检查依赖专题的状态和版本，实质纠正使相关整体认识返回待复核；仅表达“有帮助”不改变依据版本。排队任务在认领前发现依据或处理版本变化时落为 stale 并记录原因，不预留调用或自行重派；用户按新依据明确请求后才能创建新任务。专题重新发布时，只有依赖旧专题版本的在途整体任务失效，终止任务保留历史状态；当前整体认识依据其当前 head 绑定任务判断依赖，在锁定记录后核对最新 head，每份整体报告最多增版一次，已归档记录不恢复。资格证明、检查点复用与发布完整性比较先对原始结果和持久结果应用同一严格结构，避免数据库 JSONB 对象键序变化被误判为内容篡改；内容、类型、未知字段、数组顺序和输入绑定仍按原规则验证。合法检查点恢复不增加调用预算或尝试记录。

实例不需要登录：服务端以唯一的内部账号处理所有请求（`auth/owner.ts`），App 没有登录页、退出入口和资料切换；部署时删除旧的密码凭据与会话。account 主 App 与已有报告入口共用 B 方向的品牌标志、配色、桌面阅读分栏和手机底部导航。整体报告只读取当前已审核报告，缺失时不拼接专题伪造总览，首页的当前认识另读 Core（见 §15）；“全部认识”页（`UnderstandingList.tsx`）列出全部当前认识，可查找、回到原对话、纠正或停用；App 不再提供模型设置、Profile 管理、内部导入包和来源重绑入口，报告处理不再要求确认调用次数或手填额度；新话题先直接回应（`reply_first`），需要时再进入探索；专题与纠正修订复用现有诊断 API。账号纠正绑定整份报告版本，不伪装成接口尚未支持的单条判断绑定；保存只显示待核验，处理仍须单独确认用途与调用范围。历史报告只读，版本对照使用实际可读报告；账号历史依据缺少按版本接口时不混用当前依据。资料切换与账号恢复按请求序号隔离迟到结果。资料、独立框架、知识与专项入口保留；新增知识与专项入口的源码边界见 §14。Core 的 continue/correct/reply 在模型设置打开模型调用且“对话自动处理次数”大于 0 时由 `routes/account-core-model.ts` 承接：读写各用短 Profile 事务，模型调用不在事务内，滚动 24 小时操作上限超出时不调用模型；未配置时保持 503。主 App 账号版新增“对话”入口（`apps/app/src/cloud/ConversationView.tsx`）。其余原生 Core 来源操作沿用事务 scope 并通知云端依赖失效。

`BlobStore` 的本地文件实现（`standalone/files.ts`）处理原档流式有界上传、校验、鉴权下载、删除和恢复；对象副作用不持有数据库事务。每个原档登记时生成一条 `original_file` 来源，`source_blobs.source_item_id` 指向它；上传者是本人不等于作者是本人，来源作者与事件时间记为未知；删除原档使该来源停用。`CoreIngestService` 提供预览/明确提交，精确EvidencePacket与个人导出可转换为待核来源；源定位、root、作者/对象/立场和时间保留，holdout不进入模型，历史报告不自动成为accepted。

取消后新的明确处理请求创建替代任务，响应丢失后重试仍复用该次任务；Profile 累计用量不因替代任务清零。任务额度耗尽后，可在服务端上限及 Profile 余量内显式提高任务累计上限继续；语义拒绝或损坏的证明仍需新依据。资格复用会逐个重建匹配问题、领域、规则及完整来源快照的已有证明，不被较新无关证明遮挡。

`CloudLifecycleService` 处理来源排除/恢复、替代绑定和删除；`effects.ts` 使相关报告/任务失效并清理原话复制与派生缓存。`ProfilePurgeService` 分步清理数据库/对象并支持继续未完成清理，保留账号身份和纯累计费用计数。来源生命周期操作分别处理历史修订与当前 head：仅历史依赖变化不撤下无关的当前报告，归档状态保留；软失效只改变相关在途任务，硬删除仍清除历史原话载荷。报告读取与显式处理共用有效性检查；待复核报告可以明确重建，纠正和发布按同一 Profile 串行核对。

Core 来源评估和账号来源排除/恢复/重绑共用 `core/source-invalidation.ts` 的当前认识失效传播。有效支持同时检查当前资格与来源仍为 active；有其他合格支持时标 stale，没有时标 invalid，均退出有效 Current Understanding；保留原文、当前版本身份和 superseded 历史，无关认识不变。恢复来源不自动重新发布旧认识，重绑不继承旧资格。来源变更先按固定顺序锁定相关探索，再核对来源/评估版本，与原生输入更正的锁序一致；活跃探索版本改变使旧生成不能发布。硬删除仍由独立分支撤回并清理相关当前/历史正文，不与软排除统一成同一终态。账号 Core 的 HTTP wrapper 只继续传播云端报告依赖，不重复执行 Core 认识失效。

`CloudExportService` 以固定清单分页输出个人持有数据，凭据不导出，原档单独鉴权下载；分页数据包不是原子数据库备份。导出恢复保留已知对象、立场、作者、时间和来源排除状态，在新导入 namespace 下保留共享根关系；缺失旧元数据为 unknown，非法已知值拒绝。恢复仅产生待核验来源，不继承旧资格、报告或旧 Profile 的 target_context。

单节点运行入口与部署见 [单节点部署](../deployment/standalone/README.md)；邮件投递与真实模型组合尚未验证。详见 [C系列实现契约](implementation/c-series-cloud-runtime.md)。


### C 系列最小验证后的实现修正

账号中间件以Hono Context保存请求级已验证身份，避免bodyLimit替换Request后丢失principal；请求结束即清除。账号health复用runtime权限门禁，不要求业务账号访问旧版全局任务。访问脚本对管理型PostgreSQL采用角色属性核验而非提权ALTER；tenant/membership锁定读取使用相同scope的policy和受限列授权。这些实现修正不代表真实推理已验证。

## 14. 知识加工与专项路径的账号模式代码

账号模式新增 `/api/knowledge`：用户固定来源范围后，从已有且当前有效的个人 ClaimRevision 与 EvidenceSpan 形成专题版本，区分支持、反例、背景、来源去向和缺口。同源派生材料按根来源与既有事件组去重；事实更正、解释异议、时间变化和效用意见分别保存。当前读取会复核来源与认识资格，并检查同一 Profile 其他专题尚未解决的纠正，相关旧判断不继续作为当前结论。它尚不能从普通新来源自动形成命题，也没有完成跨专题新判断的总览合成。实现见 [knowledge-processing](../apps/api/src/knowledge-processing/service.ts) 与[契约](../packages/core/src/knowledge-processing.ts)。

专题整理和报告处理的来源选择读取完整分页并显示可选总数与已选数。新专题请求在结果未确认时保留专题身份、原请求和幂等键，页面切换或刷新后可重试同一次整理。

`/api/content` 读取仓库内版本化、经审核的内容卡；当前清单有《新世界》（A New Earth）的有限作品提问和 NICE NG87 环境调整候选。新请求只选当前已发布版本，撤回或草稿不进入新选择；历史版本按原版本保留。作品回应只在本次请求回显，不持久化，也不从作品推断个人事实。实现见[内容目录](../apps/api/src/content/catalog.ts)与[作品视角](../apps/api/src/content/reflection.ts)。

`/api/specialist` 在当前 Profile 保存自愿选择的通用或 ADHD 相关情境，诊断自报与实际困难分栏。已保存的专项情境可在同一会话中继续补全场景、困难等信息，写入核对版本并重新读取候选；既有建议和尝试仍保留其形成时的依据。方法候选须同时匹配本人选择的情境类别和已发布内容；建议固定个人与内容依据、负担、代价和未知，只有本人确认才形成 ActionTrial。拒绝、暂停、未执行与效果未知都是合法状态。回顾保存为有 Trial 血缘的个人来源；本人可显式关联已有认识，实际执行后该认识标为待复核，不自动生成修订后的结论。实现见[专项路由](../apps/api/src/routes/specialist.ts)与[App 入口](../apps/app/src/SpecialistView.tsx)。

专项会话中本人填写的目标、情境、困难、环境、已有支持与负担作为一条版本化来源保存（`specialist_sessions.context_source_id`），修改生成替代来源；会话行只保留结构化选择。尝试回顾的原话只在回顾来源中，尝试历史保留其校验值。表结构见 `packages/db/schema.sql`。


## 维护后的源码职责入口

`core/exploration-service.ts` 保留原调用入口，读取、规划、修订、持久化、视图、上下文与校验分至同目录 `exploration-*.ts`；`packages/core/src/diagnostic-validation.ts` 承接诊断校验。`cloud-diagnostic/repository.ts` 继续作兼容入口，来源/证据、报告读取、回应接收、发布、锁与版本操作分别定位到 `evidence.ts`、`report-reading.ts`、`response-intake.ts`、`publication.ts`、`repository-state.ts`，任务纯决策在 `processing-policy.ts`。

`knowledge-processing/service.ts` 保留服务导出，读取视图、反馈、专题加工、依据与持久化分到同目录模块；`routes/specialist.ts` 处理 HTTP 适配，专项业务与仓储在 `specialist/`。结构分离不改变领域语义，也不代表完整集成已验证。

`framework-runtime/schema.ts` 定义不含文件 IO 的状态契约，账号运行时由 `cloud-diagnostic/frameworks.ts` 实现存储；测试另用文件实现（`test/helpers/file-framework-repository.ts`）。`shared/primitives.ts` 与 `domain/understanding/` 承接共享纯规则，`runtime-boundaries.test.ts` 从 hosted/cloud 入口检查值导入图，防止再次引入冻结流水线或私有文件 IO。Core/Shared 包入口显式导出，保留已有公开面兼容。

当前策略的只读查询见[策略与处理血缘](implementation/c-series-cloud-runtime.md#7-策略和处理血缘)。注册信息不参与旧记录的读取资格判定，不将不同对象状态合并成统一枚举。

## 维护后的入口与验证落点

`apps/app/src/App.tsx` 只渲染账号入口 `CloudWorkspace`。冻结批处理的注册、修复、专题、审核、重放和发布按职责组织，原导出/预算/历史恢复保留为离线代码。

仓库引用核对由 `scripts/check-repository.mjs` 提供。Zod 3 补丁保留。

## 15. 三条理解路径的现状关系

报告、对话和知识专题是三条路径，使用同一来源表；对话、知识专题和首页“现在的理解”读 Core 当前认识，诊断报告正文另成一套：

| 路径 | 入口与接口 | 读写的内容 | 当前限制 |
| --- | --- | --- | --- |
| 诊断报告 | 首页“整体认识”、专题阅读、纠正与修订；`/api/diagnostics` | 专题回应、经审核的专题与整体报告版本 | 首页只统计并展示诊断专题；对话中的新输入不会更新诊断报告 |
| 对话 | “对话”；`/api/core` | 探索、经历、认识及其版本 | 对话形成的认识在对话视图和首页“现在的理解”读取，不进入整体报告正文 |
| 知识专题 | “专题与来源”；`/api/knowledge` | 由已有认识与证据按规则整理的专题版本，不调用模型 | 不能从普通新来源自动形成命题，也没有跨专题总览 |

首页与对话现在读同一份 Core 当前认识；整体报告正文仍不随之更新，只做报告级提示。真实模型下的效果尚未验证。

持续交流复用 `core/conversation.ts` 的保存、纠正与停用路径；账号直接回应由 pi 承接：
- 纠正先经 `POST /api/core/explorations/:id/corrections` 保存（不调用模型，来源 `correction_status=pending`；对已结束的对话会重新打开），再由 `/correct` 以 `correction_source_id` 处理；处理失败或模型未启用时纠正保留为待处理，可重新处理。旧请求体仍可用，改为先保存再处理，同一操作重试复用已保存的纠正。
- `POST /api/core/claim-revisions/:id/withdraw` 按本人要求停用一条当前认识，不调用模型，先锁对话再锁认识并原子递增对话版本；之后不进入回答、当前认识和首页，并作为不得作为前提的项目提供给模型。
- 探索停止追问或结束后，`/messages` 保存续聊消息并重新打开会话。普通新信息不再自动调用 `/continue`；显式更新认识、纠正和停用保留。
- `index.ts` 在模型配置含 key 时创建 `piReply`，注入账号 `/reply`；`personal-understanding/pi-conversation.ts` 使用完整 AgentSession SDK，恢复有效归档，以当前会话和历史原文为主，通过 `pi-read-tools.ts` 提供原文检索、会话/来源展开和方法读取。旧网关回应保留作未注入 pi 的兼容路径，不能据此声称生产入口仍固定一次生成。
- `pi-provider.ts` 只连接明确的 OpenRouter 出口；实际请求经过原有 Profile 每日操作闸及每操作的请求、输入、输出、费用和报价上限，禁用服务商重试。具体限额唯一来源为 `pi-conversation.ts` 的 `PI_REPLY_LIMITS`，报价上限不是实际单价。自动压缩尚未启用，上下文超限明确失败，原文仍保存。
- `pi-archive.ts` 将 pi 会话归档为数据库来源，保留每次实际 pi 上下文、provider payload、可见输出及工具往返。最终归档与回复在同一事务提交；失败检查点标为未完成，下次重建。仅完成且 `contextVersion` 相符、依赖仍有效的归档用于恢复。归档结构及已有库升级脚本分别见 `packages/db/src/schema-core.ts`、`packages/db/migrations/0001-pi-session-archives.sql`。
- 来源失效传播同时清理相关 pi 归档、派生回复与幂等缓存。该代码路径不代表实例已升级或真实模型下的连续交流效果已通过，真实验证仍需在 Instabox 隔离测试资料中执行。
- 回应、综合、纠正三处提交统一复核：所用认识仍为当前版本且依据状态未变，所用材料仍有效、可用且评估版本相同；加锁顺序为对话、来源、认识，与来源变更一致。处理已保存的输入时，已结束的对话会重新打开。
- 删除来源时，引用了受影响认识的直接回应被清空，对应消息回到“待回应”。
- 知识专题中的“纠正这条”经 `POST /api/core/claim-revisions/:id/corrections` 进入同一纠正流程；专题的反馈入口只保留效用评价，后端旧的专题级纠正类型仍可接收但界面不再使用。
- `/park` 把一件事标为暂缓（`explorations.ext.parked`）；探索列表返回暂缓状态和最近一步的“卡在哪里”，详情返回待处理的纠正与消息。
- `GET /api/core/understanding/changes` 列出最近形成、修订和停用的认识。

首页（`CloudReadingHome.tsx`）按使用状态排列：有未暂缓的未完讨论时先显示“继续这件事”；随后是 Core 当前认识与最近变化；只有已审核报告、尚无对话认识时，报告排在最前。窗口重新可见或点击首页时重新读取。整体报告以报告版本自身的生成时间（`report_created_at`）标明日期，此后有认识变化时只在报告级提示“相关判断可能已不再成立”，尚未逐条标注受影响的判断。

## 16. 本人输入的统一保存

所有本人输入只在 `source_items` 保存一份，由 `core/personal-source.ts` 写入来源、归属评估与证据片段；各功能只保存来源编号。证据片段引用来源原文是合法的证据摘录，不算重复输入。

| 输入 | 保存方式 |
| --- | --- |
| 对话、诊断专题回应 | 各自写入来源后引用 |
| 框架回答 | 回答编号即来源编号，框架状态不含原话 |
| 专项情境 | 一条版本化来源，修改生成替代来源并以 `corrects` 关联 |
| 尝试回顾 | 回顾来源；尝试历史只保留校验值 |
| 原档 | `original_file` 来源，文件为附件，作者与事件时间未知 |
| 导入 | 提交后写入来源，暂存内容清空 |

记录时间（`created_at`）不等于事件发生时间；输入没有说明时，事件时间保持未知，时间精度记为 `unknown`。更正保留旧版本并标为已替代；排除使来源停用但不删除；删除原档使其来源停用。

## 17. 固定会话与已有洞察的导入代码

`UnderstandingImportService`接收会话原文、已有分析片段、修订链、反例关联及用户反馈；结构由`packages/core/src/understanding-import.ts`校验。来源角色为导入声明、用途仍待复核；原始时间与采集/事件时间分开。每条洞察必须精确定位到原始分析文本，助手文本不能充当独立个人支持证据；候选、争议、撤回和被替代版本均不自动发布为current。

`claim_revisions.details`保存受校验的领域、内容类型、分析作用、情境、有效时间和指向确切修订的关系。反馈复用`feedback_events`，正文留在source，区分事实认可、解释认同、启发性、建议效用、异议、更正和用途未明。相关来源硬删除时，认识正文和details一起清空；关联修订继承所依赖的来源片段，避免删除来源后由关系恢复派生文本。

`findme-understanding-import@2`在同一服务中保存两类通用信息，`@1`行为不变。选择题回答的认识携带`answer_binding`（问题片段、全部选项、所选标签、用户回答片段），正文标为派生概括，证据行说明回答由提问引出；只认同某句描述的回答转为指向该命题的反馈。证据可指向声明的经历，同一经历共用独立组`import:<前缀>:<经历键>`，未指定的保持整批组。问答绑定与经历说明写入`claim_revisions.details`（`personal-understanding@2`），随来源硬删除一并清空；独立组名只含不透明的经历键。不新增列或迁移。

API可预览、原子导入和按Profile读回；namespace固定且不可静默覆盖，重放不恢复被删除内容。这里只实现已有会话快照的结构化保存，不包含自动洞察提取、候选发布、跨快照合并、首页整合或真实模型验证。接口及本地准备命令见[Commands](commands.md#对话与已有理解导入)。


## 18. 个人理解方法资源与上下文准备

应用方法资产位于 `apps/api/resources/personal-understanding/`：`system.md` 保存共同理解边界，十项 `skills/*/SKILL.md` 及各自参考、合成反例承接[个人理解 Agent 设计](implementation/personal-understanding-agent.md)。它们不是开发机器的全局 skills，也不包含私人会话结论。

`apps/api/src/personal-understanding/methods.ts` 只从调用方指定的应用资源绝对路径读取方法，提供元数据目录、正文、按方法限定的参考文件及内容哈希；不搜索 HOME、开发工作目录或全局配置。`context.ts` 按偏好、对话近况、认识索引、本次输入分段准备上下文；只有明确且当前有效、来源仍有效、范围匹配的偏好进入，未声明长期适用的偏好不能成为全局默认。失效或无引用摘要不使用，材料保持数据身份，超出大小上限拒绝而不截断。纠正必选修订和复核，综合或写认识前必选复核。

这些函数是 AG-03 可调用的准备模块，尚未接入 pi、模型、数据库查询或 App；调用者仍须提供已认证且按当前来源资格取得的材料。加载方法不等于模型实际执行该方法；强制选择也不等于已经完成语义复核。合成案例用于后续行为对照，不冒充真实模型或本人效用验收。参考资源按需读取并单独返回版本，后续适配器须记录实际读取版本。运行资源根由后续部署显式提供，构建尚未自动复制方法资产。

对话回应超过同步等待时间时，返回同一操作的处理中状态；后台继续执行，App 只读轮询状态并刷新会话，失败不会自动重发生成请求。原文工具与归档传播跨会话助手引用的完整来源集合；同一 Profile 的相关短事务串行，模型执行不持数据库锁。
