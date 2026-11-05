# 单节点部署

> 本页描述现有容器部署脚本，保留供当前实例维护。后续应用改为直接运行源码或构建产物，Docker 应用打包延后到需要分发时；目标见 [TA](../../docs/ta.md)，实施见 [AG-06](../../docs/delivery/agent-work-plan.md)。直接运行路径尚未实现，本页命令不会因此改变，也不自动切换已有服务。数据库容器独立保留。

一个节点运行全部内容：网页、API、后台执行器在同一个应用容器中，数据库默认是同节点的 PostgreSQL 18 容器，原档存在节点持久目录。Dockerfile 和脚本随源码维护；镜像仅在目标服务器从指定 Git 提交构建，不提交镜像、不需要镜像仓库。

## 在 Instabox 实例部署

在实例中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/helixho/findme/main/scripts/bootstrap-deploy.sh | bash
```

bootstrap 自行 clone/fetch 远端 main，检出确切提交，再执行该提交内的 `scripts/install-deploy.sh`。已有仓库有本地修改时停止，避免覆盖。默认源码目录 `/data/workspace/findme`，状态目录 `/data/findme`；缺少 `/data` 时分别使用 `~/workspace/findme` 和 `/var/lib/findme`。`FINDME_CHECKOUT`、`FINDME_STATE_DIR`、`FINDME_REF` 可以覆盖这些默认值。

已有干净 Git checkout 也可执行 `./scripts/install-deploy.sh`，安装该 checkout 的提交；更新到远端新版本使用 bootstrap。安装器支持 `--state-dir`、`--port`、`--public-url` 和 `--no-publish`，详见 `--help`。

脚本在 Debian/Ubuntu 安装缺少的 Docker/Compose，保留已有 Docker；构建应用，启动数据库并等待就绪；数据库为空时按 `packages/db/schema.sql` 建表，已有库执行尚未执行的升级脚本；再应用账号角色与行级策略，首次创建本人账号，启动应用并检查网页、数据库与执行器。Instabox 中自动发布 HTTP 端口取得平台 HTTPS 地址；其他节点提供 `--public-url https://your-domain.example`，在节点入口配置 TLS。

## 配置与数据

| 内容 | 位置 |
| --- | --- |
| 启动配置：对外网址、端口、数据库位置与密码、账号密钥、本人初始账号 | `/data/findme/runtime.env`，首次部署生成，重复部署复用 |
| 应用设置：模型服务商、接口地址、密钥、模型名称与调用预算 | 数据库 `app_settings`，在 App 的“更多理解方式与资料 → 模型设置”中修改，保存后即时生效 |
| 业务数据 | 数据库 |
| 原档 | `/data/findme/files/` |

`runtime.env` 不提交到 Git。其中的密码和密钥丢失后可以重建：重新部署会重设数据库账号密码，新的账号密钥只会让已登录的会话失效。登录身份与实例网址无关，换网址或换节点后用原账号登录仍对应原有数据。

外部数据库：在 `runtime.env` 中同时设置 `DATABASE_LOCATION`（如 `host/db?sslmode=require`）与 `DATABASE_ADMIN_URL`（数据库所有者连接），重新部署后不再启动本机数据库容器。

模型调用默认关闭。没有配置模型时，网页、登录、资料保存与原档存取可用，推理不会执行。

## 数据库结构

新库按 `packages/db/schema.sql` 建表；已有库在部署时自动执行 `packages/db/migrations/` 中尚未执行的升级脚本，数据保留，规则见该目录的说明。升级后仍缺少当前版本需要的表或字段时，部署以 `DATABASE_STRUCTURE_MISMATCH` 停止，旧版本继续运行。

## 后台任务与休眠

执行器在应用进程中运行，串行扫描已有账号作用域的持久任务表，处理 queued 任务；过期 running 任务使用既有恢复路径及原调用上限接续，不自动提高预算或重试 failed/rejected 任务。关闭应用时停止领取并等待在途任务；强制终止后由数据库 lease 和已有检查点恢复。

Docker engine 在开机启动，容器设置 `unless-stopped`，实例 stop 后再 start，服务随之恢复。

## 换节点或重建

1. 在新节点执行上面的部署命令。
2. 停止旧节点应用，导出数据库（`pg_dump`）并拷贝 `files/` 目录。
3. 在新节点停止应用，用导出内容替换新库，拷回原档目录，再执行一次部署。

故障定位（使用本机数据库时需带 `--profile local-db`）：

```bash
docker compose --env-file /data/findme/runtime.env -f deployment/standalone/compose.yaml --profile local-db ps
```

```bash
docker compose --env-file /data/findme/runtime.env -f deployment/standalone/compose.yaml --profile local-db logs --tail=100 app
```

手动运行 Compose 时设置 `FINDME_VERSION=$(cat /data/findme/deployed-commit)`，使用已部署提交的镜像；安装器会自动设置。

合成部署验证入口为 `scripts/verify-standalone.mjs`（Node 22+），读取 `FINDME_VERIFY_ENV_FILE`，默认 `/data/findme/runtime.env`。首次运行创建合成 Profile、专题和原档，第二次加 `verify` 参数核对持久结果；`FINDME_VERIFY_STATE` 指定两次共用的临时回执路径。仅在模型调用关闭时运行。`FINDME_BROWSER_CDP` 可连接独立测试 Chromium，验证桌面与手机视口登录、刷新和布局。
