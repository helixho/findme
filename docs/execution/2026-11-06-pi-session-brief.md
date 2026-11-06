# pi＋数据库会话＋原文优先：执行 brief（供 Opus 审阅）

## 审阅结论的范围

本批是设计更新与第一批可独立验证的实现，基于 `eb04597`。不是 AG-03/AG-07b 已全部完成，也没有将在线 App 切换到 pi。请审核下面的代码与边界，不把合成测试通过当作交流准确度与深度已通过。

已确定路线：产品支持持续多会话；pi 会话可以持久化，是数据库归档的来源之一，与测试、评论及导入并存。数据库统一来源身份、资格与修订。原文优先；长期抽取与蒸馏不是聊天前置。已有数据、认识及纠正/停用能力保留。运行和验收都在 Instabox；调用真实模型之前另给题目与费用上限。

## 已落地

| 对象 | 实现与边界 |
| --- | --- |
| 设计及计划 | AA、DA、TA、Agent 设计、工作计划、原主链契约与 ADR D32 对齐；当前 session → 历史原文 → 可选已有认识，保留 A/B/C/D 对照及 MemPalace 候选 |
| pi SDK | 锁定 `@earendil-works/pi-coding-agent` / `pi-ai` 1.5.0；显式资源加载，不发现开发环境规则或默认编码工具；完整 AgentSession，工具注入、可见事件、取消、恢复与手动压缩 |
| 请求边界 | 每个会话独立包装 ModelRuntime 的生成出口，发送前必须调用宿主 reserve；本地请求硬上限；自动重试和自动压缩关闭。手动压缩经过同一边界。未实现生产金额账本 |
| 记录 | 提供 record 回调，记录 pi 模型出口 context 与可见返回；过滤凭据字段及 thinking。不是 provider 最终 HTTP 请求体，也没有把回调接到在线请求存储 |
| pi 来源归档 | 新增 `pi_session_archives`，Profile＋产品会话＋pi session＋revision；稳定序列化指纹、幂等、版本冲突检测、来源依赖核验、会话条目与 leaf 校验；来源排除/删除清空依赖归档正文；纳入导出与 Profile 清理 |
| 原生会话读取 | 新增 NativeConversationReader，限定 Profile，保留长消息、角色和短答背景，可分页读原生 App 会话。存在失效来源时保守隐藏该线程的助手上下文，避免间接带回旧内容 |
| App 普通聊天 | reply 判断新信息后不再自动 continue；消息保存和回应照常。显式更新认识、作答、纠正、停用不删除 |

### 主要代码入口

- [pi 执行适配](../../apps/api/src/personal-understanding/pi-runtime.ts)
- [归档数据库适配](../../apps/api/src/personal-understanding/pi-archive.ts)
- [原生会话读取](../../apps/api/src/personal-understanding/native-conversations.ts)
- [App 对话](../../apps/app/src/cloud/ConversationView.tsx)
- [来源失效传播](../../apps/api/src/cloud-diagnostic/effects.ts)
- [升级脚本](../../packages/db/migrations/0001-pi-session-archives.sql)
- [设计](../implementation/personal-understanding-agent.md)、[工作计划](../delivery/agent-work-plan.md)

## 实际验证

全部运行验证在 Instabox 的独立临时源码目录完成，数据库测试用专门创建并清理的一次性 PostgreSQL 17，不连接在用库。真实模型请求为 0。

| 验证 | 结果 |
| --- | --- |
| pi runtime 合成测试 | 9 项通过：恢复、拒绝预算不发送、身份不匹配、共享 runtime 并发隔离、工具往返、请求硬门、手动压缩同门、记录失败、凭据/thinking过滤 |
| pi archive | 3 项通过：JSONB稳定指纹；幂等/CAS/Profile隔离/排除清空；无效会话格式在写库前拒绝 |
| 原生会话读取 | 1 项通过：1500字以上原文、短答、分页、跨Profile拒绝及失效传播 |
| 既有来源与生命周期回归 | `archive-lifecycle-postgres` 3 项、`personal-sources-postgres` 1 项通过 |
| 导出恢复静态契约 | `export-restore-continuity` 24 项通过，不代表新增pi归档已经完成跨实例导出再导入 |
| 浏览器合成回归 | 桌面/手机共8项通过：不自动综合但允许手动更新，单条纠正保持其他认识、处理中纠正状态、回复失败仍按回复重试 |
| 类型与构建 | API TypeScript检查、App构建通过 |
| 全仓 lint | 未通过：基线 `eb04597` 已有 `apps/app/test/cloud-api.test.ts:155` 非空断言；本批未改该文件，不能声称全仓质量检查通过 |
| 独立代码审核 | 未发现本批已落地模块的阻断；原生会话分页效率列为次要项 |

首轮数据库测试发现 JSONB 重排对象字段导致归档恢复误报损坏，已改为递归对象键排序、数组保序的指纹并回归通过。未降低校验标准。

复现入口（在 Instabox 的独立检出运行，不能在在用目录启动测试服务）：

```sh
pnpm test:local personal-understanding-pi-runtime
pnpm test:db personal-understanding-pi-archive personal-understanding-native-conversations archive-lifecycle personal-sources
pnpm test:local export-restore-continuity
```

浏览器使用既有 `apps/app/e2e/playwright.config.ts`，选测 `new facts remain in chat`、`correcting one claim`、`a correction still`、`a first message whose reply failed`；先按账户合成测试环境构建 App。

## 必须明确的未完成项

1. 在线 `/reply` 仍走原实现，尚未将 pi、来源归档和原文工具串成完整产品请求。本批不能证明生产持续会话已由 pi 承载。
2. SDK 的 reserve/record 是强制接口，但生产金额预留、结算、完整模型输入存储和断线恢复仍需接入；仅有 maxRequests 不能宣称费用金额已受控。
3. 归档依赖必须覆盖提供给模型的全部个人材料、工具读取和认识对应来源。当前数据库适配验证“传入的依赖”，不自动发现漏传来源；接线时必须统一收集，不能依赖模型自己申报。
4. 当前支持完整快照修订与恢复，不等于已实现 pi 文件实时增量归档、条目级发布成个人证据或所有外部来源导入。助手/工具条目不能自动成为本人自述。
5. 手动压缩有执行入口和费用边界测试，尚无长会话真实压缩质量验证，自动压缩尚未打开。
6. NativeConversationReader 仍先读取线程再分页，数据库正文读取不受分页数量限制；长会话性能优化待接线时处理。资格变化时保守隐藏整段助手上下文，尚未细化到逐条依赖。
7. AG-02a 的他人未提交文件未修改、未暂存、未纳入测试副本；本批不宣称其关键词检索或导入会话工具已部署可用。
8. 新表的既有实例升级尚未执行。部署脚本会执行新迁移；生产部署必须作为后续明确动作，不能直接只替换代码跳过迁移。

## 下一批执行顺序（请 Opus 重点审阅）

1. 完成生产模型出口与请求记录持久化，包括取消/失败后的输入保存；按实际请求计费，明确最大输出与输入预算。
2. 将已保存的本人输入、pi 会话、数据库快照与来源依赖串联；同一会话提交串行、跨会话隔离；避免另一会话的并发修改被旧快照覆盖。
3. 接入原生及导入原文工具和方法资源，补足邻近问答与后续纠正展开；配置受控长会话压缩。
4. 先完成零模型完整往返，再提出部署及真实测试题目/费用上限。首次真实题覆盖长会话早期纠正、恢复旧session、同义表达跨session、支持与反例、短答/转述归属。不得沿用之前已用尽的测试额度。
5. 固定模型做A/B/C材料对照及B/D取证方式对照。出现原文召回缺口后再比较MemPalace；暂不安装Letta、OV或TencentDB。

本 brief 请求审阅实现边界及下一批接线方案，不申请启用模型或生产迁移。原始个人材料、实例访问凭据及私人问题分析不进入本文件。
