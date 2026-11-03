#!/usr/bin/env bash
set -euo pipefail
FILE=${1:?用法: restore.sh <db dump.sql.gz>}
DB_URL=${RESTORE_DATABASE_URL:-}
: "${DB_URL:?RESTORE_DATABASE_URL required}"

# plain pg_dump 重放假设目标为空库;对非空库重放会产生 "already exists" 错误与半新半旧数据。
# 非空即拒(除非 RESTORE_FORCE=1),避免灾备压力下误对活库重放。
if ! OBJECTS=$(psql "$DB_URL" -X -v ON_ERROR_STOP=1 -tAc \
  "SELECT
     (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
        AND c.relkind IN ('r','p','v','m','S','f'))
     + (SELECT count(*) FROM pg_catalog.pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog','information_schema','public')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%');"); then
  echo "拒绝:无法确认目标数据库为空,预检失败。" >&2
  exit 1
fi
if [[ ! "$OBJECTS" =~ ^[0-9]+$ ]]; then
  echo "拒绝:目标数据库预检返回了无效结果。" >&2
  exit 1
fi
if [ "$OBJECTS" != "0" ] && [ "${RESTORE_FORCE:-0}" != "1" ]; then
  echo "拒绝:目标库已有 $OBJECTS 个非系统对象或自建 schema。plain dump 须重放到空库。"
  echo "请先在目标 PostgreSQL 中重建空库,再用 RESTORE_DATABASE_URL 指向该空库。"
  echo "(确认要对非空库强制重放可设 RESTORE_FORCE=1,风险自负)"
  exit 1
fi

echo "将把 $FILE 重放到 RESTORE_DATABASE_URL 指向的数据库(plain dump,要求目标为空库)。确认请输入 yes:"
read -r ok; [ "$ok" = "yes" ] || exit 1
gunzip -c "$FILE" | psql "$DB_URL" -X -v ON_ERROR_STOP=1
echo "restore done"
