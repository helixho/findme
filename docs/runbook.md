# FindMe — 运行、部署与恢复规程

这是现有路径的操作索引，不是账号模式已部署声明。当前状态看 Current Status，目标配置看根目录 Wrangler 文件及 [deployment](../deployment/README.md)，执行记录按每次实际操作另存。旧日志里的域名、版本与资源状态均须在操作时重新读取。

## 1. 先识别对象

| 对象 | 源码入口 | 不能混用 |
| --- | --- | --- |
| API Worker（仓库已移除旧 Web 资产绑定，线上未切换） | `wrangler.jsonc`、`apps/api/src/cloudflare.ts` | 源码 main 与线上最小补丁不是同一个发布包；不能从历史部署 ID 推断当前 Git 版本 |
| 目标 App 静态资源 | `wrangler.app.jsonc`、`apps/app` | 静态资源 Worker 不要求虚构一个 main；前端成功不等于账号 API、数据库和模型可用 |
| 账号数据与异步处理 | `deployment/README.md`、schema/migrations、账号访问策略 | 生产库与测试库、代码回滚与数据恢复分开。本人已决定不恢复原欠费 Neon |
| 既有归档 / 冻结本机路径 | ADR D23、归档及 U2/U3 执行记录 | 冻结不等于删除；未经迁入对账和正式入口读取验收，不停掉唯一可读路径 |

## 2. 开发验证与故障定位

依赖与合成预览见[开发环境](implementation/development-environment.md)，测试分组见[测试计划](delivery/phase-1-test-plan.md)。数据库测试由 `pnpm test:db` 自行准备临时 PostgreSQL，不使用生产配置。

遇到失败，先区分环境准备、接口/状态行为、模型输出和用户效用。测试命令失败先看实际退出阶段：Docker/连接/迁移/角色准备失败不算产品用例失败；部分用例未运行不算通过。局部复测使用文件筛选，不调整断言以迁就错误。

账号页面不可用时，按客户端构建/实际 API 地址 → 鉴权/Profile → 数据库与 schema → 报告/来源状态 → 队列/provider 的顺序检查。读取和保存正常不证明推理已启用；已有报告不可读时先核对版本与来源，不以重新调用模型掩盖问题。

## 3. 发布

只有明确发布任务才执行本节；普通源码修复和 main push 不包含发布。

发布前记录：实际目标账号、Worker、数据库、现有活动版本、候选提交、相关构建与测试结果、必要 schema/角色/绑定及需要保留的开关。账号运行资源与真实导入方案未确定时，不把历史配置当作就绪模板。

API 使用现有 `pnpm cf:deploy`，App 使用 `pnpm app:deploy`；两者分别核对目标配置，不能互相代替。构建前明确所需鉴权模式与 API base。数据库迁移、资料导入、对象存储及推理启用分别判断其影响，不随客户端发布隐式执行。

发布后核对实际生效版本和流量、健康接口、登录/所选 Profile、当前报告与依据、一次保存及恢复。迁移/推理/真实资料不在本次发布范围时明确未测，不制造通过。仅静态页面 200 不算产品可用。

## 4. 回滚与数据恢复

回滚候选必须与当前 schema、绑定和数据兼容；使用操作时核实的可用版本，不把旧执行记录中的 ID 硬编码进新命令。回滚前后分别记录活动版本及实际行为。API 与 App 按实际故障分开回滚，不能默认同时退回。

**必须保留 scheduled 默认关闭保护。** 停用修复记录说明旧版本可能缺少入口 guard；盲退旧版会重新连接停用的数据库。目标版本没有 guard 时，不能直接作为当前停用状态的回滚方案。

Worker 回滚不撤销数据库迁移，也不恢复已删除原文。需要数据恢复时先核对真实备份存在、范围、时间与 schema，在独立目标验证后再决定切换；不能把历史废纸篓路径或归档传输成功当完整备份。真实迁移设计仍待可用运行依赖确定，不由本规程补造。

## 5. 保持停用与恢复

`FINDME_SCHEDULED_ENABLED` 只有精确值 `"1"` 才开启；仓库 cron 保持为空。停用状态应同时核对代码 guard、实际 schedules 和真实事件；仅清空 schedules 不能证明旧事件不会再投递。

此开关只管 scheduled，不管 HTTP 或 Queue。不要让 Queue consumer 直接成功返回来“暂停”，这可能确认消息；需要暂停消费时使用明确的队列操作和恢复方案。数据库、推理、队列与定时分别恢复，不能改一个开关就声称全部可用。原 Neon 保持不恢复。

每次操作的证据写 `docs/execution/`：候选与目标、执行动作、实际结果、失败/未测项、后续可恢复状态；不重复维护秘密值或私人正文。

## 6. 备份与恢复的现有脚本

只在具体数据操作已授权时执行，本文不主动备份、不恢复原欠费 Neon。脚本不会加载 `.env`，显式向进程传参；不要把连接串写进日志。

`bash scripts/backup.sh` 使用 BACKUP_DATABASE_URL → DATABASE_URL_MIGRATION → DATABASE_URL_UNPOOLED → DATABASE_URL 的优先级；使用可直连的 PostgreSQL URL，不能用 Hyperdrive。BACKUP_DIR 决定输出目录（默认 ./backups）；依赖 pg_dump、gzip。存在 ./uploads 时另打包；可选 BACKUP_AGE_RECIPIENT 用 age 加密数据库包，不加密 uploads 包。它不自动备份 R2、平台配置、登录角色或仓库外材料，不能称完整系统恢复点。pg_dump 角色可见范围也决定备份范围。

`RESTORE_DATABASE_URL=目标直连串 bash scripts/restore.sh /绝对路径/db-时间.sql.gz` 依赖 psql/gunzip，预检非系统对象和自建 schema，默认拒绝非空目标，并要求输入 yes。RESTORE_FORCE=1 绕开空库保护可能部分重放、混合旧数据，不作常规恢复方式。age 文件需先在私人目录解密为脚本支持的 gzip；uploads 与 R2 均须单独核对和恢复，不能将数据库恢复成功等同原档往返通过。

先在独立空目标检查解压/重放、schema/journal、角色成员与 RLS、Profile 读取、来源哈希与引用、保存/重进，以及原档可读性；记录未包含对象和恢复时间点。脚本 ON_ERROR_STOP 停止不意味着整份恢复原子回滚，失败目标不能直接投入使用。实际切换依赖与停用旧目标须按具体授权执行，应用回滚不能恢复删除的原文。

## 7. 健康与 degraded

`apps/api/src/health.ts` 提供两类检查：legacy 检查 DB 与 async_tasks 的 duePending/staleRunning/最近失败；account 检查 DB 和 runtime_role，不枚举旧全局队列，detail.queue=account_scoped_not_enumerated。`/health` 与 `/api/health` 的 JSON status 才是结果，默认 HTTP 200 或静态首页 200 不表示健康；health 也不覆盖 identity/auth、R2、真实模型和实际消息投递。

发现 degraded：先识别实际模式、候选与目标，再核对 DB 连接/迁移/角色（account 的 runtime_role 失败尤其检查 BYPASSRLS/所有者/成员关系），之后查相应任务的租约、错误和可恢复状态。legacy 的 database_unavailable/task_state_unavailable 不用恢复已停用库来“消红”；按当前停用决定记录为不可用。已保存输入先查回执和幂等状态，避免重复发送或触发付费任务。

单人使用时在发布后、遇故障或恢复前检查即可；不新增值班团队或告警平台。记录观察时间、目标、模式、检查项与影响，隐藏私人正文/凭据；恢复后验证同一失败路径的实际往返。队列投递和真实 provider 的验证另行执行。
