# C2–C4 云端账号与持续诊断 — 实现契约

> 当前源码实现范围，不是部署或验证声明。业务与语义真源仍为 BA/AA/DA；不因本文件存在执行测试、模型调用、SQL、数据迁移或服务切换。账号模式是唯一运行真源（[ADR D23](../adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役)）；本契约复用 U3/U4 的资格／审核契约，不依赖 U2 内容完成。

## 1. C2：账号、Profile 与权威数据

`auth/server.ts` 通过 Better Auth 的 PostgreSQL/pg Pool 适配器提供 email/password、验证邮件、密码重置与注销。注册默认关闭；开启注册必须配置邮件发送接口。服务端会话解析关闭 cookie session cache，业务 principal 只来自服务端认证。认证库角色、identity 库角色和业务运行角色分离；不把原有固定 Bearer/单口令视为分发账号。

账号 principal 取 issuer 与 user.id，不用 session.id、客户端 owner 或设备标识。首次绑定在短事务内按 principal 加事务级锁建立 tenant/self/binding，已有绑定必须指向有效 self 和 active tenant；事务内不调用模型。旧版无租户隔离的 records/insights/review/questionnaires/materials/export 路由在账号模式不挂载，写请求要求受信任 Origin，响应不缓存。

诊断表区分运行版本、报告内容版本与生成依据版本；证据引用同时绑定 Core source、span 和 assessment version，精确位置使用 UTF-16 start/end，`whole_source=true` 要求原文全文相等，不以任意子串匹配代替定位。

`ProfileService` 将账号绑定到默认 self，并支持创建多个彼此独立的个人 Profile、改名、归档和恢复。每个 Profile 有独立 tenant/self；服务端核对 `X-FindMe-Profile` 的 membership，不信任浏览器提交 owner。归档阻断后续处理，恢复不自动续跑模型。

`withProfileTransaction` 核验运行角色非 SUPERUSER/BYPASSRLS/保护表所有者、非 identity/auth 联合角色；事务内设置 tenant/subject，上锁检查 Profile 与删除状态。新平台表使用复合外键及 RLS，完整 Core 子表访问策略在显式 `packages/db/access/account-runtime.sql`。访问策略不在自动迁移 journal，必须与运行账号切换一起审阅。

`source_blobs` 通过 `BlobStore` / R2 binding 承接原档元数据与对象；声明、上传、校验、删除待完成、删除和恢复分开。上传校验 SHA-256 与字节长度，下载只经已鉴权、当前 Profile 的对象 ID；不把对象键作为前端权限。对象操作在数据库事务外，失败不伪装跨系统原子提交。

## 2. C3：从原话到持续报告

业务主路径：账号/选定 Profile → 创建问题 → 原话先入库 → 查看处理范围 → 用户确认最多请求数 → durable queue → 命题资格生成与独立审核 → 报告生成与独立审核 → 发布新版本 → 同账号多端读取。

`CloudProcessingService` 和 `cloud_diagnostic_jobs/attempts/budgets` 固定输入、源码政策／prompt／model、来源版本、任务 epoch 和调用上限。客户端 process 只落库/排队；模型只由队列消费者运行。第一次遇到未加工来源最多需要资格生成、资格审核、报告生成、报告审核四阶段；已有合格来源按原始 raw/审核重建后可复用。阶段结果持久化，恢复不清零已用次数。队列重复投递不重领已运行任务；技术失败必须显式恢复，语义拒绝需要新依据。

付费处理默认关闭，Profile 累计预算默认0；每个任务同时受服务端上限、用户确认的当次任务总 cap、Profile 累计 cap 约束。每次真正请求之前事务预留次数，原始输出、usage/缺失值、可见 model、延迟与错误类别独立记录。读取、保存、导入、导出、Profile 切换不调用模型；定时任务不启动云端诊断或自动探测 provider。

资格复用来自 U3 的原话片段与命题审核，不把用户选择“补充经历”当作本人事实。来源根 ID、引语作者、谈论对象、立场、披露/事件时间、project report-only 用途分别保留。旧报告只作为纠正对象的上下文，不变成新的支持证据。原文变更、排除、Profile 归档或用户取消后，迟到结果不能发布。

`CloudDiagnosticRepository` 承接创建、幂等回应、当前报告、版本历史、精确引用、候选写入和审核后 accepted publication。发布核对原始 generation/audit、输入摘要、来源资格和当前任务 epoch；候选不能直接成为当前报告。overall 只消费显式选择的已通过专题及其原始证据，专题变更使对应 overall 待复核。

处理输入目前有明确有界限制：最多8个选定来源，资格输入仍受既有 U3 字节上限；超限会明确阻塞，不无声截断。该限制是当前实现边界，不宣称适合任意规模的全库综合。

同一 `apps/app` 在 account 模式下启用 CloudWorkspace，不再通过本机 JSON 读取真实报告；private/static 模式保留原路径，未自动切换。账号界面提供诊断专题、报告、依据、补充/纠正、处理确认/停止/恢复、历史、资料和独立框架；新增的个人知识专题、作品视角与尝试入口由[知识与专项路径契约](knowledge-and-specialized-paths.md)定义。浏览器 cookie session 与 Profile scope 共同取数；Profile 切换丢弃迟到读取，草稿/幂等键按账号与 Profile 分开。

## 3. 独立框架的云端状态

FrameworkService 和 FrameworkView 沿用现有协议实现，替换为 PostgresFrameworkRepository，状态按 Profile 保存，包含直接作答、结果和历史。HUMAN 3.0 仍是明确标识的 draft，普通运行不自动开放。框架 continue 另需用户确认最多2次请求，并受独立框架累计 cap 约束。云端持久化不等于原协议内容正式化或本人访谈完成。

## 4. C4：输入迁入、持续失效与数据控制

导入严格分为准备 → 预览 → 明确确认 → 提交。CoreImportEnvelope 保留来源 ID/版本/根身份、原话、作者/对象/立场、披露/事件时间和精确 UTF-16 spans；namespace+source+version 用于幂等。原始标签只保存为待核输入，历史模型报告只作为候选归档，不自动升级 current。holdout 原文不进入正式处理边界。

`prepareEvidencePacketImport` 复用现有精确 EvidencePacket 的来源与位置，输出有界导入分片；缺失披露时间明确略过，blocked range 不被整句升级。CLI 只在显式调用时转换指定文件，拒绝把私人输出写进仓库。个人导出恢复也先转为待审核来源，不恢复密码/会话、自动报告真值或付费任务。

来源排除/恢复、替代来源重绑和删除都带前置版本/摘要与幂等键；报告/任务按来源依赖失效。恢复来源意味着重新取得使用资格，不自动继承旧审核。删除清除原话及依赖正文/缓存，单独托管的原档有独立删除入口。

完整 Profile 数据清理是单独的强确认操作：先设置 deletion 状态并阻断新处理，清除对象后再清理关联数据库记录；对象失败保留可恢复任务。保留账号/Profile 身份和纯累计费用计数，不保留个人正文来维持账本。已删除原文不可由软件恢复，备份恢复属于另行授权的操作流程。

导出有固定对象覆盖清单和分页，包含 sources、assessments、evidence、Core exploration/claim/feedback/operation、诊断/依赖/回应/任务、框架、个人知识专题、建议与尝试、导入和对象元数据。认证凭据不导出，未托管原件明确说明；原档走单独受控下载。分页导出不是跨页原子数据库备份，也不能追回用户已下载的副本。

## 5. 运行组合与本轮未执行

Node 与既有 Cloudflare Worker 都有显式 account 组合；Cloudflare 的独立身份/auth Hyperdrive、队列、R2 与 Secrets 需要后续配置。示例见 `deployment/`。现有 wrangler 配置未改，不会因提交启用账号模式或花费模型额度。

可重复的验证入口见[测试计划](../delivery/phase-1-test-plan.md)；部署见[单节点部署](../../deployment/standalone/README.md)。

官方实现参考：Better Auth PostgreSQL https://better-auth.com/docs/adapters/postgresql 、账号选项 https://better-auth.com/docs/reference/options 、PostgreSQL RLS https://www.postgresql.org/docs/17/ddl-rowsecurity.html 、R2 Workers API https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ 。这些参考不证明本仓库实现已经运行通过。

## 6. 路由、鉴权与失败定位图

本节以 `apps/api/src/app.ts` 的组合为准，不平行抄写数据库 schema；物理表与迁移见 `packages/db/src/schema-*.ts` 和 迁移方案。

| API 族 | 挂载与作用域 | 写入/幂等与失败定位 |
| --- | --- | --- |
| `/api/auth/*` | `auth/server.ts`、`auth/account.ts`；BetterAuth session | user/session/account/verification/rateLimit 的 modelName 指向 auth_* 表；迁移负责建表，不因 TS 标识符零引用删表 |
| `/api/profiles` | account + cloud；principal → Profile | create 要 Idempotency-Key；update 按路由输入校验，不能声称所有写操作都使用同一幂等协议 |
| `/api/core/*` | account 使用 `withProfileTransaction`；其他宿主使用自身 principal | 来源、探索操作及报告桥分别使用对应机器契约；报告桥见[单次探索契约](t1-purposeful-exploration.md#报告目标回传与来源重绑) |
| `/api/diagnostics/*` | account；`X-FindMe-Profile` 解析上下文；未提供 cloud 时只具备仓储能力 | create/responses 要 Idempotency-Key；process plan/enqueue/checkpoint/cancel 使用处理服务输入绑定；读与保存不排队推理 |
| `/api/data/*`、`/api/blobs/*` | account + cloud；Profile scope | 来源 action/rebind、清理与 blob 以路由键/前置版本约束；导入 preview→commit 绑定 input_hash/confirm；export 是分页读取 |
| `/api/understanding/frameworks/*` | account + cloud 注入 PostgresFrameworkRepository | 框架独立预算与版本协议，见[框架契约](frameworks-and-insight-analysis.md#已实现的跳过暂停与尝试账本协议) |
| `/api/understanding/*` | 显式 NativeReportService；或独立只读 archive adapter，二者互斥 | archive 不提供写入；不能据页面入口宣称报告回应能力可用 |
| `/api/content`、`/api/knowledge`、`/api/specialist` | content 在 account 也经 session；后两者仅 account + cloud | 内容版本与个人反馈分开；对应 `routes/` 和知识/专项契约决定输入，不扩大诊断处理权限 |
| legacy records/insights/review/questionnaires/materials/export | 非 account 才挂载 | 不是账号模式的备用真源；不将失败请求降到 legacy |

认证先确定 principal，Profile resolve 再确定 tenant/subject。`cloud-diagnostic/scope.ts` 的事务上下文和 `runtime-role.ts` 角色门禁已有实现；RLS/授权脚本是数据库边界，不能简化成仅路由 where 条件。Hyperdrive 按请求建立连接是 Worker 组合方式，不据此改成跨请求共享客户端。

全局错误出口是 `middleware/error.ts`：CoreError 保留其 code/status，Zod/JSON 输入失败为 400，`middleware/error-catalog.ts` 中的关键业务码按显式类型目录映射 400/409/503，未列出的旧码保留前缀/正则回退，未知内部错误为 500；框架局部路由另有映射。客户端应读 error.code，不把所有 409 视为可自动重试。capabilities、健康和已保存回执分别回答能力、依赖与保存结果，不能互代。

## 7. 策略和处理血缘

`cloud-diagnostic/policy-identity.ts` 的 CLOUD_PIPELINE_ID（processing 中沿用 PIPELINE） 是 `cloud-diagnostic-pipeline@2`、POLICY、PROMPTS、QUALIFICATION_HASH 的摘要；发布记录的 policy_version 存 PIPELINE，prompt_version 存 PROMPTS 摘要。读取/复用还绑定输入指纹、来源资格和 model。摘要不是可读策略名称，也不是用户变化；回放时须配合候选提交和当时常量，不能用当前常量解释旧版本。

各策略有不同任务：原生探索 `core/epistemic-policy.ts`，诊断取证 `diagnostic-reasoning/policy.ts`，共享命题/综合策略 `domain/understanding/policy.ts`，框架 `framework-runtime/policy.ts`，旧 dogfood 模型策略。共享校验不表示任务语义相同。

`apps/api/src/policy-registry.ts` 提供只读的当前策略目录：职责、可读 key、版本/摘要、摘要依据、源码位置及持久化说明。`apps/api/scripts/policy-inspect.ts` 可按精确 key/标识/摘要查询；匹配返回 known，多义返回 ambiguous，未知历史标识返回 unknown，不推测当前含义。框架 definition 作用域与已持久化的旧摘要按原协议保留，注册表不创建数据库历史映射、不改版本、不作为读取/复用门禁。当前版本相同不能证明历史 prompt 字节相同，仍须结合当时提交与冻结输入。
