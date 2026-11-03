# 工程与文档债务逐项核对

原修复基线：`4a1df98`；后续修复为 `bff6128`，结构/清理为 `165f6d2`；本次依赖续做和最终状态以维护收尾记录§7为准（2026-10-31）。原始审计来源为 `deliverables/engineering-assurance/raw/code.md`、`arch.md`、`test.md`、`doc.md` 及 `deliverables/engineering-assurance/tech-debt-findme-2026-10-31.md`；这些未跟踪交付物只作来源定位，不作为文档链接或本轮改写对象。保留原始全部 ID（含 AD-06b、AD-10b 和表外 TD-14）；事项列标题中的数字仅为原审计表述，不是当前测量。原总分、工期与季度计划不作为验收依据。

首批和后续事实分别见首批记录、后续记录；本轮结构、依赖与清理结果见维护收尾记录。本次按实际修复和最终完整回归更新维护项，不继承较早候选的验证。版本扫描仍有提示，其补丁/实际API适用性逐项说明，不冒充扫描清零。测试数字只在执行记录保留。

状态含义：fixed with evidence＝所列缺口已有修复及证据（文档修复只证明文档）；disproven with source＝原因果或前提被源码反证；deliberate retained design with rationale＝按既有范围有意保留；open needing repair＝仍有真实实现/测试/核验工作；deployment validation pending＝设计/文档不足以证明正式组合可用。混合项在证据栏明确已修与未修，不将部分修复归成 ALL complete。

## 运行路径与权威性

此处 S1–S6 仅沿用原报告运行路径编号，不等于 Delivery Kit 阶段；不平行保存线上快照。

| 路径 | 数据职责 | 当前决定与源码定位 | 部署证据 |
| --- | --- | --- | --- |
| S1 legacy 后端（原 apps/web 客户端已退役） | 旧 records/insights | D25 直接删除独立客户端；后端非 account 路由、Queue、数据与迁移保留 | Current Status的带时间观察 |
| S2 原生 Core | 同账号库的探索/来源/认识 | account Profile 事务，不另立真源；routes/core.ts | 同左；本地验证在 execution |
| S3 account + apps/app | 唯一运行权威 | D23/D24；app.ts、cloud-diagnostic/runtime.ts | 实际入口与依赖待验证，不能从 assets 构建推断 |
| S4 U2/dogfood | 仓库外加工产物 | 冻结，已审核产物一次性迁入，不重生成 | CLI 产物不是部署服务 |
| S5 私有 U3 | 旧私有状态仓储 | 冻结；不承接新账号入口 | 历史局部宿主验证不算正式入口 |
| S6 archive | 固定只读快照 | 临时过渡；导入对账后退役，归档导出/清理已有实现，导入对账与退役待部署验证 | 读取/传输历史见对应 execution，未重探测 |

权威职责的解释见 [AA](../aa.md#客户端与运行职责的实现解释)，迁移操作见方案。D25 明确删除的两个独立客户端除外；其余冻结后端/数据不扩展清理，不恢复原 Neon、不新增企业流程。

## 代码

| ID | 原报告事项 | 状态 | 核对、证据与未完边界 |
| --- | --- | --- | --- |
| CD-01 | 认知复杂度集中：163 个函数超阈值 15，68 个 ≥30，6 个 ≥100 | fixed with evidence | 指定 jobs/runner/recovery/store 热点已按注册、修复、专题、审核、重放、发布、恢复与失效职责拆分；原 API/预算/锁/提示词/历史语义保留。定向对照与同一候选完整回归通过，见维护收尾记录。不以复杂业务规则消失或任意分数作为关闭条件。 |
| CD-02 | 巨型单文件：24 个文件 >800 行（源码 17 / 测试 7），两个前端 App 各自是单文件 SPA | fixed with evidence | 原两个集中入口 App.tsx 已分到 native/ 与 legacy/ 的视图、状态及 API 职责；原 props/JSX 与四个状态 hook 对照，新增双视口交互回归及完整工程验证通过。正式账号入口保留，未重画 UI 或删除冻结能力；本项只关闭集中职责问题，此后的独立客户端退役与在线切换见 AD-11。详见维护收尾记录。 |
| CD-03 | 手写并发护栏：文件系统互斥 + PID 存活判定 + 模块级全局 Set（影响面已闭合：仅 private/CLI 路径，见 §11.3） | deliberate retained design with rationale | 冻结 private/CLI 保留 dogfood/store.ts 的 mkdir/PID 文件锁及进程内护栏。private-lock.test.ts 已作真实进程互斥、释放与恢复验证，未复现需修改锁实现的缺陷；原旧流程回归保留。线上使用数据库租约/锁，不能将旧 CLI 的有界设计当成线上并发方案。 |
| CD-04 | 依赖主版本被三方互锁，zod 双主版本共存 | disproven with source | 双 Zod major 不证明实例混用或 SDK 升级锁死；运行目录 dependency-verification-report.txt 已核对 OpenAI 支持 Zod 3 的上游清单。业务 Zod 3 的已确认有界集合问题已有定向回补，实际验证与剩余版本提示见 CD-11及维护记录；反证强制迁移不等于所有依赖永远无问题。 |
| CD-05 | 无自动化质量门禁；唯一门禁靠手动；复杂度规则未启用；miniapp 测试是假绿 | fixed with evidence | 基线 package.json、scripts/test.mjs、scripts/verify.sh、.github/workflows/verify.yml 已有显式分组和 CI；移除空成功。既有 CI 证据见首批记录；workflow 保留浏览器与 App 单元；小程序构建随 D25 退役退出；各提交的远端结果以对应执行记录和实际run为准，不由配置存在推断通过。全局复杂度门槛与 hooks 并非已确认的个人项目要求。 |
| CD-06 | 334 个裸字符串错误码，无联合类型/无目录 | fixed with evidence | middleware/error-catalog.ts 已提供类型化关键错误目录、分类和显式 HTTP 映射；contracts-errors.test.ts 覆盖已知及未知旧码。error.ts 保留原正则回退，CoreError、账号、报告与归档局部契约仍各自保留，不声称所有字符串码已改成同一枚举。 |
| CD-07 | 状态机语义散落在 4+ 个文件重复实现（版本/依赖/阻断三件套） | fixed with evidence | 共享来源失效已集中到 core/source-invalidation；cloud 任务决策进入 processing-policy，knowledge 当前/历史依赖复核分为明确模块，并通过最终相关行为回归。不同报告/任务/尝试仍保留各自生命周期，不将对象特有状态机械合并成同一枚举。 |
| CD-08 | 前端重实现服务端领域规则（同一业务语义两套实现） | deliberate retained design with rationale | apps/app/src/diagnostic-preview/state.ts 是合成预览 reducer，入口 /diagnostic-preview；正式账号操作由 API 裁决。保留演练资产，不将本地预览规则移作正式权威。 |
| CD-09 | 58 张数据库表中 8 张零代码引用，仍在迁移与备份范围内 | disproven with source | auth/server.ts 的 BetterAuth modelName 动态访问 auth_*；0010 负责 DDL。TS 导出零引用不能证明无用或自动双重建表。legacy 注册/日志表保留不等于已确认必须删除，D23 冻结不授权删表。 |
| CD-10 | 导出面过宽：3 个 `export *` barrel 让全部导出成为公共契约 | fixed with evidence | packages/core/src/index.ts 与 packages/shared/src/index.ts 改显式公开导出，contracts-public-surface.test.ts 对照基线验证既有运行时键和值身份，防止新增内部项自动外泄。db/src/index.ts 保留命名 schema 入口；不因存在 barrel 就扩张为全仓禁止导出。 |
| CD-11 | 18 个依赖落后 ≥1 个 major（含 3 个 major） | fixed with evidence | 此前活跃业务集合回补、Node adapter 和实际 Taro 父链修补有维护记录；此后 Taro 全套及其专用测试按 D25 随独立客户端退出，保留 Zod 3 补丁，实际无父依赖 override 与 Taro 4 补丁清理由本轮依赖记录确认。此前 html-minifier/srcset 修复与 PostCSS 父链升级的完整回归仅证明历史维护候选，不要求保留已退役的 Taro 补丁与构建链。版本提示按补丁/未使用API/不适用实现逐项记录，证据见维护记录§7及依赖记录，不称audit清零。 |
| CD-12 | 30 条 `pnpm overrides`（28 升 + 1 降级 + 2 硬钉），覆盖表开始反噬 | fixed with evidence | dependency-overrides.json 与根清单逐项对应，并有自动测试防止新增无记录 pin；已记录原历史和父包约束。定向补丁安装、完整业务回归、构建、Seroval/Solid SSR 与 Miniflare/Undici 兼容检查已通过。保留版本提示及其实际用途解释见CD-11，不将所有override的存在本身当缺陷。 |
| CD-13 | 测试骨架复制：两个核心测试文件共享 153 个重复块，各 1,500–2,000 行 | fixed with evidence | test/helpers/understanding-source-data.ts 与 understanding-source-fixture.ts 已提取共用夹具；legacy-verification-result.md 及 legacy-fixture-bytes.log/legacy-ast.log 确认旧断言保留、产物字节相同，协调者确认旧回归通过；同 TD-14。 |
| CD-14 | 两套并行前端 + 跨端框架主版本不一致（部署面已实测，原表述有误，见下方修正） | deployment validation pending | D25 已落实仓库两个独立客户端退役，不再保留 React 18 miniapp 兼容工程；App 自身内部兼容保留。实际本人账号入口与 API/cookie/手机 H5/桌面组合仍待部署验证，不因删除目录关闭本项。 |
| CD-15 | 路由层挤压：27 个路由注册在单个 1,042 行函数内 | fixed with evidence | routes/specialist.ts 保留 HTTP 校验/事务适配，sessions/proposals/trials/review-source 与 repository/policy/contracts/types 位于 specialist/。specialist-http 与 specialist-postgres 已有路由和真实数据库回归，协调者确认聚焦通过；不据此宣称全部路由覆盖。 |
| CD-16 | `export *` + 顶层 zod schema 构造 → Worker 冷启动与体积不可控 | disproven with source | 原报告未测得 export * 或双 Zod 导致冷启动翻倍；显式导出与依赖图守卫已实现，但没有 bundle/首请求量测，不能宣称性能已改善。若需优化须先取得实际成本证据；依赖修补与版本提示的实际处置见CD-11/12，不再把已经完成的维护称为未修。 |
| CD-17 | 前端死路径：页面已注册路由，后端从未挂载 | deliberate retained design with rationale | apps/app 的 /dogfood 对应冻结私有/CLI 宿主资产，未在 account Worker 挂载不等于所有宿主死路径。按 D23 保留，不充当正式本人验收入口。 |
| CD-18 | 来源失效的两条路径产出不同终态与不同可见性；`hasWithdrawn` 守卫被短路近乎不可达 | fixed with evidence | 基线 core/source-invalidation.ts、core/source-service.ts、cloud-diagnostic/effects.ts 与账号/Core 回归已有传播和可见性修复；见首批维护执行记录。软排除保留正文，硬删除清理，不强求两种操作同终态。原“近乎不可达”已被原总结推翻。 |

## 架构

| ID | 原报告事项 | 状态 | 核对、证据与未完边界 |
| --- | --- | --- | --- |
| AD-01 | 部署与真源配对反了：唯一活着的入口服务的就是被 D23 判死刑的路径 | deployment validation pending | AA 客户端职责解释与 D23/D24 明确 apps/app 为账号入口；旧静态首页可达不代表目标路径部署成功。实际可持续入口仍待部署验证，不补造新用户决定。 |
| AD-02 | 同一批 Core 表存在两套独立写入实现与两套失效传播 | fixed with evidence | 同 CD-18：有效支持 stale/invalid 共用 core/source-invalidation.ts，并有基线数据库/HTTP/并发回归。两种状态维度和硬删除仍按其不同语义保留。 |
| AD-03 | 6 个语义真源并存，收敛只停在文档层 | deployment validation pending | 共享领域规则、hosted archive reader、framework schema 与 private adapter 已分离并有 import graph 守卫；这已超出只改文档。真实批次导入对账、账号读取等价和快照实际退役尚未执行，最终结构集成已通过，实际迁入与退役仍待验证；目录多条路径不等于多个独立数据库。 |
| AD-04 | 归档 2 表在 Drizzle/迁移之外，脱离统一 schema 治理 | fixed with evidence | schema-archive.ts 与 journal 0012_open_lionheart 接管两张归档表；支持新建与精确旧结构，结构不符拒绝接管。export.ts 增加归档 manifest/分块二进制 hex 与哈希，purge.ts 先删 chunks 再删 batches。archive-lifecycle-postgres.test.ts 聚焦真实库验证由协调者确认；不自动将归档导成个人 claims，不声称原子备份或生产已迁移。 |
| AD-05 | routes 越层直连 db；`specialist.ts` 是 route-as-repository | fixed with evidence | 同 CD-15：specialist/ 分离持久化、业务和路由；withProfileTransaction 与 RLS 保持。HTTP 与真实数据库聚焦回归已有证据，不再写成尚未抽离。 |
| AD-06 | god repository：`understanding-app/repository.ts` 1,571 行承担 6 个领域职责 | fixed with evidence | private repository 按反馈接收、任务处理和仓储辅助拆分，公开 facade 保留；AST/JSON 逐字节对照、最终完整原有回归和类型/构建通过。函数仍可有复杂业务，但不再由原单个仓储承载所有职责；更广复杂度余项在 CD-01。 |
| AD-06b | god repository：`cloud-diagnostic/repository.ts` 1,143 行 | fixed with evidence | cloud repository 拆到 evidence/report-reading/response-intake/publication/repository-state，processing-policy 提取实际使用的状态决策。最终真实 PostgreSQL、既有并发/来源发布与表驱动状态回归通过，保留锁序和任务预算语义。 |
| AD-07 | 云端运行时反向依赖本地冻结流水线，并把 `node:fs/promises` 拉入 Worker 依赖图 | fixed with evidence | 共享纯函数、理解规则、hosted 归档读取及 Framework schema 已脱离冻结文件仓储；最终递归值导入边界和 Worker dry-run 构建通过，未把 node:fs 支持与否当作原缺陷。旧 CLI 兼容入口保留，但不再由 hosted 路径载入。 |
| AD-08 | 循环依赖 6 个（不止文档记的 1 个 2-环） | disproven with source | 原目录聚合环不能证明文件级运行时循环。共享规则与 private schema 分离后，最终实际值导入守卫通过，独立审查对应源码图也未见环；不沿用“六个环”作为仍待修的运行故障。 |
| AD-09 | Epistemic Policy 有 5 份平行实现，无统一注册；版本列存在但被灌入不透明哈希 | fixed with evidence | policy-registry.ts、policy-inspect.ts 和 policy-registry.test.ts 提供只读当前策略、标识/摘要/来源查询，known/ambiguous/unknown 明确区分。旧摘要与 definition 作用域仍按原协议读取，不改变持久标识、不写历史映射、不把当前内容冒充历史 prompt 字节；此边界是有意保留。 |
| AD-10 | 同名概念文件重复；状态词汇在代码与文档两层都不一致；且契约对实现只定义、不约束 | disproven with source | 原报告把 Claim、C1 诊断、云报告和旧认识处置的独立状态域混用，未提供错误 parse 调用链。当前词表/路由说明已分对象，公开契约、错误映射和实际状态转换有回归；不为词面一致删掉合法类型或给无关 enum 加 withdrawn。 |
| AD-10b | 同一事件（来源被排除）在两条路径下产生不同的用户可见状态；`hasWithdrawn` 是云路径的正式分支且其可读顺序决定呈现 | fixed with evidence | 同 CD-18/AD-02；原行把硬删除和排除当同事件的前提不成立。真实软排除有效性问题已由共享传播与基线回归修复，不以反证前提掩盖已确认修复。 |
| AD-11 | 前端 2 栈 + 单 SPA 4 个产品入口，产品面重复 | deployment validation pending | 仓库部分已落实：按用户最新明确决定 D25，直接退役 `apps/web` 与 `apps/miniapp`，仅保留 `apps/app` 浏览器客户端及 native/private/diagnostic-preview/dogfood 内部兼容；手机 H5 与桌面同代码。不以前置迁移全部旧功能阻挡删除。在线部分尚未切换验证，此次没有部署；不能据此关闭 AD-01/CD-14/AD-03 或业务验收。本轮完整本地回归结果见客户端退役记录，远端按对应提交核对。 |
| AD-12 | 部署拓扑债：目标 Worker 配置不可能产出可运行服务；组合根按请求 build | disproven with source | wrangler.app.jsonc 明确 assets.directory 的纯静态 Worker，无 main 合法；API 位于 wrangler.jsonc。cloudflare.ts 按请求使用 Hyperdrive 连接是有意生命周期，不据此全局池化。实际组合仍见 AD-01。 |
| AD-13 | 组合根 4 种 auth mode × 路由挂载矩阵，产品行为由配置隐式决定 | fixed with evidence | [C 系列契约 §6](../implementation/c-series-cloud-runtime.md#6-路由鉴权与失败定位图)按 app.ts 补 auth/路由/作用域/幂等/错误图；四模式有显式挂载边界，不将文档完成提升为部署验证。 |
| AD-14 | ADR 覆盖缺口：3 项关键决策无记录 | fixed with evidence | D23/D24 已批准方向；迁移方案、AA 客户端解释及 C 系列血缘图补实现解释，不伪造新的 ADR 产品决策。实际边界实现未完见 AD-03/07/09。 |
| AD-15 | 架构不可验证：无 DB 集成测试库、前端零测试，导致所有收敛动作都无法回归 | fixed with evidence | 新增 knowledge/specialist/archive PostgreSQL 套件、正式 App 单测及 synthetic/real 浏览器链；协调者确认指定聚焦结果，账号/Profile epoch 竞态有红绿回归。真实浏览器使用 cookie、Better Auth 与每视口新建临时数据库，不能据此证明生产、真实模型或本人效用；结构变更后全套仍待验。 |
| AD-16 | 同一批 `auth_*` 表被 drizzle 与 better-auth 双重拥有；且 zod 双主版本成为跨边界硬约束〔第二轮新增，来源：code-reviewer 交叉输入〕 | disproven with source | 同 CD-09/CD-04：auth/server.ts modelName + migrations/0010；配置未显示自动迁移动作。Zod 双 major 不构成全迁与 SDK 锁死的充分证据。 |
| AD-17 | barrel 导出面使层级边界形同虚设〔第二轮新增，来源：code-reviewer〕 | fixed with evidence | 同 CD-10；Core/Shared 显式导出及基线公开面兼容测试已实现。框架 hosted 消费 schema 而非旧 state/private facade，冻结 import graph 另有守卫；不扩大成全仓必须禁用 barrel。 |

## 测试

| ID | 原报告事项 | 状态 | 核对、证据与未完边界 |
| --- | --- | --- | --- |
| TD-01 | 12 个 DB 集成测试文件默认不可运行，且失败形态是 60s 超时而非快速失败 | fixed with evidence | 基线 scripts/test.mjs、scripts/test-runner.test.mjs 与维护执行记录：临时库/角色准备，缺条件提前失败，分组和空包显式，超时等实际完成，诊断输出分准备阶段。协调者确认已验证，不在本任务重复运行。delete-guard 本身更完整的端点覆盖仍按实际风险补。 |
| TD-02 | `knowledge-processing/service.ts`（1,441 行 / 5 个导出业务函数）零测试 | fixed with evidence | 五个公开知识服务均有真实 PostgreSQL 行为回归，涵盖版本/幂等、当前及历史引用、重绑、反馈、并发/回滚；完成职责拆分后已纳入最终整套重验与定向覆盖率观察。 |
| TD-03 | 18 个最关键的用例被 `describe.skip` 静默跳过，无 skip 原因，退出码 0 | fixed with evidence | 基线 scripts/test.mjs、scripts/test-runner.test.mjs 与维护执行记录：临时库/角色准备，缺条件提前失败，分组和空包显式，超时等实际完成，诊断输出分准备阶段。协调者确认已验证，不在本任务重复运行。delete-guard 本身更完整的端点覆盖仍按实际风险补。 |
| TD-04 | 仓库当前存在确定性红灯，无人知晓 | fixed with evidence | 基线 scripts/test.mjs、scripts/test-runner.test.mjs 与维护执行记录：临时库/角色准备，缺条件提前失败，分组和空包显式，超时等实际完成，诊断输出分准备阶段。协调者确认已验证，不在本任务重复运行。delete-guard 本身更完整的端点覆盖仍按实际风险补。 |
| TD-05 | 前端三层（`apps/app` 20 文件、`apps/web` 2、`apps/miniapp` 22）零测试基建 | deliberate retained design with rationale | 正式 App 已有 unit 与桌面/移动 synthetic/真实后端浏览器资产；独立 web/miniapp 及其专属测试随 D25 退役。maintenance 仅保留 App native/private 6 项，正式 account 34 项保持；本轮最终结果由协调者确认，不沿用旧候选通过状态。 |
| TD-06 | 浏览器端到端 0 次，`docs/current-status.md` 自认「浏览器端到端 0 次」 | fixed with evidence | scripts/test-browser.mjs 将正式 React App 的 synthetic 拦截响应和 real createApp/Better Auth/cookie/临时 PostgreSQL 分组；desktop/mobile 各用新库，browser-real-final.log 已记录最终成功退出。CI 安装 Chromium 并运行浏览器组；这不是生产入口或模型质量验证。 |
| TD-07 | 无覆盖率度量、无阈值门禁 | deliberate retained design with rationale | test:coverage:local/db 已支持 V8 覆盖率报告与文件筛选，无全局阈值。按 TA 保留风险相关行为验证；覆盖率度量已实现，不据指标宣称完整性或新增任意复杂度/覆盖率门槛。 |
| TD-08 | 反馈回路 18 分钟，且 `fileParallelism:false` 全局串行 | fixed with evidence | 新增 fast/local/db/app/browser 明确入口与文件筛选，并实际记录有界快速组耗时。完整套件仍保留串行数据库与文件流水线以避免共享状态争用；旧失败环境的 18 分钟不再冒充当前反馈成本，也不设无依据速度承诺。 |
| TD-09 | 路由/HTTP 层没有独立的可运行契约测试；15 个路由文件只 3 个被直接引用 | fixed with evidence | route-plan.test.ts 通过 createApp 覆盖鉴权/挂载组合与查询前拒绝；contracts-errors、specialist-http 与真实库测试覆盖关键协议。直接 import 文件数不是 HTTP 覆盖率；不声称所有端点/生产角色/Cloudflare 投递均已验证。 |
| TD-10 | `pnpm test` 假绿：无 test script 静默跳过、`--passWithNoTests`、`echo && exit 0` | fixed with evidence | 基线 scripts/test.mjs、scripts/test-runner.test.mjs 与维护执行记录：临时库/角色准备，缺条件提前失败，分组和空包显式，超时等实际完成，诊断输出分准备阶段。协调者确认已验证，不在本任务重复运行。delete-guard 本身更完整的端点覆盖仍按实际风险补。 |
| TD-11 | 「集成伪装成单元」+ 巨型测试文件：真正的快速纯函数单测只占约 5% | deliberate retained design with rationale | 测试计划如实区分纯函数、进程内合成集成、真实数据库与浏览器；新增状态/契约纯函数矩阵和共用 fixture，既有长流程仍作为有价值的集成保护保留，不为测试金字塔比例删改断言。 |
| TD-12 | 失败信息无诊断性，`delete-guard`/单元命名误导 | fixed with evidence | 执行器在连接、迁移、角色和测试阶段明确失败，HTTP 错误通过分类目录及真实路由测试区分。原 delete-guard 仍是单一引用保护函数的真实数据库集成测试，标题/分组已明确；实际 Profile 擦除、归档及来源生命周期另由对应服务/路由与作用域回归验证，不给内部堆栈加上会泄露连接值的日志。 |
| TD-13 | 同一认识存在两套合法终态，无任何测试约束二者一致 | fixed with evidence | 同 CD-18/AD-02；基线账号/Core 套件覆盖软排除、恢复、重绑、HTTP/并发与硬删除不同边界，不再把两种操作同终态当验收。 |
| TD-14 | 测试 fixture 重复（raw/test.md §7.5 追加） | fixed with evidence | 同 CD-13；公共 understanding fixture 已抽取并保留不同业务断言；legacy-ast/fixture-bytes 与既有回归证明机械迁移，未静默遗漏表外 ID。 |

## 文档

| ID | 原报告事项 | 状态 | 核对、证据与未完边界 |
| --- | --- | --- | --- |
| DOC-01 | RUNBOOK 缺失，回滚知识散落在 6 篇执行记录 | fixed with evidence | 基线 runbook 已存在；本轮补备份/恢复和 health/degraded，见 Runbook §6–7。 |
| DOC-02 | GLOSSARY 缺失，且 G 编号已被两种含义占用 | fixed with evidence | 基线 glossary.md 与 Roadmap GAP-n 已区分差距和交付门，历史报告编号不回写。 |
| DOC-03 | MIGRATION 设计缺失，0009–0011 与访问策略的适用性无一处成文 | fixed with evidence | 迁移方案已同步 journal 0012 新建/精确旧表接管、失败边界及 journal 后单独访问策略；旧 supplemental DDL 不再是正常新装步骤，生产状态不由源码推断。 |
| DOC-04 | TESTPLAN / TESTENV / TESTENTRY 缺失，测试库始终不可得（G29 未解决） | fixed with evidence | 基线 phase-1-test-plan.md 与 scripts/test.mjs 已给 TESTPLAN/TESTENV/TESTENTRY；临时 PostgreSQL 不要求恢复原生产。 |
| DOC-05 | ACCEPTANCE 缺失，业务接受无模板无记录 | fixed with evidence | [接受记录](acceptance.md)逐项 P1-AC-01–09 保留未执行，工程、真实质量、本人价值分开；旧十条 AC 不迁成新通过。 |
| DOC-06 | Core 契约漂移：文档与契约包都没跟上已在运行的报告回传能力 | fixed with evidence | 单次探索契约新增 report_target/capabilities/report-feedback/rebind，可靠性契约引用；机器契约与桥接代码已有，未新增平行接口 schema。 |
| DOC-07 | Framework 契约缺 skip / pause / attempts | fixed with evidence | 框架契约新增 skip/pause/continue、expected_version/幂等、attempt/租约迟到结果以及分对象状态词；保留 draft 与真人未验收。 |
| DOC-08 | 测试快照数字重复写在多处，且三处互相矛盾 | fixed with evidence | 当前状态移除复制测试数字和旧 CI 待回读描述，以执行记录作为唯一候选/验证快照；测试计划、Commands/deployment 改为范围和入口引用，历史记录不回写。 |
| DOC-09 | AGENTS.md 索引漏收 13 篇实质文档，含唯一的部署规程 | fixed with evidence | AGENTS 索引补 deployment、B 界面记录、10 月 30 日修复记录、接受、迁移与台账等当前漏项；不修改历史记录。 |
| DOC-10 | 新人上手 4 个阻断点，无一处文档补齐 | fixed with evidence | 开发环境补模式最小配置、模板复制、纯预览、账号零历史与 legacy seed 区分；README 与模板给导航。 |
| DOC-11 | 文档-代码覆盖严重失衡：最大模块只有 57 行契约 | fixed with evidence | C 系列契约新增源代码路由/鉴权/幂等/错误/策略血缘图；不以文档行数对代码行数衡量完整度，不复制 schema 清单。 |
| DOC-12 | 监控 / 告警 / 值班文档为 0 | fixed with evidence | Runbook §7 按 health.ts 区分 legacy/account 的检查和 degraded 处理，不引入值班团队或新告警平台。 |
| DOC-13 | `.env.example` 与代码/其他文档脱节 | fixed with evidence | 根 .env.example 指向 account 模板与模式最小配置，测试/private adapter 非默认要求；未碰实际 .env/Secrets。 |
| DOC-14 | 交付矩阵与 Current Status 对同一制品的判断互相矛盾 | fixed with evidence | delivery-tailoring 更新已存在制品位置与缺口，QUALITYALLOC/TESTENV/TESTENTRY 保持 merged，不再要求新建重复文件；当前安排仍由协调者管理 Current Status。 |
| DOC-15 | 时间戳元数据失真，无法判断文档是否可信 | fixed with evidence | 本台账区分原修复、后续结构/清理和最终依赖候选的证据边界；现有契约的当前补充明确对应源码。日期不替代内容可信度，历史记录不批量回写新核对时间。 |
| DOC-16 | `backup.sh` / `restore.sh` 无使用文档 | fixed with evidence | Runbook §6 描述备份 URL 优先级、直连、空库预检、yes/force、age/uploads/R2 边界及失败恢复；Commands 链接而不复制。未执行真实备份恢复。 |
| DOC-17 | 「运行路径 × 部署状态 × 是否真源」对照表缺失，且访问策略的静默跳过后果未写明 | fixed with evidence | AA 与运行路径表区分权威/冻结/部署证据；迁移方案明确 journal 建表/接管后单独策略，旧策略静默跳过需在建表后复核，不能将 migration 当 RLS 启用。 |
| DOC-18 | 前端 `apps/web` vs `apps/app` 二选一没有 ADR | fixed with evidence | AA 说明 `apps/app` 唯一浏览器入口；新增 D25 记录用户直接删除另外两个独立客户端与支持 H5/浏览器的明确决定，并补充 D23 的适用说明，不重写历史。在线切换仍见 AD-01/AD-11。 |

## 仍需处理与部署前接续

CD-01、CD-02、CD-11的本轮实际维护已完成，详见维护收尾记录。没有将三个项目改名为保留或部署事项绕过修复；无用脚手架清理与保留能力的兼容修复分开记录。过时内容按实际引用/替代关系处理，历史证据与有效资产保留。

AD-11 的仓库退役已落实，在线切换仍待验证；这与前次 CD-02 职责拆分是两项工作。D25 替代原“两个客户端冻结保留、待承接后再删”的安排；历史状态纠正仍保留在维护记录 §8，不代表本轮最终测试/CI 已通过。

CD-14、AD-01、AD-03仍待部署验证：实际入口、多端组合、真实历史迁入对账与对应快照退役尚未执行。本轮止于维护和清理，不自动部署。版本扫描仍有提示，具体补丁/调用适用性和限制见依赖记录，不声称audit零或上游所有API都已修复。

产品第一阶段的对话、新输入形成认识、知识反馈和本人价值按[交付计划](../implementation/diagnostic-product-plan.md#3-下一阶段的具体工作包与依赖)独立推进。[接受记录](acceptance.md)九项仍未执行，不能由工程回归或维护台账代签。
