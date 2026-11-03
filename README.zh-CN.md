# FindMe

[English](README.md) | 简体中文

FindMe 以构建“赛博分身”为长期愿景：一个持续深入了解本人经历、处境、价值取舍与思考方式，同时具备独立、足够客观判断的硅基分身。它帮助本人认识自己、获得开导与建议，并结合个人依据和相关学术知识，诚实检验自我辩护、过度自责以及系统自身的误读。

对话、主动引导、学习、反馈和导入语料都是持续构建、修订这份理解的方法；报告与个人发展诊断承载其中的综合判断。用户可以从一件具体经历或一个容易回应的问题开始，不必准备大量历史资料或先选人格标签。未来实现形式保持开放；“agent＋人格蒸馏 Skill”只是可能方案，不是既定架构。

[第一阶段](docs/delivery/phase-1-personal-understanding.md)先交付可用基础：在同一入口形成可阅读、可对话、可纠正、能被新信息真实更新的个人理解。现有 Core 与账号模式代码可复用，但代码、本地合成回归、部署、真实模型质量和本人效用分别验收；是否可供本人使用、阶段是否完成，以[业务接受记录](docs/delivery/acceptance.md)为准。

## 仓库结构

这个 pnpm monorepo 包含：

- `apps/app/` — 唯一的 React 19 + Vite 浏览器单页应用（SPA），手机 H5 与桌面共用代码
- `apps/api/` — API 与处理服务
- `packages/core/`、`packages/db/`、`packages/shared/` — 领域逻辑、数据库结构与共享契约
- `docs/` — 产品与架构参考、实现契约和命令说明

按 [ADR D25](docs/adr.md#d25-直接退役两个独立客户端统一使用-appsapp-浏览器入口)，仓库已退役 `apps/web`、`apps/miniapp` 两个独立客户端，旧运行模式、Cloudflare/Neon 路径及其数据表随后已移除，应用以单节点运行。这不表示第一阶段已验收。当前源码实现边界见 [As-Is](docs/as-is.md)。

## 开发入口

`package.json` 声明使用 Node.js 22+ 和 pnpm 9.15.9。按锁文件安装依赖：

```bash
pnpm install --frozen-lockfile
```

根目录脚本包括 `pnpm dev:app`、`pnpm dev:api`、`pnpm build` 和 `pnpm test`。`pnpm test:local` 运行无数据库合成回归，`pnpm test:db` 自动准备一次性 Docker PostgreSQL；`pnpm test:fast` 提供快速反馈，`pnpm test:app` 独立运行 App 单测；无筛选的 `pnpm test` 还包含合成/真实临时库浏览器，需要已可用的 Docker daemon 和 Chromium（`pnpm exec playwright install chromium`），范围与未覆盖层见[第一阶段测试计划](docs/delivery/phase-1-test-plan.md)。启动服务或运行数据库相关命令前，请先阅读[命令说明](docs/commands.md)，了解配置要求和副作用。依赖安装与本地预览指引见[开发环境](docs/implementation/development-environment.md)。

## 自部署

单节点部署（网页、API、后台处理与 PostgreSQL 用 Docker Compose 运行，在目标服务器从源码构建）见 [deployment/standalone](deployment/standalone/README.md)。模型调用默认关闭，需自行配置接口凭据和预算。

## 文档导航

- [产品总览](docs/overview.md) — 产品方向与边界
- [第一阶段范围与验收](docs/delivery/phase-1-personal-understanding.md) — 必需结果、验收条件与后续能力边界
- [As-Is](docs/as-is.md) — 源码当前支持的行为
- [路线图](docs/roadmap.md) — 后续工作与进入条件
- [命令说明](docs/commands.md) — 开发、验证和运行命令
- [BA](docs/ba.md)、[AA](docs/aa.md)、[DA](docs/da.md) 与 [TA](docs/ta.md) — 业务、应用、领域与技术架构
- [实现契约](docs/implementation/) — 详细行为与集成边界
- [Assets](assets/README.md) — 品牌与界面素材

产品和架构文档说明预期行为，As-Is 说明已实现行为，Roadmap 说明剩余工作。此 README 用于快速了解项目，不表示计划能力已经完成。


文档修复与原审查编号对照见[债务台账](docs/delivery/debt-resolution.md)；实际本人接受见[第一阶段接受记录](docs/delivery/acceptance.md)。环境模板须按[模式选择](docs/implementation/development-environment.md#本机开发配置)，旧 seed 不作为账号零历史起步的前置。

## 许可证

FindMe 以 [GNU Affero General Public License v3.0](LICENSE) 发布。
