# FindMe — 命令入口

> 只描述仓库已有命令。不复制配置值、部署版本或执行结果；命令是否会连接数据库、调用模型或部署资源仍按实际副作用判断。

## 配置查找

- Worker 路由、绑定与非敏感变量：仓库根目录的 `wrangler.jsonc`、`wrangler.app.jsonc`。
- 脚本入口与参数：`package.json`、`apps/*/package.json` 和对应 `scripts/` 源码。
- 本机数据库连接、corpus 路径和访问串：本机忽略配置；仅向需要的进程传递，不输出密钥。
- 当前部署版本、健康和数据库迁移状态：需要时查询实际平台或服务，不从历史文档推定。

## 1. 文档与工作区只读检查

```bash
git status --short
git diff --check
git diff --stat
git ls-files '*.md'
```

注意 git diff 默认不包含未跟踪新文件；新文档需另查文件存在、正文和引用。不能把没有 diff 当成新文件已经验收。

## 2. 兼容开发与构建（有运行或文件副作用）

下列命令需单独的开发任务授权；使用现有本地忽略配置，不在文档中粘贴访问串。启动应用可能连接其配置的数据库，不因“本地开发”就默认只访问测试数据。

```bash
bash scripts/dev.sh
pnpm dev:api
pnpm dev:app
pnpm app:open
pnpm cf:dev
pnpm build
pnpm lint
pnpm format
```

`dev.sh` 启动 Node API 与目标 App，并将 App API 地址指向该本地 API；不要求本机 PostgreSQL。API 启动不再自动写入旧版 seed。旧 Node 轮询 worker 已移除，线上旧任务继续由 Cloudflare Queue 消费。目标客户端也可单独使用 `pnpm dev:app`；`pnpm app:open` 从本机忽略的 `.env` 读取现有访问串，用 URL fragment 打开已部署的目标 App，App 读取后立即清除 fragment。`pnpm build` 执行各包 build；`format` 会改文件，不能用作只读验收。

独立 Web 开发命令与 Taro 构建/watch 全套随两个客户端退役。手机 H5 与桌面均通过 `pnpm dev:app` / App 构建使用同一代码；不再提供小程序构建入口。

## 3. 测试与数据库命令

测试入口及覆盖边界见[第一阶段测试计划](delivery/phase-1-test-plan.md)。执行器不加载仓库 .env，不沿用生产连接或模型配置。

```bash
pnpm test:fast
pnpm test:app
pnpm test:local
pnpm test:local framework-runtime
pnpm test:db
pnpm test:db cloud-account-integration core-reliability
pnpm test:browser:synthetic
pnpm test:browser:real
pnpm test:browser
pnpm test:browser:maintenance
pnpm check:repo
pnpm test:coverage:local
pnpm test:coverage:db knowledge-processing
pnpm test
bash scripts/verify.sh
```

`test:fast` 选择显式轻量组；`test:local` 运行无数据库 API 合成回归和执行器自身测试，两者无文件筛选时也运行 App 单测。`test:app` 单独运行 App 单测。它们不代表浏览器或数据库验证。`test:db` 使用已可用的 Docker daemon 创建本次专用 PostgreSQL、迁移和三类账号测试角色，运行后清理本次容器、卷与临时配置；不会自行启动 Colima 或更改全局 Docker context。可通过 `DOCKER_CONTEXT` 选择已启动的专用实例。

`test:browser` 包含 synthetic 拦截 HTTP 和 real cookie/Better Auth/每视口新临时库两组；先安装 Chromium（`pnpm exec playwright install chromium`；Ubuntu CI 加 `--with-deps`）。`test:browser:maintenance` 仅验证保留的 App native/private，使用独立临时构建和模拟 HTTP；`pnpm test` 与 main CI 包含该组。`check:repo` 检查已跟踪文档与静态资源引用，不改文件、不连接服务。coverage 入口只生成所选 API local/db 的 V8 报告，不设全局阈值。

不带筛选的 `pnpm test` 串联 local/db、App 单测与所有浏览器组；带 API 文件筛选时只运行所选 API 范围，不声称完整通过。未覆盖的包明确列出而非空绿灯。文件筛选无匹配或数据库准备失败立即报错；直接 Vitest 调用需要运行器提供的分组环境，请用以上入口，不手工注入生产连接。`scripts/verify.sh` 在清洁环境中安装锁定依赖、lint、API 类型检查、构建并调用完整测试；它不再读取生产 .env 做指纹比较。

下列仍是独立的数据库开发/迁移命令，不是测试准备的必要手工步骤：

```bash
pnpm db:generate
pnpm db:migrate
```

`db:generate` 会改 schema 制品；`db:migrate` 使用实际配置的 DATABASE_URL_MIGRATION 或兼容连接选择，执行 SQL。只有测试运行器内部调用时，其目标才由运行器保证是本次临时库；单独执行时必须先核对目标。

## 4. 学习素材 bridge（不是个人会话导入）

下列命令使用操作者指定的 `FINDME_CORPUS_DIR`；这只是 CLI 路径占位，不是核心产品依赖。实际 corpus 位置读取本机忽略配置，不在多份正文维护路径副本。

```bash
node scripts/import-corpus-seeds.mjs --corpus "$FINDME_CORPUS_DIR"
node scripts/import-corpus-seeds.mjs --corpus "$FINDME_CORPUS_DIR" --require-ready
node scripts/import-corpus-seeds.mjs --corpus "$FINDME_CORPUS_DIR" --require-ready --min-materials 12 --min-questionnaires 12 --min-linked-materials 4 --min-theory-questionnaires 6 --require-material-types concept,figure,book --require-link-integrity
node scripts/import-corpus-seeds.mjs --corpus "$FINDME_CORPUS_DIR" --apply
```

不带 `--apply` 的命令按现有脚本检查 exports；`--apply` 合并 content_ready 到 seed JSON，会修改文件。数值参数是既有素材 bridge 验收样例，不是新的个人认识充分性标准。它不导入 AgentsView/TencentDB 的个人历史，不以本脚本实现 DA 的目标 adapter 契约。

## 5. 部署与资源创建

```bash
# 后端 API / health / internal 队列（不托管客户端静态资源）
pnpm cf:deploy

# 新目标 App（先 build，再发布 findme-app）
pnpm app:deploy

# 仅首次或明确需要新建资源时
pnpm exec wrangler queues create findme-tasks
pnpm exec wrangler queues create findme-tasks-dlq

# 已退役，仅作拒绝入口
bash scripts/deploy.sh
```

`pnpm cf:deploy` 发布 `wrangler.jsonc` 中的 Worker `findme`；`pnpm app:deploy` 使用 `wrangler.app.jsonc` 发布目标客户端 `findme-app` 到 `app.findme.example.com`。部署、migration 与资源创建均有外部副作用，需在明确实现/发布任务中执行。访问 secret 的名称及运行态只查当前配置和平台，不在文档中携带其值。

Worker 定时补发独立由 `FINDME_SCHEDULED_ENABLED` 控制，只有精确字符串 `"1"` 开启；未配置、`"0"` 或其他值均在创建数据库连接前结束。仓库 cron 列表为空；重新启用需要明确开启开关并配置所需 cron，仍保留账号模式不运行旧 dispatch 的限制。此开关不控制 HTTP 或 Queue consumer，不能用它停用队列：直接成功返回会有确认消息的风险。数据库停用期间已有队列消息仍按原有失败/重试/DLQ 策略处理；需要暂停消费时另行设计和授权，不自动恢复数据库。


## AV 本人小批内测

> 本机 dogfood/U2 流水线（本节、“AV 全量分层”“U1 整批内容覆盖与去向”“U2 个人理解基线”）已按 [ADR D23](adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役) 冻结：已有产物只经一次性导入进入账号模式。

入口 `pnpm av:dogfood help`；实现为 `apps/api/scripts/av-dogfood.ts`。API package 脚本使用当前 Node 的 `--env-file-if-exists` 读取 repo `.env`，已有进程环境可覆盖；模型仍经 M-X2 gateway，base URL 优先 `M_X2_BASE_URL`，兼容既有 `DEEPSEEK_BASE_URL`。不连接生产数据库。

- `freeze --db <AV SQLite 绝对路径> --out <仓库外新目录> --sessions 24 --holdout 6 --seed <固定值> --before <带时区 ISO 时间>`：只读事务采样、固定原文与 manifest；不启动 AV daemon/sync，不覆盖已存在批次。截止时间下无可解析时间的记录不进入该时间范围，系统/sidechain 不作为人工输入，显式 subagent 排除。
- `status --batch <批次绝对路径>`：只返回处理、审核和成本元数据，不调用模型。
- `extract --batch <目录> --session <开发会话 ID> --max-calls <1–30>`：默认 dry-run；加 `--live` 才调用模型。达到请求/字节预算后，未完成材料仍保持 pending/failed，不假装处理完整。
- `synthesize` / `compare --batch <目录> --live`：分别生成结构化候选，或在同一已处理范围内生成结构化/原文对照；不打开留出正文、不将一侧结果用作另一侧证据。
- `--retry-failed`：显式允许重试已失败且可能消耗过 tokens 的工作；已完成且输入未变的工作不重复调用，历史 usage 保留。
- `serve --batch <目录> --port 8795`：只绑定 `127.0.0.1`，入口 `/dogfood`，复用已构建的 `apps/app/dist`；需先 `pnpm --filter @findme/app build`。页面读操作不调用模型，生成按钮显式触发有限请求。该进程不是 production service，也不注册 launchd/systemd。
- `review` / `feedback`：需批次版本、幂等 key 和目标 ID；来源排除、片段归属/表达类型纠正、背景补充、解释异议和时间变化分别记录。原始载荷不改写。
- `export --batch <目录> --out <仓库外新文件>`：导出候选包及原始定位/审核/版本，不直接发布到正式 Core；不能覆盖已有文件。

首批预算和质量边界由 [AV 内测契约](implementation/av-dogfood-v0.1.md) 定义；实际账本在各批次外部状态中，usage 未知不能填零。只针对新代码运行不依赖 DB 的 `av-freeze`、`av-dogfood` 和 `llm-gateway-bounded` 测试；不因本功能执行旧 production-backed 测试或部署命令。原生 App 和线上认识不会因 staging 生成而改变。

### 本地 Codex CLI 模型出口

`--provider codex` 或本机忽略配置 `FINDME_DOGFOOD_PROVIDER=codex` 选择 Node-only 的 `apps/api/src/llm/codex-cli.ts`；不改变线上/API 模型配置。使用本机现有 `codex login` 登录态，默认读取本机 Codex 的模型与 reasoning effort；可用 `FINDME_CODEX_MODEL` / `FINDME_CODEX_REASONING_EFFORT` 显式选择，不修改全局 Codex 配置。

例如 `pnpm av:dogfood extract --provider codex --batch <批次> --session <开发会话ID> --max-calls 2 --live`。`serve --provider codex` 使用同一路由；用户切换出口后需要重启该本地 workbench 进程。只有鉴权等失败、尚无成功运行/候选/审核的批次允许换模型，并保留旧失败账本；已经产生结果的批次仍然锁定模型，不能混合比较。

每次以空工作目录、`codex exec --ephemeral --json --output-schema` 运行，不恢复旧 thread；关闭用户/项目指导注入、memory、hooks、shell、MCP/app/plugin 与其他工具入口，模型只处理所提供的数据。原始会话走 stdin，临时目录仅保存无私人内容的固定指令和输出 schema；工具事件出现则拒绝结果，reasoning 事件不保存。调用终止后清理临时目录。

Codex 是本地 CLI 调用联网模型，不是本机离线推理。usage 从 `turn.completed` 记录，缺失时为 null；CLI 单次执行不等于可观测的单次底层网络请求，不虚构 API 账单或免费额度。请求次数、输入估算预留、进程 timeout 和输出字节上限仍有约束，但输出 token 目标是 advisory，不声称 CLI 暴露了 API 的硬 `max_tokens`。账本明确标识 provider、CLI/model/effort 及限额能力；这些数据不能用来估算 DeepSeek 的生产价格。


## AV 全量分层（须已授权全量处理）

先由只读 freeze 的 `all` 模式固定完整有效人工会话及截止时间；全量模式允许显式继承试点 holdout ID/相关组。原始冻结批次不得覆盖，不能拿数据库总行数当作可用于本人分析的消息数。

- `pnpm av:layers <冻结批次绝对路径> --live`：执行 L1 原子候选、L2 确定性情境组织和 L3 有据综合；任务 checkpoint 与逐次 CLI usage 在该批次的 `jobs/`、`usage/` 下。完成检查读取 `completion.json`，过程读取 `progress.json`。
- `pnpm av:layers:view <批次绝对路径> [端口]`：启动只读 localhost 查看器，默认端口 8797，支持分层分页及证据到原消息定位；不触发模型，不发布线上。

全量预算、截止时间、完整性和候选语义见 [全量契约](implementation/av-full-layers.md)。旧 `av:dogfood` 工作台保留原小批审核/纠正路径，不因为生成全量文件就认为正式 Core 已接入全部历史。


## C1 合成诊断预览

优先按[开发环境的合成预览步骤](implementation/development-environment.md)启动 Vite 开发服务器，访问 `/diagnostic-preview?case=zero|fire|rich`。需要检查生产构建时，先在无生产配置的环境中以 `VITE_APP_AUTH_MODE=static VITE_APP_PRIVATE_TOOLS=true VITE_CORE_API_BASE="" pnpm --filter @findme/app build` 显式启用合成/私有工具，再运行 `pnpm --filter @findme/app preview --host 127.0.0.1 --port <未占用端口> --strictPort`。这些开关在构建时决定，不能只在 preview 时补传；account 生产构建始终不开放该入口。合成预览独立加载，不请求正式 API 或读取模型配置，不代表普通根路径已登录或接通真实资料。

状态键由 `diagnostic-preview/storage.ts` 定义，只作用于 C1 合成案例；草稿使用 `DiagnosticPreview.tsx` 的当前标签页命名空间。界面重置需确认，仅影响选中案例；导出可以包含用户在预览中自由输入的本机文字，不自动上传。不要以清空全部浏览器存储解决预览问题。

相关无数据库测试为 `apps/api/test/diagnostic-c1.test.ts`。这组测试验证契约和脚本状态机，浏览器回放另外检查交互、存储异常与布局；不将其通过描述为模型已经完成真实个人诊断。


## 有界取证、分析与复评

`pnpm diagnostic:reason --help` 对应 `apps/api/scripts/diagnostic-reasoning.ts`。这是 Node 私人验证入口，复用现有 Codex Gateway，不需要恢复 DeepSeek Key、不修改全局模型配置，不接 C1 合成页面或生产数据库。

- AV 取证：`pnpm diagnostic:reason --batch <冻结全量批次绝对路径> --question <本次问题> --out <仓库外诊断目录>`。可用 `--project <项目>`、`--before <带时区ISO时间>` 限定范围。读取 manifest/raw/L1 与现有审核，不改原批次；不读取 L3 作为个人证据。
- 明确提供的材料：用 `--packet <EvidencePacket文件绝对路径>` 替代 `--batch`；问题必须与 packet 一致。该模式使用明确提供的合格材料集，不要求它们再次通过词面召回；仍受引用、用途和体积限制。
- `--question-origin test_question` 标记由评测提出的 AV 问题，不冒充用户自述困扰。普通明确用户问题为 `user_request`；packet 使用自身记录的提出者。
- 默认 dry-run，仅生成选材与覆盖报告。`--live` 才启动分析及隔离上下文的语义复核；`--max-calls 1..4` 限制本次执行，完整分析通常需要为两阶段保留预算。输入估量、输出目标和 timeout 的实际限制由 runner/Gateway 源码定义，不把 CLI 执行数或字节估量当作底层请求数和计费 tokens。
- `--previous <已核验报告JSON绝对路径>` 对新输入复评，检查旧命题、版本和使用边界；新披露不等于新发生。`unchanged` 引用原命题与范围，不能让模型的改写悄悄改变旧判断。
- `--retry-failed` 明确允许重试失败或中断的工作，保留原始结果和 usage；相同输入/方法/模型已接受的结果直接复用，不重复调用。规则或来源变化不复用过时发布状态。

每次在输出目录的输入指纹子目录保留 input、原始模型输出、候选、审核、可读 Markdown 和逐阶段 usage；仅保存本次所需的来源快照，不能为每份报告复制整个 AV。截断 JSON 可通过显式 private capture 在解析前保留；默认应用日志不采集原文，模型内部 reasoning 不保存。
状态分别为 `dry_run`、`insufficient_evidence`、`ready_candidate`、`needs_review`、`stale`。`ready_candidate` 只表示通过当前结构/语义检查，仍待本人评价；立场、范围或反证相关问题不能通过标成 warning 绕过发布检查。未通过的报告保留为复核材料，不写正式个人模型。
当前 AV 检索采用原生分词与加权词面匹配、相关性优先的多样性约束；不能宣称语义召回充分或无遗漏。依赖指纹暂以整个冻结 manifest/raw/state/L1 保守失效，尚未实现精确到每个无关改动的定向缓存。读取报告本身不调用模型。

相关定向回归：`diagnostic-reasoning.test.ts`、`diagnostic-retrieval-rank.test.ts`、`diagnostic-raw-capture.test.ts`。只用合成 fixtures 和 mock 验证工程边界；真实调用与本人效果另留运行记录，不能由测试数量推导准确率。入口不启停任何服务、不进行全量语料重跑、迁移、推送或部署。


## U1 整批内容覆盖与去向

入口：`pnpm av:coverage --batch <既有冻结批次绝对路径> --out <仓库外且不在源批次内的新目录>`。默认仅执行库存、定位、覆盖与既有引用对账，不调用模型；数据源是已有 manifest/raw、L1、L2、L3 产物，不重新同步 AV。

加 `--live` 才启用既有 Codex Gateway，生成候选主题、逐原子主题映射和有界遗漏筛查；`--max-calls` 默认40，限制跨续跑累计 CLI 执行次数。普通取值为0..40；经明确授权的恢复可在同时指定 `--retry-failed` 时选择41..44，为超时任务保留最多4次额外执行余量，不自动加预算。失败/中断均留账，相同输入、协议和模型的已完成任务复用，不能以新目录或清零用量绕过限制。初次调用超时上限为120秒，显式重试可用180秒处理已诊断的慢调用；时间放宽不自动改变所选择的累计次数。CLI 是联网模型出口，不是离线推理或 API 账单。

live 输出通过 `latest.json`，默认盘点通过 `latest-inventory.json`，分别指向不可变的 `versions/<fingerprint>/`：`summary.json`、`source-coverage.jsonl`、`evidence-destinations.jsonl`、`topics.json`、`unresolved.jsonl`、`omission-review.json` 和 `report.md`。盘点不会替换已完成 live 指针。任务及原始模型输出在 `jobs/`，累计计量在 `usage.json`；live 最多两个任务并发，计量写入串行。原始 AV/L1–L3 不被覆盖，私人原文不进入 Git 或前端 bundle。

holdout 仅对账标识与数量，不参与主题发现、分类或筛查。主题映射、恢复表达和归属都是候选；程序处理完成不等于全量语义准确，更不等于 U2 个人诊断或 U3 App 已交付。未被旧 L3 引用不直接标为遗漏，分组输入、归纳提名和最终支持/反例分别记录。

当前执行结果与待处理项见 U1 执行记录；该记录不替代 [整体理解契约](implementation/av-understanding-app-delivery.md)。


## U2 个人理解基线

入口 `pnpm understanding:baseline --batch <冻结批次绝对路径> --coverage <U1根目录绝对路径> --out <独立U2输出目录绝对路径>`；实现 `apps/api/scripts/understanding-baseline.ts`。默认 dry-run，不调用模型、不更改原 AV／L1–L3／U1。U2 默认 provider 为 DeepSeek（`deepseek`，兼容 `ds`/`api` 别名），配置从仓库根 `.env` 读取；Codex 只有显式 `--provider codex` 或 `FINDME_UNDERSTANDING_PROVIDER=codex` 才启用。输出不得位于仓库、冻结批次或 U1 内，也不得是它们的父目录或通过符号链接绕过。

`--live` 仅在显式给出时使用所选 provider 执行命题用途映射、专题分析及独立上下文复核、综合报告、旧认识处置；所有调用共用一个累计账本。默认 DeepSeek API，`--provider codex` 才使用本机 Codex CLI。任何真实 `--live` 还必须显式给出 `--provider-call-cap N`（0..20），它限制本次命令新增的 provider 请求数，独立于累计 `--max-calls`；达到本轮 cap 后直接停止，不自动重试。`--max-calls` 普通范围0..40、默认40，包含失败和重试；经明确授权的恢复可在 `--retry-failed` 下显式选择41..71，不自动扩额、不清空原有用量。成功阶段按原输入/规则/模型指纹复用；规范化后的原始输出仍需重新通过原引用/语义要求，历史失败记录不改成成功。`--topic <domain>` 只分析选定专题，不发布完整基线；可在 help 中查看现有专题键。解析器接受的恢复上限不是预算授权，须在已批准上限内按实际阶段选值。报告级修订或其新审核再次失败后，同一修订指纹不因重复 `--retry-failed` 继续调用；成功修订的普通读取不需要再次授权模型。

时间投影保留原始失败、raw/input字节指纹和处理版本；缺失编码“null”、精确空串与“/null/”可机械规范化，错误日期与任意标签不能被清空。旧投影按原版本核验，新投影仍须独立语义审核。专题定向续跑结束后，可用相同输入及批准的累计上限执行不含 `--live` 的全范围命令，零调用汇总成功缓存和当前未决项；dry-run 不代表未完成专题已分析。

U1 `latest.json` 必须指向分类已完成版本，`latest-review.json` 的来源版本、摘要和文件字节指纹须与之匹配。U2读取时再次核对原文、用途、留出和复核来源；运行期间来源变化会拒绝发布并撤销当前指针，历史文件仍保留。归属意见仍是模型协调意见，不是本人确认。

U2保存 `plan.json`、`repairs.json`、`context.json`、`topics/`、`baseline.json`、`old-claim-review.json`、`source-refs.json`、`unresolved.json` 和阅读版 `report.md`。这些是仓库外有版本的候选投影，不是新的正式个人数据库。`latest-ready.json` 和 `latest-partial.json` 分开；`progress.json`、`usage.json`、`jobs/` 用于恢复与用量核验。缓存同时核验调用输入、原始输出和成品字节指纹；缺失/改变不会被假定为可用。

每个专题保留全体成员去向与本次有限选材，送模型的只有选定原文和必要背景，不把数千条省略ID反复输入。未决指代专题保留为 `context_required`，不从短确认词生成个人结论。项目自述修复只形成report-only用途，原L1不被静默改写。整体报告和框架结果分开：本入口不运行HUMAN 3.0评分，也不启动App服务或进行数据库迁移。

U2语义过程初次单次timeout为120秒，显式恢复运行可对已诊断的慢provider使用180秒，最多两个任务并行。DeepSeek API按provider返回记录usage并受请求输出上限约束；Codex CLI仅在显式选择时使用，其output token目标仍是advisory。usage缺失保持null，不虚构费用或token。实际结果见 U2执行记录。

显式 provider continuation 使用 `--provider deepseek --migrate-provider`，该命令必须与 `--live` 分开，调用数为0；`--preflight --migrate-provider` 仅检查迁移条件。对已存在候选且独立审核只指出可删除的局部对象，可用 `--topic DOMAIN --prune-rejected-candidate` 做零调用保守修订；该动作只允许已白名单的审核错误，删除被拒对象/依赖 link，必要时仅把未被拒的 surviving finding 原样提升为 current understanding，不改写文本，也不能和 `--live` 同时使用。应用后只写 `provider-migration.json` 与 `run.json.continuation_model/provider_migration_hash`，不改 usage、progress 或当前 pointer。历史 `run.model` 保留原 lineage；已完成旧模型 job 继续按原 fingerprint 复用，只有没有完成结果的新阶段才使用 continuation model 建立新 fingerprint，并在 job input 中记录 `lineage_model`。普通跨模型 live 若没有已验证 migration 证明仍直接拒绝。

原因绑定恢复先用 `--preflight`／`--recovery-status` 做只读检查；真实 CLI 会重读当前冻结批次和 U1 并核对 input hash，不写 `progress/usage/pointer`。恢复计划必须是绝对路径并绑定具体失败 job、字节指纹、错误类别和纠正说明；立场类还需同源命题提案。实际执行必须同时提供 `--recovery-plan ABS --live --retry-failed --max-calls N`，并继续使用同一 U2 out/ledger。解析器支持0..71只是能力；当前账本或明确授权的累计上限仍决定是否可执行，不能借参数自动扩额。

恢复只生成目标专题的 checkpoint/jobs，不直接发布完整基线；成功后仍需普通全范围 replay 经过所有专题、overall 和旧认识审核门禁。相同已完成计划零调用复用；第二条语义方案须绑定第一条实际新失败，第三条拒绝。若失败发生在 provider transport、没有 raw/候选/usage，允许有界技术重试；Codex CLI 仅 patch 版本变化且 model、reasoning effort、adapter 完全相同时可作为 transport migration，原计划 model identity 保留并另记 `runtime_model`，不能借此更换模型或语义规则。`--preflight` 返回的 required_calls 是剩余阶段数，不是token、费用或成功概率预测。


## U3 主 App 私有报告接入

> 已按 [ADR D23](adr.md#d23-账号模式云端数据库为唯一运行真源其余运行路径冻结或退役) 冻结：保留命令供核对既有数据，不再作为本人验收入口或新增功能。

源码入口为 `apps/api/scripts/understanding-app.ts`。在 API 包目录执行 `node --import tsx scripts/understanding-app.ts --help` 可查看参数，不启动服务或调用模型。显式启动时须给出 `--repo-root`、`--batch`、`--coverage`、`--baseline-dir`、`--state-dir`、`--app-build` 的绝对路径及一个未使用的 `--port`；访问串从 `FINDME_U3_OWNER_TOKEN` 环境变量读取，不放进仓库或命令行参数。

该宿主仅绑定 `127.0.0.1`，在 `/` 提供既有主 App 的构建，通过 `/api/understanding` 读取真实版本化报告。U2 根目录只读；`--state-dir` 仅保存新的 U3 用户回应、处理记录和报告修订，必须在仓库及 AV/U1/U2 之外，不能用来重置 U2 账本。私有宿主标记使 App 使用同源 API，不请求生产 Core；该模式通过专题回应继续理解，不提供原生 Core 探索。

`GET /api/understanding` 与 `GET /api/understanding/evidence?domain=...&version=...&id=...` 不触发模型。`GET /api/understanding/evidence/batch?domain=...&version=...&id=...&id=...` 可一次读取同报告版本下至多24条依据，重复或越界引用整次拒绝；主 App 展开依据采用批量入口，避免逐条重复重建与校验基线。`POST /api/understanding/feedback` 需要 Bearer、`Idempotency-Key` 及准确的基线/输入/报告版本，保存后返回回执和待分析状态，不以 Core operation 的 202 轮询替代实际实现。

默认 provider 关闭、U3 反馈调用预算为零。只有显式 `--enable-provider --feedback-max-calls N` 并调用 `POST /api/understanding/feedback/:id/process` 才可执行有界专题复评；客户端不能增额，预算不足不转成资料不足。GET 返回 capabilities、当前剩余调用、可执行动作和回应的 `required_calls`。未加工的新回应通常需要4次调用（归属／命题加工、独立资格审核、报告生成、独立报告审核）；同输入资格检查点可复用时通常只需后两次。所有阶段共用原 U3 累计账本，预算不足在处理前阻塞，不自动扩大限额。回应的 qualification 状态区分 pending、ready、context_only、rejected 与 not_applicable；报告接受状态另行计算。首次处理可用空 JSON；失败恢复须提交 `recover: true`，语义拒绝还需新的具体修订理由 `reason`，不能原样重审。逐次预留、模型可见信息、raw、usage（未返回为 null）及中断/失败保存在同一 U3 状态中，历史计量不重置。

`POST /api/understanding/overall/process` 接收 `{ request, recovery }`，其中 request 使用最新 GET 的 `capabilities.overall.request`，绑定基线、输入、原总览版本和依赖摘要；recovery 使用同一显式恢复格式。只重评已有合格 U2 总览在新 U3 回应之后的变化，尚无 U2 总览或专题仍待复核时不调用 provider。新总览需独立审核，指纹相同的已接受结果可零调用复用；读取或保存回应不会自动启动总览处理。该预算仅用于实际新增回应，不授权继续 U2 失败专题或初始化 U2 综合报告。实际模型运行及服务启动另按用户确定的执行范围进行。

简单自测：`pnpm test:local test/understanding-app.test.ts test/understanding-read-cache.test.ts` 使用合成 fixtures，不连接数据库。为避免影响共用构建的在用查看器，开发构建使用 `pnpm --filter @findme/app exec vite build --outDir <仓库外独立构建目录>`，不要覆盖 `apps/app/dist`。类型检查另运行 Core/API 的 `tsc --noEmit` 和 App 的 `tsc -b`；构建不等于启动或验收。

### Core 原生探索与报告回传（显式接入，默认关闭）

已有 `createApp` 接受可选 `reportService`，仅在已鉴权的运行态挂载统一报告接口；不是新的默认环境变量或自动启动命令。Node 组合入口可用 `PrivateUnderstandingRepository` 的 `coreBridge.owner` 与 `createCoreReportVerifier(db)` 配置当前来源校验，再经 `createPrivateCoreReportService(repository)` 注入。三者必须指向同一获准的 Core 主体；不把 Node 文件仓库导入 Worker，也不自动启用 provider、扩大预算或迁移数据。实际启用会读取配置的 Core 数据库，仍须明确运行范围。

`GET /api/core/capabilities` 返回原生探索及报告接入能力；主 App 只有报告接口和 Core 均确认可用时才展示原生路径。`POST /api/core/explorations` 可带 `report_target`（基线／输入／报告版本、专题及可选判断／问题），服务端验证后以原有 operation 幂等方式保存。该目标单独存于探索扩展，不拼进用户原始事件；未接入报告服务时拒绝带目标的请求，普通探索不受影响。

`POST /api/core/explorations/:id/report-feedback` 接收当前原始输入的 `source_id`、`assessment_version` 与 `content_hash`；不接受客户端覆盖原文或身份。服务端读取同主体、同探索的合格原话，使用来源／版本／目标派生的稳定幂等键回传；超过回应长度上限则拒绝，不截断。返回201与已保存／待加工回执，不调用模型、不发布新报告。报告复评仍由前述 U3 显式处理入口执行，读取或恢复探索不自动执行报告模型。

Core 来源复制后仍须在读取、处理和发布时校验当前资格；校验器未配置、身份/完整性错误直接失败。明确排除、删除、替换或版本/指纹变化会按根来源和实际报告依赖屏蔽相关专题/总览；可用原生 Core backend 时，`/api/understanding/sources/retire` 与 `/api/core/report-sources/rebind` 提供显式退役和安全重绑，受影响专题通过 `/api/understanding/topics/recover` 定向恢复。独立私有宿主没有 Core backend，因此重绑明确不可用，也不会因源码存在自动连接生产服务。

定向合成测试：`pnpm test:local test/core-report-bridge.test.ts test/core-report-temporal.test.ts`。测试使用合成来源、内存事务及可注入后端，不连接真实数据库；运行态 SQL、浏览器全流程和真实模型联调另行验收。


## U4 独立 Framework Runtime（私有同 App）

U4 复用 `apps/api/scripts/understanding-app.ts` 的同一个私有 host，不另开端口。默认仅能读取框架目录，HUMAN 3.0 内置定义为 draft 且不可启动。内部开发运行需显式 `--allow-draft-frameworks`；模型处理还须同时 `--enable-framework-provider --framework-max-calls N`。未启用 provider 时框架预算必须为0；U4 累计账本独立于 U2/U3，不互相借用或清零。

框架 API 位于 `/api/understanding/frameworks`：目录/定义读取、run start/read、respond、continue、amend、abandon 与 exact evidence 均使用同一 owner 鉴权。start/respond 只保存输入；`continue` 才可能生成一个后续问题、逐域评估或最终综合，并另做独立审核。所有 mutation 使用 `Idempotency-Key`，已有 run 的 mutation 还需准确 `expected_version`；技术失败必须显式 recovery，语义拒绝不能原样抽签重试。

主 App 的“独立框架访谈”读取同源相对路径，不使用生产 fallback。框架运行状态会同步到主“当前认识”中的 HUMAN 3.0 状态，但框架结果不自动写成原生 claim。草稿运行、合成自测或入口可见都不等于正式 HUMAN 3.0 完成；真人完整运行仍需本人逐题输入和实际审核。

定向自测：`pnpm test:local test/framework-runtime.test.ts test/framework-host-integration.test.ts`。该测试使用合成回答和注入 gateway，不调用真实模型、不连接数据库或启动 host。


## C2–C4 账号云端模式（显式启用）

Node选择 `APP_AUTH_MODE=account`，Cloudflare选择 `FINDME_ACCOUNT_MODE=1`；客户端在后续构建时选择 `VITE_APP_AUTH_MODE=account`。这些变量没有写入现用环境。服务端账号由 `createAccountAuth` 配置BetterAuth/pg，使用独立runtime、identity、auth数据库凭据与受信任Origin；部署说明和示例变量见 `deployment/`。

`pnpm --filter @findme/api owner-account:create` 是交互式真实建号命令，会读取认证与身份数据库连接、要求终端输入邮箱和密码，并把新登录绑定到既有 `findme-runtime/owner` 本人作用域；缺少该作用域时拒绝，不创建新租户。它不是只读检查，不随构建或预览运行，实际执行需另行决定目标数据库与范围。

`/api/profiles` 提供账号拥有的Profile创建、列表、改名、归档/恢复。业务读取携带 `X-FindMe-Profile`，服务端核对membership。旧records/insights等无scope接口在account模式不挂载。

`/api/diagnostics` 创建/读取专题；`/:id/responses` 幂等保存原话，不触发模型；`/:id/process/plan` 只检查实际选材与请求阶段；`/:id/process` 在明确 `provider_call_cap` 下落库排队；`/jobs/:id/resume` 需显式新任务总cap，累计已用次数保留；cancel只停止后续与发布，不能承诺取消已经发出的计费请求。公开API不接受客户端提交“已审核报告”。history与evidence按当前scope和来源版本读取。

正式任务由同Worker的队列consumer领取；scheduled handler在account模式不启动推理。Node如需队列，必须配置私有HTTPSdispatcher和token。服务端 `CLOUD_INFERENCE_ENABLED` 默认关闭，Profile预算默认0；Framework独立预算默认0，continue另有调用确认。对话处理（`/api/core/explorations/:id/continue`、`/correct`）另由 `CORE_MODEL_DAILY_OPERATION_LIMIT` 控制：每个 Profile 滚动 24 小时的自动处理次数，默认0即关闭，需同时打开推理总开关；`GET /api/core/model-status` 只读返回用量，依据见 ADR D26。不存在绕过M-X2或切换个人Codex的云端fallback。

`/api/blobs` 管理原档声明和鉴权内容传输；上传/删除/恢复属于真实对象副作用，仅在明确用户操作后执行。`/api/data/imports/prepare`、`restore-prepare` 只生成导入分片；preview保存预览，commit必须携带对应input_hash与confirm=true。导入不等于资格审核或发布旧L3。

`/api/data/sources/:id/actions` 对来源排除/恢复/删除要求前置摘要与评估版本，删除另需来源ID确认；rebind只接受当前Profile的替代来源。`/api/data/export` 返回覆盖清单，按part/cursor完整遍历，原档另外下载。`/api/data/erase-profile` 强确认后分步清理，失败使用同Idempotency-Key恢复，不以新key重开任务。

离线文件转换代码：`apps/api/scripts/prepare-core-ingest.ts --input ABS --out NEW_ABS_DIR --namespace NAME [--restore-export]`。只有显式执行才读取指定文件、写私人转换结果，不联网、不导入、不调用模型。输出拒绝仓库内部目录，文件采用私有权限。

AV 加工归档准备器：在 `apps/api` 下执行 `node --import tsx scripts/prepare-av-processed-archive.ts --batch ABS --u1 ABS --u2 ABS --tenant-id UUID --subject-id UUID --namespace NAME --out NEW_ABS_DIR`。只读加工白名单，排除原始会话与整个 jobs 树；输出 gzip 去重包、事务 SQL 分片和传输清单到仓库/来源之外的新私人目录。不读取 `.env`、联网、建表、导入或调用模型。`apps/api/scripts/av-processed-archive-schema.sql` 是历史两表补充 DDL；新库及精确旧表接管已由 journal 0012 纳管，不再作为正常新装的额外步骤；实际操作与验收见 归档执行记录。

必要 App 快照准备器：在 `apps/api` 下执行 `node --import tsx scripts/prepare-understanding-runtime.ts --repo-root ABS --batch ABS --coverage ABS --baseline-dir ABS --state-dir ABS --source-archive ARCHIVE_JSON --tenant-id UUID --subject-id UUID --out NEW_ABS_DIR`。只在既有读取资格/版本/证据检查之后生成私人便携快照和导入分片；源归档必须完整且归属一致，若发现真实反馈则拒绝隐式遗漏。它不联网、不读取 `.env`、不写数据库或调用模型。快照包含私人报告与精确片段，不进入前端公共 assets 或 Git。

Worker 归档读取由 `wrangler.jsonc` 中的非秘密哈希变量显式启用，仅支持既有 static 鉴权和同一本人归属；绑定接口不启用反馈/加工。`./node_modules/.bin/wrangler deploy --dry-run --config wrangler.jsonc --outdir ABS` 仅构建，正式 deploy 才发布。实际发布、验证和清理边界见 云端读取与项目清理记录。

账号模式迁移链包含 0009、0010；知识与专项路径新增 `0011_specialist.sql` 及 schema 快照。`drizzle-kit generate` 只生成本地 schema 制品；`drizzle-kit check` 核对迁移快照和日志一致性，不连接数据库，也不证明手写 SQL 已成功应用；`db:migrate` 会连接数据库并执行 SQL。完整 Core 访问策略 `packages/db/access/account-runtime.sql` 单独审阅应用，不能在旧运行角色仍用于线上时直接启用。目标库实际应用状态须操作时核对，不能从本地迁移文件或历史记录推断。journal 0012 的归档新建/精确旧结构接管、旧 DDL 兼容与独立角色策略见[迁移与兼容方案](delivery/phase-1-migration.md)；隔离验证的历史范围见配置与最小验证记录。

早期开发阶段的未验证范围见 C系列开发记录，之后获准的隔离验证和static读取发布分别见对应执行记录。不能把历史不测试要求或旧执行结果当作当前命令的副作用定义。


## C 系列隔离验证与预览

此前隔离验证的已执行范围和日志入口见 `execution/c-series-activation.md`；该历史授权不决定当前任务是否运行测试。生产 `.env`、现用 wrangler、U2 账本不得用验证配置覆盖。

`pnpm test:db cloud-account-integration` 自动准备独立 runtime/identity/auth 测试登录并运行账号云端合成验证；不需要复制旧临时分支的配置。测试邮件由回调捕获，不投递真实邮件、不调用模型。旧 FINDME_ACCOUNT_VERIFY_CONFIG 是执行器与测试套件之间的临时配置，不是部署配置。

`test/account-session-context.test.ts` 与 `test/llm-gateway-bounded.test.ts` 是零模型回归；account health 检查共享角色门禁，不读取旧全局 async_tasks。独立 App build 的 outDir 必须在运行目录，不能覆盖在用 dist。部署预览只使用运行目录 `wrangler.isolated.json`，不得改成默认生产 wrangler。

DS余额/模型目录只读鉴权失败时，不发生成请求、不自动重试或切回Codex。密钥更新在本机安全配置或指定Secret Store完成，不写聊天、Git或执行日志。

## 开发环境

依赖准备、无生产连接的前端预览与凭据边界见[开发环境](implementation/development-environment.md)。`scripts/dev.sh` 必须读取本机 `.env`；`scripts/verify.sh` 在清洁环境安装、检查、构建并运行含临时数据库的测试，不用作仅安装依赖的环境 setup。离线AV准备器仍需要明确提供私有输入路径；当前repo不携带这些材料，不能从源码单独重建既有私人加工结果。

## 备份与恢复入口

`bash scripts/backup.sh` 和 `bash scripts/restore.sh /绝对路径/db.sql.gz` 会读写实际数据；连接优先级、空库约束、加密与未覆盖对象、恢复核对统一见 [Runbook](runbook.md#6-备份与恢复的现有脚本)。不要将个人 export 的 restore-prepare 当作数据库恢复。

### 当前策略只读查询

`pnpm --filter @findme/api exec tsx scripts/policy-inspect.ts [精确key或摘要]` 读取当前源码策略目录；不加载 .env、不连接数据库、不调用 provider 或写历史映射。unknown/ambiguous 不能当作旧记录损坏，见[C 系列血缘契约](implementation/c-series-cloud-runtime.md#7-策略和处理血缘)。

### 仓库引用检查

`node scripts/check-repository.mjs` 只读检查受跟踪 Markdown 的相对链接/锚点、HTML/CSS 静态引用和 Web manifest 图标，不读取 `.env`、私人语料或连接服务。动态 hash 路由交由既有浏览器回归验证；它不证明链接中的外部网站在线，也不替代产品或迁移测试。检查器回归可用 `node scripts/test.mjs local cleanup`。
