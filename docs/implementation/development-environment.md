# 开发环境与无生产连接预览

本页维护本机或 Codex Cloud 开发环境的依赖、预览与凭据边界，不保存生产配置副本、私人正文或部署快照。命令副作用看 [Commands](../commands.md)。

## 代码与依赖

源码以 GitHub 仓库 `helixho/findme` 的 main 为准。依赖以 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 为源；使用 Node 24 和 pnpm 9.15.9（根 engines 允许 Node 22 以上，但 API 的 tsup 运行目标是 node24）。安装只用锁定依赖：

```sh
pnpm install --frozen-lockfile
```

在 Codex Cloud 开发时，环境须通过用户的 GitHub 连接获得私仓访问权，并按[官方 Cloud 环境文档](https://learn.chatgpt.com/docs/environments/cloud-environments)配置依赖；本机 Git 认证不会自动继承。环境保存状态不替代 Git 提交和推送，开始前先核对检出提交与 GitHub main 一致。

## 应用直接运行的目标方式

应用开发及后续部署直接运行源码或构建产物，不以 Docker 应用镜像作为前置；数据库容器和合成数据库测试独立保留。目标运行边界见 [TA](../ta.md)，运行脚本、进程管理和现有实例切换作为 [AG-06](../delivery/agent-work-plan.md)实施，未完成前不将容器部署命令改称直接运行命令。无需为纯文档或方法初稿启动本机 Docker。

## 无生产连接的开发与预览

默认不注入生产数据库、访问串或模型 key。主 App 明确使用同源 API 地址，避免默认连现用生产域名：

```sh
pnpm --filter @findme/core build
pnpm --filter @findme/api build
VITE_CORE_API_BASE="" pnpm --filter @findme/app build
VITE_CORE_API_BASE="" pnpm --filter @findme/app exec vite --host 0.0.0.0 --port 5174
```

`/diagnostic-preview` 是不调用 API/模型的合成阅读原型；普通首页需要真实后端或明确的开发 mock，Vite 本身不提供 `/api`。该预览不代表本人报告已迁入账号模式，也不替代账号模式的浏览器验收；需要真实数据时指向对应的获准后端。

`scripts/dev.sh` 仍要求本机 `.env`。环境 setup 只安装依赖，不运行它或完整 `scripts/verify.sh`。快速自测用 `pnpm test:fast`；合成自测用 `pnpm test:local [文件名]`；数据库验证用 `pnpm test:db [文件名]`，由执行器创建一次性 Docker PostgreSQL、应用仓库迁移和账号访问策略；`pnpm test:app` 独立检查 App，`pnpm test:browser` 执行合成与真实临时库浏览器两组；`pnpm test` 无筛选时包含全部范围。浏览器预先需要 `pnpm exec playwright install chromium`（Ubuntu CI 加 `--with-deps`），fast/local/app 不需要浏览器。覆盖率入口见测试计划，不设全局阈值。Docker daemon 必须已经可用，脚本不会安装/启动虚拟机或恢复生产库。详情见[第一阶段测试计划](../delivery/phase-1-test-plan.md)。

## 凭据与生产操作边界

开发只需 GitHub 私仓访问及依赖下载。确需联调时，在本机仓库外或 Cloud 安全环境配置中提供对应测试环境的连接/令牌；不写进聊天、AGENTS、Git 或前端 VITE 变量。前端只允许 API 地址等公开配置，数据库 URL 属于服务端，模型 key 只在 App 模型设置中填写并存于实例数据库。开发环境不自动获得任何实例的连接。

部署见[单节点部署](../../deployment/standalone/README.md)。数据导入、服务恢复或付费调用先形成具体、可审阅的目标与影响，再按授权执行；回退应用版本不回退数据库数据。

## 本机开发配置

仅在需要本机 API 的开发任务中，从根 `.env.example` 复制到忽略的 `.env`，填写本机开发库的 runtime/identity/auth 三个连接、`ACCOUNT_SECRET`、base URL 与 trusted origins；不复制实际节点的 `runtime.env`。空库先执行一次 `packages/db/schema.sql` 和 `packages/db/access/account-runtime.sql`，或直接用部署脚本在本机 Docker 中初始化。纯 `/diagnostic-preview` 不需要 `.env`、数据库或模型。

模型服务商、密钥与预算不在环境变量中，登录后在 App 的“模型设置”里填写并保存到数据库。测试用的 `DATABASE_URL_TEST` 由 `pnpm test:db` 生成，无需在日常 `.env` 保存测试凭据。
