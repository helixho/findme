# 第一阶段迁移与兼容

本文承接 ADR D23/D24，不选择新数据库，也不授权迁移、恢复或发布。生产实际应用状态必须在操作时查询；历史结果见 Current Status 和执行记录，不能从源码 journal 推断线上状态。原欠费 Neon 不恢复。

## 数据库顺序

1. 确定实际目标库与候选代码，读取目标的迁移历史、现有表和角色；区分空库、已有 legacy 库和已应用账号迁移的库。空库按完整 journal 顺序应用，不能只跑最后几个 SQL。
2. 自动迁移唯一顺序源是 `packages/db/migrations/meta/_journal.json`。`0012_open_lionheart` 将 `av_processed_batches` / `av_processed_chunks` 纳入 `schema-archive.ts` 与 journal；空库正常建表，已存在精确旧补充 DDL 的库按列/默认值、约束、索引等实际结构核验后接管，保留数据字节及既有策略。仅约束名称按 snapshot 规范化。不完整表对或结构不匹配以 `ARCHIVE_LEGACY_SHAPE_MISMATCH` 失败，不能记为成功接管或通过覆盖数据修复。`drizzle-kit check` 只查本地制品，`db:migrate` 才连接目标。
3. `apps/api/scripts/av-processed-archive-schema.sql` 仅保留旧手工归档环境兼容来源；正常新安装直接按 journal，不再额外执行此旧可选 DDL。0012 不创建角色、不授予权限，也不启用 RLS；迁移成功不能代表账号访问已配置。
4. 在建表完成后应用 `packages/db/access/account-runtime.sql`，再配置 runtime、identity、auth 各自登录的角色成员关系；不得合成一个运行登录。此脚本不在 journal 中。若先运行策略后建归档表，`to_regclass` 条件块会跳过不存在的表，必须在建表后重新应用并验证对应 GRANT/RLS/policy，不能只看脚本退出成功。
5. 用非表所有者、非 SUPERUSER、非 BYPASSRLS 的实际角色检查账号/Profile 作用域、跨 Profile 拒绝、Core 访问和可选归档读取。访问包装已有 `scope.ts` 和 `runtime-role.ts`，不把路由的手写条件视作唯一隔离。认证表由迁移定义；BetterAuth `modelName` 动态访问它们，服务器配置本身不证明自动建表。

## 导入与兼容

已通过 U2 专题通过 `cloud-diagnostic/u2-import.ts` 的 preview → confirm → commit 一次性迁入；必须绑定 input_hash。核对专题版本、原审核记录、来源根身份/版本/哈希、精确证据及报告引用，不重新生成。未通过候选、未成稿与 overall 不提升资格。重复提交核对既有收据；出现不同指纹、缺失证据或范围变化时停止该批，不以覆盖旧数据恢复。

个人 export 的 restore-prepare 是转为待审来源；它不恢复认证会话、历史模型真值或付费任务。数据库完整恢复另见 [Runbook](../runbook.md)，二者不可混用。

迁入期间冻结路径保留读取，导入对账和账号入口读取核对后才退役快照路由；D23 的冻结不授权删表或删除数据。归档表已纳入账号分页导出与 Profile purge；分块 payload 以 PostgreSQL bytea hex 表达，保留 manifest、复合键及 SHA-256 哈希，清除按 chunks → batches 顺序。恢复须先核对 manifest、键、分块及制品哈希，再按 batches → chunks 的依赖顺序显式交接；它们是加工制品，不自动转成 claims 或导入当前认识，仍走明确的预览/资格路径。分页事务不是跨请求原子备份。源码入口为 `cloud-diagnostic/export.ts`、`purge.ts`，工程证据见后续维护记录。

## 失败与候选切换

迁移失败先记录已应用 journal 与失败 SQL，不盲目重跑非幂等语句。部署候选必须兼容目标 schema、绑定与角色；应用回滚不撤销数据库迁移。导入失败保留输入指纹和收据，按同一批核对后续做；不能重算全量材料掩盖断点。空库迁移、已有库兼容、真实导入对账、实际角色访问与应用往返是不同验证，本文件不宣称它们已在生产通过。
