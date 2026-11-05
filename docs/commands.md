# FindMe — 命令入口

> 只描述仓库已有命令。不复制配置值、部署版本或执行结果；命令是否会连接数据库、调用模型或部署资源仍按实际副作用判断。

## 配置查找

- 单节点运行配置：实例上的 `runtime.env`（部署脚本生成）与 `deployment/standalone/compose.yaml`；模型服务配置在数据库 `app_settings`，由运营方在实例上维护，修改后重启应用生效；App 不提供修改入口。
- 脚本入口与参数：`package.json`、`apps/*/package.json` 和对应 `scripts/` 源码。
- 本机数据库连接、corpus 路径和访问串：本机忽略配置；仅向需要的进程传递，不输出密钥。
- 当前部署版本与健康：查询实例上的 `deployed-commit` 与 `/ready`，不从历史文档推定。

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
pnpm build
pnpm lint
pnpm format
```

`dev.sh` 读取本机 `.env`（模板见 `.env.example`），启动 Node API 与 App，并将 App API 地址指向该本地 API；需要一个已按 `packages/db/schema.sql` 与 `packages/db/access/account-runtime.sql` 初始化的 PostgreSQL。API 启动不写入 seed。App 也可单独使用 `pnpm dev:app`。`pnpm build` 执行各包 build；`format` 会改文件，不能用作只读验收。

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
pnpm check:repo
pnpm test:coverage:local
pnpm test:coverage:db knowledge-processing
pnpm test
bash scripts/verify.sh
```

`test:fast` 选择显式轻量组；`test:local` 运行无数据库 API 合成回归和执行器自身测试，两者无文件筛选时也运行 App 单测。`test:app` 单独运行 App 单测。它们不代表浏览器或数据库验证。`test:db` 在 Instabox 实例上使用其 Docker daemon 创建本次专用 PostgreSQL、按 `packages/db/schema.sql` 建表并创建三类账号测试角色，运行后清理本次容器、卷与临时配置；本机不跑测试。可通过 `DOCKER_CONTEXT` 选择已启动的专用实例。

`test:browser` 包含 synthetic 拦截 HTTP 和 real cookie/Better Auth/每视口新临时库两组；先安装 Chromium（`pnpm exec playwright install chromium`；Ubuntu CI 加 `--with-deps`）。`check:repo` 检查已跟踪文档与静态资源引用，不改文件、不连接服务。coverage 入口只生成所选 API local/db 的 V8 报告，不设全局阈值。

不带筛选的 `pnpm test` 串联 local/db、App 单测与所有浏览器组；带 API 文件筛选时只运行所选 API 范围，不声称完整通过。未覆盖的包明确列出而非空绿灯。文件筛选无匹配或数据库准备失败立即报错；直接 Vitest 调用需要运行器提供的分组环境，请用以上入口，不手工注入生产连接。`scripts/verify.sh` 在清洁环境中安装锁定依赖、lint、API 类型检查、构建并调用完整测试；它不再读取生产 .env 做指纹比较。

## 4. 部署

单节点部署、换节点与故障定位只在 [单节点部署](../deployment/standalone/README.md) 维护。部署会构建镜像并启停实例上的服务，属于有副作用的操作。

## AV 本人小批内测

> 本机 dogfood/U2 离线流水线（本节、“AV 全量分层”“U1 整批内容覆盖与去向”“U2 个人理解基线”）已冻结，不接入运行中的 App；其产物以后由导入适配器处理。原 `av:dogfood` 命令、本地 `serve` 页面与 App 内 Dogfood 页已移除，下列子命令说明仅作离线代码的接口参考。

实现位于 `apps/api/src/dogfood/`。离线脚本使用当前 Node 的 `--env-file-if-exists` 读取 repo `.env`；模型经 M-X2 gateway。不连接运行中的数据库。

- `freeze --db <AV SQLite 绝对路径> --out <仓库外新目录> --sessions 24 --holdout 6 --seed <固定值> --before <带时区 ISO 时间>`：只读事务采样、固定原文与 manifest；不启动 AV daemon/sync，不覆盖已存在批次。截止时间下无可解析时间的记录不进入该时间范围，系统/sidechain 不作为人工输入，显式 subagent 排除。
- `status --batch <批次绝对路径>`：只返回处理、审核和成本元数据，不调用模型。
- `extract --batch <目录> --session <开发会话 ID> --max-calls <1–30>`：默认 dry-run；加 `--live` 才调用模型。达到请求/字节预算后，未完成材料仍保持 pending/failed，不假装处理完整。
- `synthesize` / `compare --batch <目录> --live`：分别生成结构化候选，或在同一已处理范围内生成结构化/原文对照；不打开留出正文、不将一侧结果用作另一侧证据。
- `--retry-failed`：显式允许重试已失败且可能消耗过 tokens 的工作；已完成且输入未变的工作不重复调用，历史 usage 保留。
- `review` / `feedback`：需批次版本、幂等 key 和目标 ID；来源排除、片段归属/表达类型纠正、背景补充、解释异议和时间变化分别记录。原始载荷不改写。
- `export --batch <目录> --out <仓库外新文件>`：导出候选包及原始定位/审核/版本，不直接发布到正式 Core；不能覆盖已有文件。

首批预算和质量边界由 [AV 内测契约](implementation/av-dogfood-v0.1.md) 定义；实际账本在各批次外部状态中，usage 未知不能填零。只针对新代码运行不依赖 DB 的 `av-freeze` 和 `llm-gateway-bounded` 测试；不因本功能执行旧 production-backed 测试或部署命令。原生 App 和线上认识不会因 staging 生成而改变。

### 本地 Codex CLI 模型出口

`--provider codex` 或本机忽略配置 `FINDME_DOGFOOD_PROVIDER=codex` 选择 Node-only 的 `apps/api/src/llm/codex-cli.ts`；不改变线上/API 模型配置。使用本机现有 `codex login` 登录态，默认读取本机 Codex 的模型与 reasoning effort；可用 `FINDME_CODEX_MODEL` / `FINDME_CODEX_REASONING_EFFORT` 显式选择，不修改全局 Codex 配置。

离线 `av:layers`、`diagnostic:reason` 等脚本可经该出口调用。只有鉴权等失败、尚无成功运行/候选/审核的批次允许换模型，并保留旧失败账本；已经产生结果的批次仍然锁定模型，不能混合比较。

每次以空工作目录、`codex exec --ephemeral --json --output-schema` 运行，不恢复旧 thread；关闭用户/项目指导注入、memory、hooks、shell、MCP/app/plugin 与其他工具入口，模型只处理所提供的数据。原始会话走 stdin，临时目录仅保存无私人内容的固定指令和输出 schema；工具事件出现则拒绝结果，reasoning 事件不保存。调用终止后清理临时目录。

Codex 是本地 CLI 调用联网模型，不是本机离线推理。usage 从 `turn.completed` 记录，缺失时为 null；CLI 单次执行不等于可观测的单次底层网络请求，不虚构 API 账单或免费额度。请求次数、输入估算预留、进程 timeout 和输出字节上限仍有约束，但输出 token 目标是 advisory，不声称 CLI 暴露了 API 的硬 `max_tokens`。账本明确标识 provider、CLI/model/effort 及限额能力；这些数据不能用来估算 DeepSeek 的生产价格。


## AV 全量分层（须已授权全量处理）

先由只读 freeze 的 `all` 模式固定完整有效人工会话及截止时间；全量模式允许显式继承试点 holdout ID/相关组。原始冻结批次不得覆盖，不能拿数据库总行数当作可用于本人分析的消息数。

- `pnpm av:layers <冻结批次绝对路径> --live`：执行 L1 原子候选、L2 确定性情境组织和 L3 有据综合；任务 checkpoint 与逐次 CLI usage 在该批次的 `jobs/`、`usage/` 下。完成检查读取 `completion.json`，过程读取 `progress.json`。
- `pnpm av:layers:view <批次绝对路径> [端口]`：启动只读 localhost 查看器，默认端口 8797，支持分层分页及证据到原消息定位；不触发模型，不发布线上。

全量预算、截止时间、完整性和候选语义见 [全量契约](implementation/av-full-layers.md)。生成全量文件不等于正式 Core 已接入全部历史。


## C1 合成诊断预览

优先按[开发环境的合成预览步骤](implementation/development-environment.md)启动 Vite 开发服务器，访问 `/diagnostic-preview?case=zero|fire|rich`。该入口只在开发服务器（`import.meta.env.DEV`）中开放，生产构建不包含。合成预览独立加载，不请求正式 API 或读取模型配置，不代表普通根路径已登录或接通真实资料。

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

输出的用途与验收口径见 [整体理解契约](implementation/av-understanding-app-delivery.md)。


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


## 独立 Framework Runtime

框架在账号 App 的“独立框架”中运行，API 位于 `/api/understanding/frameworks`：目录/定义读取、run start/read、respond、continue、amend、abandon 与 exact evidence。HUMAN 3.0 内置定义为 draft，不可启动。start/respond 只保存输入，回答作为本人来源写入 `source_items`；`continue` 才可能生成后续问题、逐域评估或最终综合，并另做独立审核，受模型设置中的框架调用额度约束。所有 mutation 使用 `Idempotency-Key`，已有 run 的 mutation 还需准确 `expected_version`。框架结果不自动写成 Core 认识。

定向自测：`pnpm test:local framework-runtime`，使用合成回答和注入 gateway，不调用真实模型、不连接数据库。


## C2–C4 账号云端模式（显式启用）

账号模式是唯一运行方式。服务端账号由 `createAccountAuth` 配置 BetterAuth/pg，使用独立 runtime、identity、auth 数据库凭据与受信任 Origin；部署见 [单节点部署](../deployment/standalone/README.md)。

`pnpm --filter @findme/api owner-account:create` 是交互式真实建号命令，会读取认证与身份数据库连接、要求终端输入邮箱和密码，并把新登录绑定到既有 `findme-runtime/owner` 本人作用域（登录签发者固定为 `findme-account`，与网址无关）；缺少该作用域时拒绝，不创建新租户。它不是只读检查，不随构建或预览运行，实际执行需另行决定目标数据库与范围。

`/api/profiles` 提供账号拥有的Profile创建、列表、改名、归档/恢复。业务读取携带 `X-FindMe-Profile`，服务端核对membership。`/api/settings/model` 读写实例的模型设置（密钥只写不读）。

`/api/diagnostics` 创建/读取专题；`/:id/responses` 幂等保存原话，不触发模型；`/:id/process/plan` 只检查实际选材与请求阶段；`/:id/process` 在明确 `provider_call_cap` 下落库排队；`/jobs/:id/resume` 需显式新任务总cap，累计已用次数保留；cancel只停止后续与发布，不能承诺取消已经发出的计费请求。公开API不接受客户端提交“已审核报告”。history与evidence按当前scope和来源版本读取。

任务由应用进程内的执行器从任务表领取。模型调用开关默认关闭，Profile预算默认0；Framework独立预算默认0，均为运营方维护的服务端配置。对话处理（`/api/core/explorations/:id/continue`、`/correct`、`/reply`）另由“对话自动处理次数”控制：每个 Profile 滚动 24 小时的自动处理次数，默认0即关闭，需同时打开推理总开关；`GET /api/core/model-status` 只读返回用量，依据见 ADR D26。不存在绕过M-X2或切换个人Codex的云端fallback。

`/api/blobs` 管理原档声明和鉴权内容传输，每个原档登记时生成一条 `original_file` 来源（作者未知、事件时间未知）；上传/删除/恢复属于真实对象副作用，仅在明确用户操作后执行。`/api/data/imports/prepare`、`restore-prepare` 只生成导入分片；preview保存预览，commit必须携带对应input_hash与confirm=true。导入不等于资格审核或发布旧L3。

`/api/data/sources/:id/actions` 对来源排除/恢复/删除要求前置摘要与评估版本，删除另需来源ID确认；rebind只接受当前Profile的替代来源。`/api/data/export` 返回覆盖清单，按part/cursor完整遍历，原档另外下载。`/api/data/erase-profile` 强确认后分步清理，失败使用同Idempotency-Key恢复，不以新key重开任务。

离线文件转换代码：`apps/api/scripts/prepare-core-ingest.ts --input ABS --out NEW_ABS_DIR --namespace NAME [--restore-export]`。只有显式执行才读取指定文件、写私人转换结果，不联网、不导入、不调用模型。输出拒绝仓库内部目录，文件采用私有权限。

AV 加工归档准备器：在 `apps/api` 下执行 `node --import tsx scripts/prepare-av-processed-archive.ts --batch ABS --u1 ABS --u2 ABS --tenant-id UUID --subject-id UUID --namespace NAME --out NEW_ABS_DIR`。只读加工白名单，排除原始会话与整个 jobs 树；输出 gzip 去重包、事务 SQL 分片和传输清单到仓库/来源之外的新私人目录。不读取 `.env`、联网、建表、导入或调用模型。归档两表已包含在 `packages/db/schema.sql` 中。

必要 App 快照准备器：在 `apps/api` 下执行 `node --import tsx scripts/prepare-understanding-runtime.ts --repo-root ABS --batch ABS --coverage ABS --baseline-dir ABS --state-dir ABS --source-archive ARCHIVE_JSON --tenant-id UUID --subject-id UUID --out NEW_ABS_DIR`。只在既有读取资格/版本/证据检查之后生成私人便携快照和导入分片；源归档必须完整且归属一致，若发现真实反馈则拒绝隐式遗漏。它不联网、不读取 `.env`、不写数据库或调用模型。快照包含私人报告与精确片段，不进入前端公共 assets 或 Git。



## C 系列隔离验证与预览

实例的 `runtime.env` 与 U2 账本不得用验证配置覆盖。

`pnpm test:db cloud-account-integration` 自动准备独立 runtime/identity/auth 测试登录并运行账号云端合成验证；不需要复制旧临时分支的配置。测试邮件由回调捕获，不投递真实邮件、不调用模型。旧 FINDME_ACCOUNT_VERIFY_CONFIG 是执行器与测试套件之间的临时配置，不是部署配置。

`test/account-session-context.test.ts` 与 `test/llm-gateway-bounded.test.ts` 是零模型回归；account health 检查共享角色门禁。

模型服务鉴权失败时，不发生成请求、不自动重试或切回Codex。密钥只存于实例的服务端配置，不写聊天、Git或执行日志。

## 开发环境

依赖准备、无生产连接的前端预览与凭据边界见[开发环境](implementation/development-environment.md)。`scripts/dev.sh` 必须读取本机 `.env`；`scripts/verify.sh` 在清洁环境安装、检查、构建并运行含临时数据库的测试，不用作仅安装依赖的环境 setup。离线AV准备器仍需要明确提供私有输入路径；当前repo不携带这些材料，不能从源码单独重建既有私人加工结果。

### 当前策略只读查询

`pnpm --filter @findme/api exec tsx scripts/policy-inspect.ts [精确key或摘要]` 读取当前源码策略目录；不加载 .env、不连接数据库、不调用 provider 或写历史映射。unknown/ambiguous 不能当作旧记录损坏，见[C 系列血缘契约](implementation/c-series-cloud-runtime.md#7-策略和处理血缘)。

### 仓库引用检查

`node scripts/check-repository.mjs` 只读检查受跟踪 Markdown 的相对链接/锚点、HTML/CSS 静态引用和 Web manifest 图标，不读取 `.env`、私人语料或连接服务。动态 hash 路由交由既有浏览器回归验证；它不证明链接中的外部网站在线，也不替代产品或迁移测试。检查器回归可用 `node scripts/test.mjs local cleanup`。

## 对话与已有理解导入

`apps/api/scripts/prepare-understanding-import.ts --input ABS_JSON --out NEW_ABS_DIR`在本机校验`findme-understanding-import@1`或`@2`包，输出规范化`bundle.json`和只含哈希/数量的manifest。经`pnpm --filter @findme/api exec tsx scripts/prepare-understanding-import.ts ...`运行；输入与输出必须用绝对路径，输出目录须为仓库外的新目录。命令不连接数据库、不调用模型，不把私人正文写入日志或Git；`@2`包的清单另含`format`、经历数和问答绑定数。

账号API提供`POST /api/data/understanding-imports/preview`（输入bundle，返回校验哈希和数量）、`POST /api/data/understanding-imports`（`bundle`、预览的`input_hash`、`confirm: true`）及`GET /api/data/understanding-imports/:id`读回（来源、修订、反馈，以及每条证据所属的独立组与说明）。保存使用认证Profile事务；同一namespace同内容重放返回原回执，不重复创建；同namespace不同内容拒绝覆盖。此入口导入一个固定会话快照及其中已有的修订历史，不是跨快照自动合并器。

`@2`在`@1`之上增加两类可选信息，`@1`包的解析、哈希与写入保持不变：

- **选择题回答**：认识修订可带`answer_binding`——问题原文片段、同一条助手消息中的全部选项（标签、文字、位置）、本次所选标签、本条认识对应的标签和用户回答片段，均须与来源逐字相符且回答晚于提问。此类认识必须是`self_report`，起点是用户的回答片段，正文是明确标为派生概括的文字，不能等于任何原话；回答由提问引出（`elicited_by`），写库时该证据行的说明如此标注。只表示认同某句描述的回答（如“很像”）不建成认识，改为指向该命题修订的反馈。
- **经历分组**：批次用`experiences`声明经历（键、标签、性质`occurred`/`hypothetical`/`ongoing`/`recurring`、有效时间可未知），证据与起点片段用`experience_key`指向一个经历；同一经历的证据共用独立组`import:<前缀>:<经历键>`，未指定经历的证据保持整批共用组`import:<前缀>`，导入不会自动拆分。分组依据是实际经历而不是话题或消息；同一精确片段只能属于一个经历，声明了而无证据的经历被拒绝。经历键应是不含内容的标识，因为它会进入独立组名。

原始用户/助手发言分别保存为来源；助手洞察只存为候选或明确的历史状态，不自动进入当前认识，不将总体认可拆成逐条确认。来源片段以UTF-16位置精确核对；修订的领域/内容类型/分析作用、情境、有效时间与认识关系（`@2`另有问答绑定、派生标记和该修订涉及的经历）保存在`claim_revisions.details`，反馈引用原始用户来源与目标版本。模型尚未推理、数据库未处理与本人未确认分别表达。

现有数据库需要先具备`claim_revisions.details`列，才可部署使用该入口。当前结构定义在`packages/db/schema.sql`；部署不会自动修改已有库，需要数据库所有者在明确授权的更新中添加JSONB列及空对象默认值。新库按当前定义创建，不恢复旧迁移历史或清空旧库。
