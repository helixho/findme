# FindMe — 当前实现

> 本文只描述源码已有行为与实现限制。功能契约见对应实现文档；未来差距和优先级由 Roadmap 管理。部署状态查询实际平台，测试和交接结果不在此保存。
> 当前 U1–U4 的项目进度、内容状态和剩余顺序统一看 Current Status；本文不再用历史实现段落推断“现在做到哪一步”。
> 赛博分身愿景及[第一阶段个人理解与对话](delivery/phase-1-personal-understanding.md)属于目标基线；个人发展诊断是其中的综合交付形式。本文仅记录已实现行为，现有探索、报告或原型不能据此改称已贯通持续对话、新信息更新、完整分身或本人效用。
> 按 [ADR D23](adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役)，§13 的账号模式是唯一运行真源；§2 Legacy V1、§4–5 与 §9–11 的本机路径冻结，§11.1 的快照只读适配是过渡。独立客户端的后续退役按 [ADR D25](adr.md#d25-直接退役两个独立客户端统一使用-appsapp-浏览器入口)，不扩大到后端和数据；下文 Legacy V1 的客户端描述仅为历史。

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

## 2. Legacy V1 行为

Android/Capacitor 原生包装工程及 APK 构建入口已移除。独立 `apps/web` 与 `apps/miniapp` 已从仓库退役；唯一客户端 `apps/app` 是 React 19 + Vite 浏览器 SPA，手机 H5 与桌面共用代码，保留自身 native/private/diagnostic-preview/dogfood 兼容分支。

旧版已完成第一批源码清理：宿主静态服务器、Node 常驻轮询 worker、heartbeat 写入器及其专属配置已移除；保留 Cloudflare Queue 使用的按任务 ID 领取与消费。Node API 启动不再自动执行旧 seed。客户端删除不扩展到旧 API、Queue、schema、migration、用户数据及仍使用的学习素材。后端 `wrangler.jsonc` 不再绑定旧 Web 静态资产，仅服务既有 API、health、internal 队列；其他路径 404，且不创建数据库连接。独立 `wrangler.app.jsonc` 继续托管 `apps/app/dist`；仓库变更未部署，不代表线上旧页面已退出。

两套 schema 共存不等于数据语义兼容：Core 读取 source_items/claims 等独立对象，尚无将 raw_records/light_extracts/insights 映射为 Core 来源、证据和认识的 adapter。旧 schema 和完整 migration 链保留，避免后续 schema 生成误删旧表，也保留历史资产接入能力。

| 范围 | 源码可见的当前行为 | 可复核位置 |
| --- | --- | --- |
| 原始输入 | 速记、对话、文本导入、答题和阅读反馈写 raw_records | [records.ts](../apps/api/src/routes/records.ts)、[questionnaires.ts](../apps/api/src/routes/questionnaires.ts)、[materials.ts](../apps/api/src/routes/materials.ts) |
| 数据结构 | raw_records、light_extracts、insights、insight_feedback 等结构；来源/内容有 JSONB 扩展，未见个人租户归属字段 | [schema.ts](../packages/db/src/schema.ts) |
| 对话 | 当前消息持久化，history 用于生成回复；并非以完整对话上下文进入轻量抽取 | [records.ts](../apps/api/src/routes/records.ts)、[process.ts](../apps/api/src/tasks/process.ts) |
| 轻量抽取 | 主题、情绪线索、对象、标签、摘录及模型置信度；输入为 content.text | [extract.ts](../apps/api/src/llm/extract.ts)、[process.ts](../apps/api/src/tasks/process.ts) |
| 画像 | 八维加综合画像，分别调用生成后保存一份快照 | [insight.ts](../apps/api/src/llm/insight.ts)、[profile.ts](../apps/api/src/llm/profile.ts) |
| 深析与临时问答 | 深析生成固定字段结果；问答使用同一 buildCorpus，支持三视角描述 | [deepdive.ts](../apps/api/src/llm/deepdive.ts)、[insights.ts](../apps/api/src/routes/insights.ts) |
| 证据回看 | 生成时语料行号映射到真实 record_id，客户端可请求记录摘要 | [evidence.ts](../apps/api/src/llm/evidence.ts)、[records.ts](../apps/api/src/routes/records.ts) |
| 用户反馈 | 支持保存重要洞察、确认/否认/补充及准确性反馈 | [insights.ts](../apps/api/src/routes/insights.ts) |
| 主题回顾 | 对有限窗口内的 topics/tags 计数 | [review.ts](../apps/api/src/routes/review.ts) |
| 学习内容 | repo seed 提供材料与题组；导入脚本从外部 corpus exports 接收内容；反馈回流个人记录 | [import-corpus-seeds.mjs](../scripts/import-corpus-seeds.mjs)、[materials.ts](../apps/api/src/routes/materials.ts) |
| 历史 Web 呈现 | 记录、探索、洞察三类入口，设置单独进入；独立客户端现已退役，不是当前产品能力 | 退役前 `apps/web/src/App.tsx`（未随公开仓库发布） |
| 工程基础 | API、数据库包、共享契约、Web、miniapp 以及异步任务处理资产 | [package.json](../package.json)、[packages/db](../packages/db)、[tasks](../apps/api/src/tasks) |

## 3. 对现有数据链路的精确说明

本节仅说明 legacy V1。新版 Core 的事实以 §1 为准，不将旧版的反馈、窗口和 confidence 限制套用为整个项目现状。

### 3.1 文本导入不是完整的事件/会话导入

`records.ts` 按固定大小和分块上限切分输入。接口接收 text 和批次级 source_meta；切分结果复用这份 metadata，没有逐事件归属、原始时段、引用角色或旧洞察的统一迁移契约。超过分片上限的内容通过 slice 被截断。

这证明的是当前接口行为，不能据此制定用户原始表达长度的业务要求。重导入也不能只因同一任务的重试幂等，就视为已具备来源级去重。

### 3.2 当前语料是最新抽取窗口

`profile.ts` 的 buildCorpus 将 active 原始记录与抽取结果关联，按抽取时间倒序读取有限窗口；生成文本为主题、情绪、对象、证据片段及记录创建日期。不是完整原文检索，也不是跨时间的长期认识库。

同一原始记录的多次抽取可以占用多行，recordCount 为行数；证据 ID 解析虽去重，输入覆盖并未因此自动变成独立事件覆盖。历史导入经当前通用接口形成新记录时，画像时间使用 createdAt，不读取 metadata 中可能存在的原始发生时间。

`insights.ts` 以最新快照的 recordCount 与本次 count 相等作为 up_to_date 判断。由代码可推导：达到窗口上限后，内容换入但数量不变也可能阻止正常更新；这是基于源码的行为推导。

### 3.3 当前溯源不是语义有效性验证

`evidence.ts` 解析并过滤模型返回的行号，可以避免引用不存在于当次集合的 ID；它不核验摘录与原文匹配，也不判断原文是否支持给出的原因解释。

保存洞察接口要求非空 evidence_record_ids，但该要求本身不等于完成了逐论断支持度、来源独立性或多租户归属验证。相关测试使用 fake gateway，证明结构和处理规则，不证明人格准确性。

### 3.4 反馈存在，但未参与画像更新

反馈写入 insight_feedback，acknowledgmentHistory 保留动作，deny 可隐藏洞察。当前 buildCorpus/画像生成路径没有读取这些反馈，也没有将已确认/修订认识作为长期可更新的核心。现有“认/不认”不是新基线要求的认识修订闭环。

### 3.5 当前排除行为不统一

画像语料在 join 时过滤 raw_records.visibility；主题回顾直接读取 light_extracts，未执行相同过滤。证据按 ID 回看有意允许显示历史隐藏记录。隐藏、分析排除、证据保留与删除尚不能当作一套统一的目标生命周期契约。

### 3.6 深析文本不是行动执行闭环

深析要求给出循环、矛盾、建议、挑战等固定字段；源码可生成这些文本，但未见独立 Goal、已接受尝试、结果与复盘状态机。不能把“模型生成行动建议”计为目标 B6 已完整实现。

### 3.7 旧文档中的实现声明需回到源码核对

旧 As-Is 写有“对话保存角色与 prompt 版本快照”，但当前 [records.ts](../apps/api/src/routes/records.ts) 只将用户消息和 role 写入 content/sourceMeta；[dialogue.ts](../apps/api/src/llm/dialogue.ts) 使用后端 ROLE_PROMPT 常量生成回复，未见该入口持久化当次完整 prompt/版本快照。它应回到目标能力与差距，不能从旧正文复制成已完成。

当前 [export.ts](../apps/api/src/routes/export.ts) 返回 raw_records、light_extracts、insights 三类数据，没有读取 insight_feedback 等其他私人对象。因此是现有核心记录 JSON 导出，不足以证明完整个人数据包或用户选择的一页摘要已实现。

当前 [questionnaires.ts](../apps/api/src/routes/questionnaires.ts) 将作答与上下文写入记录，未形成独立版本化测评结果/确定性计分。旧运行与鉴权描述不能替代当前配置和源码。

### 3.8 已有 confidence 字段，不等于已实现分层证据评估

[extract.ts](../apps/api/src/llm/extract.ts) 要求模型报告本次归纳贴合原文的 confidence；[insight.ts](../apps/api/src/llm/insight.ts) 同样接收模型自报数值。[共享契约](../packages/shared/src/records.ts) 校验其为 0–1 数字，[schema.ts](../packages/db/src/schema.ts) 为 light_extracts 保存 confidence。这是已有自评字段和结构校验，不是来源质量、逐认识贡献或概率校准的实现。

[profile.ts](../apps/api/src/llm/profile.ts) 的 buildCorpus 仍按抽取时间取窗口，将主题/情绪/对象/摘录拼接，未依据这些 confidence 做分层评估。[evidence.ts](../apps/api/src/llm/evidence.ts) 仅做行号到记录的映射及去重；[insights.test.ts](../apps/api/test/insights.test.ts) 使用 fake gateway 验证相关结构行为。当前核对的链路未见版本化来源评估、按 ClaimRevision 的贡献评估及其失效传播；模型自评分不代表校准结果。


## 4. AV 本人小批内测（独立 staging）

`apps/api/src/dogfood/`、`apps/api/scripts/av-dogfood.ts` 和 `apps/app/src/Dogfood.tsx` 提供小批历史验证入口。AV 以只读 SQLite 事务接入；仓库外批次保留完整选定原文、固定 split、来源定位、候选片段、人工审核、生成版本与逐请求账本。普通 `role=user` 不直接决定作者和观点，归属和语义判断仍是需要复核的模型候选。

模型输出经原文引用定位和用途资格检查，抽取与生成支持有限预算、checkpoint、显式失败重试；来源更正/排除可以立即使相关候选与认识失效。结构化分析与原文对照使用同一已处理范围及必要指代上下文，未处理范围不伪装成已分析。CLI 默认 dry-run；页面读取不自动调用模型。

当前入口是本机单人 staging，不是 production Core adapter、完整原生跨事件产品或多人服务。正式 Current Understanding 不读取这些候选；后续发布仍须通过 Core 接入与证据规则。Holdout 分组的语义独立性及真实分析准确性需要本人检查，不因程序测试或模型输出合法就宣称通过。命令、副作用与运行配置入口仅由 Commands 维护。

本地内测另有 Codex CLI 适配器，可复用本机 ChatGPT 登录态经 M-X2 同形契约完成结构化抽取和综合；仅 Node 内测入口可选，Worker/API 原出口不变。实际 CLI/model/effort 和可见 usage 留在批次账本；超时、输出/引用校验失败不会发布候选，具体能力与限制见 Commands。


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
主 App 按入口选择 `apps/app/src/api.ts` 的静态/私有 Core 读取或账号 API；`main.tsx` 将合成 `/diagnostic-preview`、小批 `/dogfood` 与正式账号入口分开加载。账号报告与框架代码见 §13–14，本机 U3 受控适配见 §11；页面存在不代表全量 L3 已迁入正式主库或 HUMAN 3.0 原协议已完成。
新取证/复评代码不回写既有 L1–L3；旧结果不因规则改进自动升级为新语义。主题覆盖、基线校正、真实总览/专题/框架及跨页面修订的交付义务见 [整体交付契约](implementation/av-understanding-app-delivery.md)；已有代码、执行结果和仍未完成的部分分别按对应章节与 Current Status 核对，不将早期缺口概括为当前全部未实现。


## 9. U1 整批内容覆盖与去向

`apps/api/src/dogfood/content-coverage.ts` 和 `apps/api/scripts/av-coverage.ts` 复用冻结批次、L1/L2 及现有来源资格检查，对原文区间、逐原子候选、旧分组归纳输入、归纳提名和最终 L3 引用分别对账。相同原消息 UUID/区间与既有 canonical 共同去重，保留所有上游定位；当前排除、失效或分类争议不会被主题归类升级成个人事实。

命名主题从开发集原话样本及整批元数据生成，再对全部可处理开发候选逐项映射；允许多主题、其他、不明确与待复核。尚未分类、已分类但未知、仅作背景、已被旧报告引用分别呈现。主题是可重建索引，不是个人诊断；会话数量不代表独立经历数。

遗漏检查包含原先未采用、不确定、背景/任务材料及已采用对照，按来源多样性选取有界窗口。恢复建议须逐字定位，程序可解析唯一原文位置，不依赖模型准确计算字符偏移；其作者归属与解释仍待复核，不自动写回原 L1。窗口外内容不被宣称已审核，holdout 只做标识与数量对账。

默认不调用模型；live 使用既有隔离 Codex Gateway，固定任务指纹、累计请求预算、限并发、原始输出与逐次 usage。已完成任务复用；失败显式重试；派生版本与进度账本写在源批次之外，输入前后指纹核对。默认盘点与真实语义处理使用不同最新指针，盘点不能覆盖已完成 live 结果。

实际批次结果及剩余问题见 U1 执行记录。U1 不生成新的完整个人基线、不更改旧 L3、不接入真实 App 或完成外部框架；这些仍由 U2–U4 分别验收。


## 10. U2 命题、情境与理解基线

`packages/core/src/understanding-baseline.ts` 与 `apps/api/src/understanding-baseline/` 提供私有U2投影链：核验冻结来源、U1版本和复核overlay；保留全批去向；将指定修复与项目自述候选按命题/用途检查；形成有原文依据的角色、目标、约束、选择、结果等实例和关系，随后生成专题、综合报告及旧认识处置。U2 CLI 当前默认 provider 为 DeepSeek API；Codex 只在显式选择时启用。既有输出目录一旦绑定模型，普通 live 运行遇到不同 provider/model 会在写入前拒绝，不能静默混用或重置当前指针。显式 `provider-migration.json` 可把新阶段绑定到 continuation model：历史 `model` 与已完成 job 保持原 lineage，新 job 使用 continuation model 的独立 fingerprint；migration 内容和 run 中的 migration hash 每次读取/恢复都会重新核验。真实 provider 调用另有 per-invocation `provider-call-cap`，运行层达到上限即停止。对于独立审核已明确指出的局部不支持对象，U2 可生成带来源 audit/hash 的 deterministic-prune job，零调用删除对象而不改写语义文本，后续仍必须重新独立审核。

U1主题按版本化的编辑映射组织成阅读领域，不成为人格维度或本体类。每个领域保留成员与省略记录，仅选定原文及必要上下文进入模型。用途修复的优先取证预算有限，避免新修复的项目背景挤掉原有个人表达；输入集合同时记录选材版本，变动后仅相应专题重新生成。指代不明的材料保留为待澄清导航，不从短确认词生成稳定个人判断；工作材料不自动补齐未覆盖的生活领域。

用途修复为单独overlay，保留旧分类、原始偏移、同源标识和模型来源，不写回原L1。项目中的本人报告可以形成局部report-only命题；命题推导与外部项目事实验证分开。不同命题可共享原句而不增加独立来源，兼容分面与真正作者/立场冲突分别处理。

专题与总览记录支持、挑战和背景，节点/关系的端点、类型、归属、时间与引用经过校验，另起上下文用同一输入做语义复核。整体总览只使用实际提供的原子证据，专题结果用于导航；旧认识逐项保存当前规则下的处置，不改写旧L3文件。方法检查通过不等于本人效用或诊断效度已经成立。

报告传输中的时间规范化单独留存版本及原始输出依赖：字面量“null”还原为空值；精确空串与“/null/”使用独立版本规范化，旧缓存仍按其原处理版本复算。引用跨不同表达时间时不选其中一个时间代表全部；任意时间标签和不存在于引用中的日期仍拒绝。项目背景类型与实体行为主体分开，具体主体和语义由同输入审核检查。用途审核发现明确目标命题不受支持时，可将对应请求降为unknown并再次审核一次，保留原被拒提议与旧用途；不清除全局错误、不把拒绝结果改成通过。

报告级失败审核也可作为未验证的修订线索：显式续接最多生成一版同来源新稿并独立审核，不把旧反馈当事实。成功修订在普通读取或 dry-run 时继续复用，不要求再次开启重试；语义或结构失败后，同一修订指纹不能靠重复命令继续调用。纯 provider transport 失败若没有 raw、候选和 usage，可有界技术重试；Codex CLI 仅 patch 版本变化、model/reasoning effort/adapter 相同时允许 transport migration，并把实际 `runtime_model` 单独留账，不能借机改变语义模型。旧失败与用量保留，当前审核只判断新稿及其实际原文支持。

执行采用全局累计调用预算、分阶段缓存、私有原始输出与字节完整性清单，来源变化会撤销当前指针；失败重试不清零用量或重复已成功阶段。来源绑定目前仍采用全批指纹；同输入的成功检查点复用不等于已经实现单条反馈的依赖级增量更新。实际运行状态见 U2执行记录，配置与副作用仅由 Commands 维护。

U2 产物仍是仓库外结构化候选和可读报告；U2 CLI 本身不接入正式主库或 App，不运行完整 HUMAN 3.0，不宣称精确语义召回或完整生活图谱。U3 对这些产物的主 App 适配见 §11；真实反馈运行、集中验收、U4 框架和云端多端仍按代码计划分别推进。


## 11. U3 主 App 的私有报告与反馈接入

`packages/core/src/understanding-app.ts` 定义报告阅读、精确依据和版本化反馈的传输契约。`apps/api/src/understanding-app/` 提供 Node-only 的受控 repository：只读 U2 全范围指针及制品，重新核对来源/U1/审核依赖；可读候选、尚未完成、没有选中合格证据和指代待解分别返回。失败草稿不进入普通阅读结果，整体报告缺失不由专题摘要拼成新结论。

`apps/app/src/UnderstandingView.tsx` 使用已确认的 B 深墨绿与浅黄绿呈现，主导航为整体认识、专题阅读、纠正与修订。整体摘要优先，完整正文按需展开；专题保留支持/反例/背景、情境节点与关系、未知和问题，关系默认折叠。纠正可以定位具体判断并保留版本绑定草稿；修订历史读取实际前后版本与各版依据，只读展示，缺少内容或修订理由时不补写结论。来源变化会清除已展示及在途依据，失效报告停止展示。旧认识处置、来源管理、显式处理及框架状态保留在次要入口。通过显式私有宿主标记使用同源 API；未启用该模式时保留原生探索流程。私人产物不进入前端静态包，不新建独立合成页面。

回应绑定基线、输入指纹、专题/报告版本与可选判断键，原话先在独立私有状态中保存并返回回执。重复请求幂等，过期目标拒绝；有帮助仅为态度，不作为独立证据。受影响专题与整体理解标为待复核，未涉及专题保留版本；普通读取和保存不调用模型。

显式复评入口将既有专题原文及实际新增回应作为本次输入，旧报告只作修订目标。复用既有 Gateway 和结构/语义审核；新候选通过审核且来源、反馈及目标版本仍有效时，才成为该专题的新可读版本。失败记录与原报告保留。真实 provider 默认关闭，反馈调用默认预算为零；这不是用于继续 U2 生成的新账本。

整体报告重评通过 `dependencies.ts` 绑定当前专题版本和相关反馈进度；复用专题明确引用的原文、反例和背景，专题正文只作导航。已有 U2 合格总览、相关专题已复核且没有待处理专题回应时，才能显式生成并独立审核新的总览；依赖变化后再次标待复核。输入并集超出边界明确拒绝，不静默删证据；U2 尚无总览时不能借 U3 初始化它。总览通过也不代表旧五条处置已再次复核。

`attempts.ts` 将每次生成/审核的预留、任务/阶段、可见模型、原始回包、usage 或缺失值以及失败/中断状态写入同一 U3 状态账本。恢复保留累计次数；失败需要显式恢复，语义拒绝不能靠原样重审变成通过。保存反馈不启动任务，页面按后端返回的能力和剩余额度开放处理动作。

从专题、具体判断或关键问题进入“继续理解”会携带确切上下文和版本，草稿与目标可恢复；全局入口先选择专题，不默认把输入归到第一项。保存原话不推定作者、立场或证据资格，“有帮助”只表达态度。

`qualification.ts` 在显式处理时先对新增回应作有界的归属／命题加工，再以相同原话和分配标识独立审核。精确片段可区分本人表达、第三方引语、项目自述和任务背景；保留立场、范围、完整限定上下文及来源表达时间，不从按钮或词面规则认定本人事实。合格命题进入后续报告生成与审核；同一回应的多个命题共享根来源，不构成独立经历。真正分析后只可作背景、尚未加工和审核拒绝分别记录。

归属加工结果固定原话、目标／问题版本、规则、调用来源与审核依赖；通过的同输入检查点可供报告重试复用，读取时重建精确引用与资格。历史修订仍按其原处理版本核验，不追认为经过了新归属加工。资格审核通过是模型候选的处理状态，不等于本人确认或外部项目事实成立。

`read.ts` 的进程内有界快照缓存复用来源库存、用途与审核解释，同一并发读取共享构建。每次复用仍核对当前来源、制品和指针依赖的字节指纹，指针排序另核对发布时间；读取失败不回退旧快照，返回对象与缓存隔离。首次读取仍需完整构建。共享的 `diagnostic-reasoning/evidence.ts` 与 `dogfood/content-coverage.ts` 使用按来源／消息／会话／片段建立的有序索引替代反复全表扫描；保留首个匹配、重复项顺序、原校验和结果指纹，不减少读取范围或改变证据资格。首次载入与缓存复用性能分别测量，不以索引优化宣称实时响应。

Core 原生探索接入由 `core/report-bridge.ts`、`core/report-source-service.ts` 和注入式 `routes/understanding.ts` 承接。`createApp` 显式传入报告服务且运行态已鉴权时，才开放报告—原生探索双向路径；默认运行态不启用。报告目标经服务端核对版本、判断和问题后保存在既有 `explorations.ext`，不拼入用户原话或支持证据；恢复返回原目标，规划器只把它作为问题上下文。

用户可显式选择探索中的一条合格原始输入送回绑定报告。后端校验租户／主体／探索归属、来源与当前评估版本、排除／更正状态；仅复制实际用户文字，不回传模型结论或生成的选项标签，不截断超限输入。稳定的来源／目标幂等键使响应丢失后的重试复用同一回执，回传保存不等于已加工或已接受。原始 Core 来源标识、事件时间与披露时间分别保留，报告的来源时间使用原始披露时间，不使用事件日期或回传日期。

Node 私有 adapter 只接受明确配置的 Core owner，每次读取、处理和发布均复查复制来源的当前资格。明确的来源排除、删除、替换或指纹变化按根来源和实际修订依赖屏蔽相关专题、总览及历史正文；无关专题保留版本。验证暂不可用、配置缺失、身份或完整性错误仍明确失败，不被自动当作来源退役。

`lifecycle.ts` 与既有 U3 状态共同处理显式退役、受校验的替代来源重绑及受影响专题恢复。操作带生命周期版本、原绑定指纹、原因、身份和幂等键；重绑产生新的待加工回应，不继承旧资格审核。已退役来源恢复可达也不自动重新启用。历史版本入口按当前来源资格回读，失败草稿与被屏蔽正文不进入普通阅读结果；变化理由表示报告修订来源，不自行推断用户发生了人格变化。真实数据库联调、浏览器全流程与运行态启用仍需独立验证。

`apps/api/scripts/understanding-app.ts` 可在显式配置后从本机私有目录向同一主 App 提供接口，仅绑定本机回环地址，不连接正式数据库。该宿主不提供原生 Core 探索，由专题内的上下文回应承接继续理解；正式 runtime 没有因此自动接入文件系统。正式入库、多端账号、真实用户验收和完整 HUMAN 3.0 运行仍未完成。执行与自测结果见 U3 开发记录。


### 11.1 Neon归档的只读适配

`dogfood/processed-archive.ts` 定义加工白名单、去重gzip包、逐层哈希与有界幂等导入事务；两个CLI只离线准备，不自行建表或上传。两张归档表已由 `schema-archive.ts` 与 journal `0012_open_lionheart` 纳管；新库建表与精确旧 DDL 接管、访问策略边界见[迁移方案](delivery/phase-1-migration.md)。`hosted/neon-archive-reader.ts`（`dogfood/neon-archive-reader.ts` 保留兼容导出） 通过既有数据库连接读取指定tenant/subject、namespace、批次哈希及complete状态，限定路径、大小并校验分块/压缩/原文哈希，适用于Worker且没有文件系统依赖。

`understanding-app/archive-runtime.ts` 读取固定的便携报告快照，核对来源归档、报告结构、版本和精确证据引用集合；`routes/archive-understanding.ts` 提供报告、版本、历史和证据GET接口。`cloudflare.ts` 只有配置哈希时才注入，`app.ts` 限定static鉴权且不与NativeReportService混用。它不追踪原来源的实时资格变化，所有POST拒绝为ARCHIVE_READ_ONLY，不提供反馈、处理、Framework或完整sourceLifecycle。此适配与上文Node私有repository是不同实现，不能将其能力互相继承。

主App现有回应表单没有完整的只读能力判定，可能向上述接口提交后才收到403；需要显式能力契约和UI适配。两张归档表已纳入账号分页 export 与 Profile purge；分块使用 bytea hex 并保留哈希，清除先 chunks 后 batches。归档恢复是显式校验/交接，不自动恢复成个人 claims；分页不是原子备份。实际发布及数据范围仅见AV云端执行记录。按 [ADR D23](adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役)，该只读适配是账号模式可用前的过渡，导入核对一致后退役，正式入口、导入等价与实际退役仍须部署验证。

## 12. U4 独立框架的私有运行时

`packages/core/src/framework.ts` 与 `apps/api/src/framework-runtime/` 定义版本化框架、访谈状态、精确作答、语义步骤及独立审核。开始绑定定义内容指纹，原话先保存；一次一个问题，问题数由定义约束。逐域评估与跨域综合分别运行，证据不足保持未知，不把未作答解释成低等级，也不自动写入原生 Current Understanding。

`FrameworkView.tsx` 在同一主 App 提供框架目录、恢复访谈、单题输入、分析状态、更正／排除和报告依据。私有宿主通过同源、同一 owner 鉴权提供 `/api/understanding/frameworks`；不另开端口，不把框架运行伪装成 U2 总览。挂载 FrameworkService 时，主 `/api/understanding` 同步 HUMAN 3.0 的实际运行状态，不再永久显示 `not_run`；框架正文仍只从独立入口读取。模型分析使用明确命名的 U4 累计账本，默认关闭且预算为零；读取及保存回答不自动调用模型。

未保存的框架回答在当前浏览器标签页内按身份、Profile、运行和问题保存草稿；普通导航和保存失败保留文字，成功保存后清除对应草稿。草稿不是服务端已保存回答，也不承诺跨设备同步。

内置 HUMAN 3.0 定义是依据既有 R01/R02 来源整理的中文转述适配草稿，保留四域、逐域访谈、知识／经历／技能、动态命名及发展计划结构，但尚未验证与完整原协议等价，也未完成内容使用与实际效用复核。普通入口不将草稿视作已发布定义；内部运行须显式允许草稿。框架来源概念不是已验证测量结论，完整本人运行仍须实际访谈和独立报告，不能由代码、自测或入口状态替代。


## 13. C2–C4 账号云端运行代码

账号模式通过 `auth/server.ts` 的 Better Auth/pg 具体服务、`auth/account.ts` 服务端 session 校验与 `auth/profiles.ts` 多 Profile 管理接入。默认注册关闭，需配置实际邮件发送回调才可启用；客户端 account 模式在同一 `apps/app` 使用 cookie session、Profile选择、登录/注销/密码重置，不沿用固定 owner 或静态Bearer。

`schema-auth.ts`、`schema-platform.ts`、`schema-diagnostic.ts` 与 `cloud-diagnostic/scope.ts` 分别承接账号凭据、Profile/任务/调用/导入/生命周期、报告/证据/原档及事务作用域。运行/identity/auth 数据库角色分离，scope入口拒绝特权或不正确角色。完整Core子表策略和角色授权在单独的 `access/account-runtime.sql`，不随自动迁移隐式改变现用服务权限。

`CloudProcessingService` 将明确选材后的原话资格生成/独立审核与报告生成/独立审核接入持久化队列。新任务固定来源/政策/model，逐请求先预留预算，保存raw/usage/失败，不自动重试；取消、Profile归档、来源和报告版本变化使迟到结果不能发布。已审核资格与通过阶段可重建复用；普通读取和保存不调用模型。`CloudDiagnosticRepository` 发布入口只给受控队列消费，重新核验raw、审核和源版本后才更新当前head。

云端资格输入保留作者、来源类型、对象、立场、披露时间与事件时间，生成、独立审核及引用核对使用同一来源语义。新规则和输入指纹不复用旧资格检查点；缺少新证明的旧结果需复核，不自动调用模型。当前整体报告读取会检查依赖专题的状态和版本，实质纠正使相关整体认识返回待复核；仅表达“有帮助”不改变依据版本。排队任务在认领前发现依据或处理版本变化时落为 stale 并记录原因，不预留调用或自行重派；用户按新依据明确请求后才能创建新任务。专题重新发布时，只有依赖旧专题版本的在途整体任务失效，终止任务保留历史状态；当前整体认识依据其当前 head 绑定任务判断依赖，在锁定记录后核对最新 head，每份整体报告最多增版一次，已归档记录不恢复。资格证明、检查点复用与发布完整性比较先对原始结果和持久结果应用同一严格结构，避免数据库 JSONB 对象键序变化被误判为内容篡改；内容、类型、未知字段、数组顺序和输入绑定仍按原规则验证。合法检查点恢复不增加调用预算或尝试记录。

account 主 App 与已有报告入口共用 B 方向的品牌标志、配色、桌面阅读分栏和手机底部导航。整体认识只读取当前已审核报告，缺失时不拼接专题伪造总览；专题与纠正修订复用现有诊断 API。账号纠正绑定整份报告版本，不伪装成接口尚未支持的单条判断绑定；保存只显示待核验，处理仍须单独确认用途与调用范围。历史报告只读，版本对照使用实际可读报告；账号历史依据缺少按版本接口时不混用当前依据。资料切换与账号恢复按请求序号隔离迟到结果。资料、独立框架、知识与专项入口保留；新增知识与专项入口的源码边界见 §14。Core 的 continue/correct 在显式配置 `CORE_MODEL_DAILY_OPERATION_LIMIT` 且推理总开关打开时由 `routes/account-core-model.ts` 承接：读写各用短 Profile 事务，模型调用不在事务内，滚动 24 小时操作上限超出时不调用模型；未配置时保持 503。主 App 账号版新增“对话”入口（`apps/app/src/cloud/ConversationView.tsx`）。其余原生 Core 来源操作沿用事务 scope 并通知云端依赖失效，账号诊断不通过本机 JSON 提供正式真源。已有 private/static 主 App 及 NativeReportService 接口作为兼容路径保留，没有自动混用或退役。

`BlobStore` 的 R2 实现处理原档声明、流式有界上传、校验、鉴权下载、删除和恢复；对象副作用不持有数据库事务。`CoreIngestService` 提供预览/明确提交，精确EvidencePacket与个人导出可转换为待核来源；源定位、root、作者/对象/立场和时间保留，holdout不进入模型，历史报告不自动成为accepted。

取消后新的明确处理请求创建替代任务，响应丢失后重试仍复用该次任务；Profile 累计用量不因替代任务清零。任务额度耗尽后，可在服务端上限及 Profile 余量内显式提高任务累计上限继续；语义拒绝或损坏的证明仍需新依据。资格复用会逐个重建匹配问题、领域、规则及完整来源快照的已有证明，不被较新无关证明遮挡。

`CloudLifecycleService` 处理来源排除/恢复、替代绑定和删除；`effects.ts` 使相关报告/任务失效并清理原话复制与派生缓存。`ProfilePurgeService` 分步清理数据库/对象并支持继续未完成清理，保留账号身份和纯累计费用计数。来源生命周期操作分别处理历史修订与当前 head：仅历史依赖变化不撤下无关的当前报告，归档状态保留；软失效只改变相关在途任务，硬删除仍清除历史原话载荷。报告读取与显式处理共用有效性检查；待复核报告可以明确重建，纠正和发布按同一 Profile 串行核对。

Core 来源评估和账号来源排除/恢复/重绑共用 `core/source-invalidation.ts` 的当前认识失效传播。有效支持同时检查当前资格与来源仍为 active；有其他合格支持时标 stale，没有时标 invalid，均退出有效 Current Understanding；保留原文、当前版本身份和 superseded 历史，无关认识不变。恢复来源不自动重新发布旧认识，重绑不继承旧资格。来源变更先按固定顺序锁定相关探索，再核对来源/评估版本，与原生输入更正的锁序一致；活跃探索版本改变使旧生成不能发布。硬删除仍由独立分支撤回并清理相关当前/历史正文，不与软排除统一成同一终态。账号 Core 的 HTTP wrapper 只继续传播云端报告依赖，不重复执行 Core 认识失效。

`CloudExportService` 以固定清单分页输出个人持有数据，凭据不导出，原档单独鉴权下载；分页数据包不是原子数据库备份。导出恢复保留已知对象、立场、作者、时间和来源排除状态，在新导入 namespace 下保留共享根关系；缺失旧元数据为 unknown，非法已知值拒绝。恢复仅产生待核验来源，不继承旧资格、报告或旧 Profile 的 target_context。

FrameworkService/FrameworkView复用现有独立协议，以PostgresFrameworkRepository保存每个Profile的直接作答、审核/结果与历史。HUMAN 3.0仍为draft，内容协议正式化和本人访谈未因云端代码而完成。

Node与Cloudflare组合只在显式account配置下启用；既有运行配置保持原样。本地合成及临时数据库行为验证范围见后续维护记录；实际资源、生产角色/迁移、邮件、队列/R2 与真实模型组合仍须分别验证。详见 [C系列实现契约](implementation/c-series-cloud-runtime.md) 与 `deployment/`。


### C 系列最小验证后的实现修正

账号中间件以Hono Context保存请求级已验证身份，避免bodyLimit替换Request后丢失principal；请求结束即清除。账号health复用runtime权限门禁，不要求业务账号访问旧版全局任务。访问脚本对管理型PostgreSQL采用角色属性核验而非提权ALTER；tenant/membership锁定读取使用相同scope的policy和受限列授权。执行与剩余验证范围见 `execution/c-series-activation.md`，这些实现修正不代表真实推理或生产迁移完成。

## 14. 知识加工与专项路径的账号模式代码

账号模式新增 `/api/knowledge`：用户固定来源范围后，从已有且当前有效的个人 ClaimRevision 与 EvidenceSpan 形成专题版本，区分支持、反例、背景、来源去向和缺口。同源派生材料按根来源与既有事件组去重；事实更正、解释异议、时间变化和效用意见分别保存。当前读取会复核来源与认识资格，并检查同一 Profile 其他专题尚未解决的纠正，相关旧判断不继续作为当前结论。它尚不能从普通新来源自动形成命题，也没有完成跨专题新判断的总览合成。实现见 [knowledge-processing](../apps/api/src/knowledge-processing/service.ts) 与[契约](../packages/core/src/knowledge-processing.ts)。

专题整理和报告处理的来源选择读取完整分页并显示可选总数与已选数。新专题请求在结果未确认时保留专题身份、原请求和幂等键，页面切换或刷新后可重试同一次整理。

`/api/content` 读取仓库内版本化、经审核的内容卡；当前清单有《新世界》（A New Earth）的有限作品提问和 NICE NG87 环境调整候选。新请求只选当前已发布版本，撤回或草稿不进入新选择；历史版本按原版本保留。作品回应只在本次请求回显，不持久化，也不从作品推断个人事实。实现见[内容目录](../apps/api/src/content/catalog.ts)与[作品视角](../apps/api/src/content/reflection.ts)。

`/api/specialist` 在当前 Profile 保存自愿选择的通用或 ADHD 相关情境，诊断自报与实际困难分栏。已保存的专项情境可在同一会话中继续补全场景、困难等信息，写入核对版本并重新读取候选；既有建议和尝试仍保留其形成时的依据。方法候选须同时匹配本人选择的情境类别和已发布内容；建议固定个人与内容依据、负担、代价和未知，只有本人确认才形成 ActionTrial。拒绝、暂停、未执行与效果未知都是合法状态。回顾保存为有 Trial 血缘的个人来源；本人可显式关联已有认识，实际执行后该认识标为待复核，不自动生成修订后的结论。实现见[专项路由](../apps/api/src/routes/specialist.ts)与[App 入口](../apps/app/src/SpecialistView.tsx)。

框架运行时现在可逐题跳过、暂停、恢复，并把输入不足保留为 unknown；HUMAN 3.0 定义仍是 draft，不等同原协议正式版。上述新增表有 `0011_specialist.sql` 迁移及账号作用域策略；实际迁移、运行和产品接受状态统一看 Current Status。


## 维护后的源码职责入口

`core/exploration-service.ts` 保留原调用入口，读取、规划、修订、持久化、视图、上下文与校验分至同目录 `exploration-*.ts`；`packages/core/src/diagnostic-validation.ts` 承接诊断校验。`cloud-diagnostic/repository.ts` 继续作兼容入口，来源/证据、报告读取、回应接收、发布、锁与版本操作分别定位到 `evidence.ts`、`report-reading.ts`、`response-intake.ts`、`publication.ts`、`repository-state.ts`，任务纯决策在 `processing-policy.ts`。

`knowledge-processing/service.ts` 保留服务导出，读取视图、反馈、专题加工、依据与持久化分到同目录模块；`routes/specialist.ts` 处理 HTTP 适配，专项业务与仓储在 `specialist/`。私有 `understanding-app/repository.ts` 分离反馈、作业与辅助操作，保留原恢复与存储契约。结构分离不改变领域语义，也不代表完整集成已验证；实际证据见后续维护记录。

`framework-runtime/schema.ts` 定义不含文件 IO 的状态契约；`private-repository.ts` 承接本机文件存储，旧 `state.ts` 兼容导出二者。云端适配直接读取 schema。`shared/primitives.ts` 与 `domain/understanding/` 承接共享纯规则，`runtime-boundaries.test.ts` 从 hosted/cloud 入口检查值导入图，防止再次引入冻结流水线或私有文件 IO。Core/Shared 包入口显式导出，保留已有公开面兼容。

当前策略的只读查询见[策略与处理血缘](implementation/c-series-cloud-runtime.md#7-策略和处理血缘)。注册信息不参与旧记录的读取资格判定，不将不同对象状态合并成统一枚举。

## 维护后的入口与验证落点

`apps/app/src/App.tsx` 保留默认入口，native/private 行为分到 `src/native/`；独立旧 Web 壳及其 legacy 视图/状态随客户端退役。这不是新产品路径或 UI 重设计，账号 CloudWorkspace 仍是正式入口。冻结批处理的注册、修复、专题、审核、重放和发布按职责组织，原导出/预算/历史恢复保留。

仓库引用核对由 `scripts/check-repository.mjs` 提供；App native/private 兼容入口浏览器运行器为 `scripts/test-maintenance-browser.mjs`，使用独立临时构建，不覆盖正式账号产物。Zod 3 补丁保留；实际无父依赖的 override 与 Taro 4 补丁随依赖退出清理，最终数量与测试/CI 结果由本轮执行记录确认，不沿用旧维护快照。
