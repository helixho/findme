#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
OUT=${BACKUP_DIR:-./backups}
DB_URL=${BACKUP_DATABASE_URL:-${DATABASE_URL_MIGRATION:-${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}}}
: "${DB_URL:?BACKUP_DATABASE_URL, DATABASE_URL_MIGRATION, DATABASE_URL_UNPOOLED, or DATABASE_URL required}"
mkdir -p "$OUT"
# 1) 数据库
pg_dump "$DB_URL" | gzip > "$OUT/db-$TS.sql.gz"
# 2) 上传文件(若有)
[ -d ./uploads ] && tar czf "$OUT/uploads-$TS.tar.gz" ./uploads || true
# 3) 加密(若配置了 age 接收者)
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/db-$TS.sql.gz.age" "$OUT/db-$TS.sql.gz" && rm "$OUT/db-$TS.sql.gz"
else
  echo "WARN: 未配置 BACKUP_AGE_RECIPIENT,备份未加密"
fi
echo "backup done: $OUT (ts=$TS)"
