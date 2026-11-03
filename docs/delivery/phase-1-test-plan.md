# 第一阶段 — 验证范围与运行入口

对应 [P1-AC-01–09](phase-1-personal-understanding.md)。本文件规定选哪些检查、怎样解释结果；实际次数与通过状态只写 execution 记录。已有测试不是零资产，本计划也不把它们提升为完整产品验收。

## 工程入口

| 命令 | 实际范围 |
| --- | --- |
| `pnpm test:fast` | 执行器、显式选出的轻量 API 组及未筛选时的 App 单测；不是完整 local 组 |
| `pnpm test:local` | 执行器、无数据库 API 合成回归，未筛选时含 App 单测；文件与异步流程不统称纯函数单测 |
| `pnpm test:db` | 创建一次性 Docker PostgreSQL，按 journal 迁移后单独配置访问策略/分离角色，运行真实数据库回归并清理本次资源 |
| `pnpm test:app` | 正式 App HTTP 身份边界单测，含账号会话与 Profile 响应过期判定 |
| `pnpm test:browser:synthetic` | 构建正式 account React App，拦截合成 HTTP，检查桌面/移动交互；没有实际认证或持久化 |
| `pnpm test:browser:real` | 同一 App 经 loopback createApp、真实 Better Auth cookie 与每视口新建临时 PostgreSQL；合成身份、邮件/推理关闭 |
| `pnpm test:browser` | 上述两个浏览器组；不是生产部署验收 |
| `pnpm test:browser:maintenance` | 仅保留 App native/private 检查，独立临时构建与模拟 HTTP，桌面/移动交互；旧 Web 检查随退役移除，包含于完整 test/CI |
| `pnpm check:repo` | 已跟踪 Markdown/HTML/CSS/manifest 引用与锚点核对；不替代动态引用/业务检查 |
| `pnpm test` | 不带筛选时串联 API local/db、App 单测、两组浏览器；无测试包列为未覆盖，不算空成功 |
| `pnpm test:local framework-runtime` / `pnpm test:db knowledge-processing` | API 文件筛选，零匹配失败；筛选不执行 App/浏览器，不称全套通过 |
| `pnpm test:coverage:local` / `pnpm test:coverage:db` | 对选定 API 组生成 V8 覆盖率报告，可附文件筛选；没有全局阈值，也不度量未选的浏览器/旧前端 |
| `pnpm lint` / `pnpm --filter @findme/api exec tsc --noEmit` / `pnpm build` | 格式/静态检查、API 类型、workspace 构建；不是运行效用证明 |

需先按锁文件安装依赖，使用 Node 24 / pnpm 9.15.9。数据库测试需要已经可用的 Docker daemon；macOS 可以使用既有 Colima，并通过 DOCKER_CONTEXT 选择专用实例。脚本不会自行安装或启动虚拟机，不改全局 context。浏览器还需 Chromium：`pnpm exec playwright install chromium`；Ubuntu CI 使用 `pnpm exec playwright install --with-deps chromium`。仅运行 fast/local/app 不需要 Docker 或浏览器；完整入口需要两者。CI 使用同一分组入口。

执行器不加载仓库 .env，不继承数据库或模型配置；测试库、端口、账号文件由本次执行创建。数据库分类由 `scripts/test-config.mjs` 的清单和 `-postgres.test.ts` 后缀定义，新出现的测试必须归类。数据库缺失/迁移失败/角色错误在用例前停止；本机组不会将跳过数据库描述为全量通过。SIGINT/SIGTERM 和失败均执行自身资源清理；非正常杀进程、Docker daemon 不可达的清理结果须另核对，不能承诺必然清完。

## 选择与覆盖

| 变更 / P1 条件 | 必选的验证与尚缺层 |
| --- | --- |
| 来源资格、排除/恢复/重绑/硬删除 / AC-05 | 账号云端与 Core reliability 数据库回归；检查有效当前认识退出、剩余支持决定 stale/invalid、无关认识保留、历史和正文处理、幂等及在途版本。真实模型如何吸收纠正仍需另验 |
| 任务、资格证明、报告发布与恢复 / AC-02、04、05 | 云端函数回归＋账号数据库套件；含 JSONB 往返、缓存重用、并发与终止历史。Cloudflare 实际投递不由此证明 |
| 框架运行或文件异步保存 | framework-runtime 与 host 集成；等待可观察完成条件，不用固定短睡眠假定已写盘；不得把草稿框架测试当正式协议完成 |
| 普通对话/新来源/知识反馈 / AC-03、04、06、07 | 随实现增加对应行为用例，断言后续回答使用当前理解、反例改变范围、作品反馈可靠保存；知识与专项已有独立真实数据库回归，完整产品对话和真实使用仍需另验 |
| 导入、容量与覆盖 / AC-08 | 恢复纯函数＋账号导入/导出往返；另核对真实授权批次的完整去向、容量限制与重复处理 |
| 账号 App、多端与真实入口 / AC-01、09 | 类型/构建只能作为准备；已有正式 App 单测与两组桌面/移动浏览器；部署入口与手机/电脑本人连续使用仍需另验 |
| 本人支持、建议、挑战与知识价值 / AC-06、07、09 | 固定真实案例及本人反馈；工程通过不代表回答正确、有效或分身已完成 |

浏览器代码在 `apps/app/e2e/`，运行器为 `scripts/test-browser.mjs`；真实组在各视口重新建库以保留生产限流语义，不降低限流来使夹具通过。App native/private 保留 maintenance 浏览器组；正式 account 浏览器检查保持，含桌面与 390×844 移动视口。独立 Web 测试、Taro 专用测试和 H5/weapp 构建检查随客户端退役移除。这里说明套件范围，不预先宣称本轮测试或 CI 通过。知识、专项与归档分别有 `*-postgres.test.ts` 套件；执行器按后缀及显式清单归类。旧大型合成测试仍按真实范围解释。不开全局覆盖率或复杂度阈值，不要求全部存量重构。

## 进入、退出与候选记录

进入：核对 main 基线和工作区差异、明确本次改动及影响，锁文件安装，相关环境准备成功。缺条件记录 blocked/not_run，不能运行后把超时当产品故障。

退出：实际选择的检查通过、失败已解释/修复、测试资源清理状态可核、保留候选提交及命令/日志。缺陷修复优先保存旧代码失败→修后通过的同一用例。只执行子集必须标明范围；测试数不累计成不同用例总数。

CI 随 main push 或手动触发执行 lint、类型/构建、local（含 App）、db，并安装 Chromium 后运行两组浏览器；不自动部署、不启用模型或恢复生产数据库。提交后应回读 CI 实际结果，不能仅因 workflow 文件存在宣称已通过。

完整第一阶段还需独立的真实回答质量与本人连续使用证据。本计划和 CI 均不代签 G6A，不继承旧 owner-entry-v1 的通过状态。

本轮聚焦结果与结构拆分后的最终集成、依赖安装/审计状态由协调者写入维护收尾与清理记录；已有聚焦通过不能替代当前候选的完整运行。
