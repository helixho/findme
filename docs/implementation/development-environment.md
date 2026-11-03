# 开发环境与无生产连接预览

本页维护本机或 Codex Cloud 开发环境的依赖、预览与凭据边界，不保存生产配置副本、私人正文或部署快照。当前状态看 Current Status，命令副作用看 [Commands](../commands.md)。

## 代码与依赖

源码以 GitHub 仓库 `helixho/findme` 的 main 为准。依赖以 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 为源；使用 Node 24 和 pnpm 9.15.9（根 engines 允许 Node 22 以上，但 API 的 tsup 运行目标是 node24）。安装只用锁定依赖：

```sh
pnpm install --frozen-lockfile
```

在 Codex Cloud 开发时，环境须通过用户的 GitHub 连接获得私仓访问权，并按[官方 Cloud 环境文档](https://learn.chatgpt.com/docs/environments/cloud-environments)配置依赖；本机 Git、Wrangler OAuth 与 Neon 连接器认证不会自动继承。环境保存状态不替代 Git 提交和推送，开始前先核对检出提交与 GitHub main 一致。

## 无生产连接的开发与预览

默认不注入生产数据库、访问串或模型 key。主 App 明确使用同源 API 地址，避免默认连现用生产域名：

```sh
pnpm --filter @findme/core build
pnpm --filter @findme/api build
VITE_APP_AUTH_MODE=static VITE_CORE_API_BASE="" pnpm --filter @findme/app build
VITE_APP_AUTH_MODE=static VITE_CORE_API_BASE="" pnpm --filter @findme/app exec vite --host 0.0.0.0 --port 5174
```

`/diagnostic-preview` 是不调用 API/模型的合成阅读原型；普通首页需要真实后端或明确的开发 mock，Vite 本身不提供 `/api`。该预览不代表本人报告已迁入账号模式，也不替代账号模式的浏览器验收；需要账号模式时改用 `VITE_APP_AUTH_MODE=account` 并指向对应的获准后端。

`scripts/dev.sh` 仍要求本机 `.env`。环境 setup 只安装依赖，不运行它或完整 `scripts/verify.sh`。快速自测用 `pnpm test:fast`；合成自测用 `pnpm test:local [文件名]`；数据库验证用 `pnpm test:db [文件名]`，由执行器创建一次性 Docker PostgreSQL、应用仓库迁移和账号访问策略；`pnpm test:app` 独立检查 App，`pnpm test:browser` 执行合成与真实临时库浏览器两组；`pnpm test` 无筛选时包含全部范围。浏览器预先需要 `pnpm exec playwright install chromium`（Ubuntu CI 加 `--with-deps`），fast/local/app 不需要浏览器。覆盖率入口见测试计划，不设全局阈值。Docker daemon 必须已经可用，脚本不会安装/启动虚拟机或恢复生产库。详情见[第一阶段测试计划](../delivery/phase-1-test-plan.md)。

## 凭据与生产操作边界

开发只需 GitHub 私仓访问及依赖下载。确需联调时，在本机仓库外或 Cloud 安全环境配置中提供对应测试环境的连接/令牌；不写进聊天、AGENTS、Git 或前端 VITE 变量。前端只允许 API 地址等公开配置，数据库 URL、静态访问串和模型 key 属于服务端。已部署 Worker 的 Secrets 由 Cloudflare 管理，应用经 Hyperdrive 连接 Neon，开发环境不自动获得该连接。

发布走已核实目标的 Wrangler 配置，账号模式启用要点见 `deployment/README.md`，示例中的 REPLACE 不是可用值。生产迁移、数据导入、服务恢复或付费调用先形成具体、可审阅的目标与影响，再按授权执行；回滚 Worker 不回滚 Neon 数据。

## 按模式准备最小配置

仅在需要本机 API 的开发任务中，从根 `.env.example` 复制到忽略的 `.env` 并填本次获准目标；不复制实际生产配置。纯 `/diagnostic-preview` 不需 `.env`、数据库或模型。`dev.sh` 检查配置的要求不等于必须恢复 Neon；可用的本地开发库也可满足连接契约，临时数据库测试仍用测试运行器。

Node static 最小为 DATABASE_URL_RUNTIME（或 DATABASE_URL）、APP_AUTH_MODE=static、APP_ACCESS_TOKEN、非空 DEEPSEEK_MODEL；模型占位只满足启动校验，不表示能推理。session 模式改为 APP_LOGIN_PASSWORD；none 仅限明确的本地开发，不能挂报告桥。真实模型调用才需要有效 provider/key 与实际预算授权。

账号模式的最小读取/保存配置见 [cloud-account.env.example](../../deployment/cloud-account.env.example)：独立 runtime/identity/auth URL、ACCOUNT_SECRET、base URL/trusted origins 和 App account/API base；先准备迁移与角色。注册关闭时不需要邮件配置；推理关闭时不需要有效模型 key，但 Node env 的 model 仍须非空。异步处理另需队列 dispatcher 或 Worker queue 绑定和明确预算。Worker 通过 FINDME_ACCOUNT_MODE 与独立 Hyperdrive 绑定组合，不把 Node URL 模板直接当 Wrangler 绑定配置。

旧 `packages/db/src/seed.ts` 与 seed 内容用于 legacy/测试素材，不是账号零历史起步的前置；API 启动不自动 seed。仓库外私人 U2/AV 文件和 FINDME_U3_OWNER_* 仅供冻结私有 adapter，不加入新账号最小配置。测试 DATABASE_URL_TEST 由 `pnpm test:db` 生成，无需在日常 `.env` 保存测试凭据。
