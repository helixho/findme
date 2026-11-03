# 单节点部署

Cloudflare 只负责域名、HTTPS/CDN。完整网页、API、后台执行器使用同一个应用镜像和容器，另一个容器运行 PostgreSQL 18。原档存在节点持久目录，不依赖 Workers、Hyperdrive、Queues 或 R2。Dockerfile 和脚本随源码维护；镜像仅在目标服务器从指定 Git 提交构建，不提交镜像、不需要镜像仓库。

## 在 Instabox 实例部署

在实例中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/helixho/findme/main/scripts/bootstrap-deploy.sh | bash
```

bootstrap 自行 clone/fetch 远端 main，检出确切提交，再执行该提交内的 `scripts/install-deploy.sh`。已有仓库有本地修改时停止，避免覆盖。默认源码目录 `/data/workspace/findme`，状态目录 `/data/findme`；缺少 `/data` 时分别使用 `~/workspace/findme` 和 `/var/lib/findme`。`FINDME_CHECKOUT`、`FINDME_STATE_DIR`、`FINDME_REF` 可以覆盖这些默认值。

已有干净 Git checkout 也可执行 `./scripts/install-deploy.sh`，安装该 checkout 的提交；更新到远端新版本使用 bootstrap。安装器支持 `--state-dir`、`--port`、`--public-url` 和 `--no-publish`，详见 `--help`。

脚本在 Debian/Ubuntu 安装缺少的 Docker/Compose，保留已有 Docker；构建应用，启动数据库并等待就绪，应用既有迁移及账号角色，首次创建本人账号，启动应用并检查网页、数据库与执行器。Instabox 中自动发布 HTTP 端口取得平台 HTTPS 地址；其他节点提供 `--public-url https://your-domain.example`，在节点入口配置 TLS。脚本不改 Cloudflare。

## 配置与数据

`/data/findme/runtime.env` 保存首次生成的数据库密码、账号密钥、`OWNER_EMAIL`（默认 `owner@findme.local`）和 `OWNER_PASSWORD`。重复部署复用此文件及数据，不重置账号或清库。不要把它提交到 Git；更换默认端口/域名时先修改此文件，重新运行部署，并核对账号与现有个人 scope 的映射。`deployed-commit`、应用镜像标签和 OCI revision 标签记录实际源码版本；`deployed-commit` 仅在健康检查通过后更新。

持久目录：`postgres/`（数据库）、`files/`（原档）。应用更新不删除这些目录。不执行 `docker compose down -v` 或删除数据目录来更新。

模型调用默认关闭。需要使用时在运行配置填入现有接口凭据、启用 `CLOUD_INFERENCE_ENABLED` 并设置既有调用预算，再重新部署。免费 Instabox 不意味着外部模型免费。没有配置真实模型时，网页、登录、资料保存与原档存取可用，推理不会执行。

普通对话自动处理还受 `CORE_MODEL_DAILY_OPERATION_LIMIT` 控制，默认 0；按本人已确认的预算配置，不因部署而自动启用。

## 后台任务与休眠

执行器在应用进程中运行，串行扫描已有账号作用域的持久任务表，处理 queued 任务；过期 running 任务使用既有恢复路径及原调用上限接续，不自动提高预算或重试 failed/rejected 任务。每阶段检查点沿用原业务实现。关闭应用时停止领取并等待在途任务；强制终止后由数据库 lease 和已有检查点恢复。

Docker engine 在开机启动，容器设置 `unless-stopped`。恢复暂停通常保留进程；无法保留时从持久数据重新启动。Instabox 的自动唤醒及最长运行限制由平台控制。手动暂停或停止不会因访问而唤醒。没有配置外部定时探活；轮询是否影响平台闲置判定、实际长任务与自动休眠组合需要单独实测，部署就绪不代表该项已经验证。

## 更换节点

同一入口在新 Linux 节点拉取同一提交并构建。业务数据迁移须先停止旧节点写入和任务，使用 PostgreSQL 逻辑导出与原档拷贝，再在目标恢复并对账；不能只复制运行中的数据库文件夹。保持账号 issuer 域名与运行密钥可避免无意生成新作用域。首次安装脚本本身不连接旧 Neon、不导入旧资料，也不切换域名。旧 Neon 启用、数据恢复与 CF 切换须按具体迁移范围执行。

故障定位：

```bash
docker compose --env-file /data/findme/runtime.env -f deployment/standalone/compose.yaml ps
docker compose --env-file /data/findme/runtime.env -f deployment/standalone/compose.yaml logs --tail=100 app
```

手动运行 Compose 时设置 `FINDME_VERSION=$(cat /data/findme/deployed-commit)`，使用已验收提交的镜像；安装器会自动设置。

合成部署验证入口为 `scripts/verify-standalone.mjs`（Node 22+），读取 `FINDME_VERIFY_ENV_FILE`，默认 `/data/findme/runtime.env`。首次运行创建合成 Profile、专题和原档，第二次加 `verify` 参数核对持久结果；`FINDME_VERIFY_STATE` 指定两次共用的临时回执路径。仅允许推理关闭的实例。`FINDME_BROWSER_CDP` 可连接独立测试 Chromium，验证桌面与手机视口登录、刷新和布局；不接管用户浏览器。
