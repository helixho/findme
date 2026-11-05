#!/usr/bin/env bash
# Change the owner's user name and password on this instance.
# Run on the instance: bash scripts/set-owner-login.sh
# The password is typed at a hidden prompt and written only to runtime.env.
set -Eeuo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${FINDME_STATE_DIR:-$([[ -d /data ]] && echo /data/findme || echo /var/lib/findme)}
ENV_FILE=$STATE/runtime.env
[[ -f $ENV_FILE ]] || { echo "No $ENV_FILE; deploy first." >&2; exit 1; }
read -r -p "用户名 [helix]: " NAME
NAME=${NAME:-helix}
read -r -s -p "新密码（至少 8 位）: " PASSWORD; echo
read -r -s -p "再输入一次: " AGAIN; echo
[[ $PASSWORD == "$AGAIN" ]] || { echo "两次输入不一致" >&2; exit 1; }
(( ${#PASSWORD} >= 8 )) || { echo "密码至少 8 位" >&2; exit 1; }
set_value() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  grep -v "^$key=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
set_value OWNER_EMAIL "$NAME"
set_value OWNER_PASSWORD "$PASSWORD"
unset PASSWORD AGAIN
get_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
DOCKER=(docker); docker info >/dev/null 2>&1 || DOCKER=(sudo docker)
COMPOSE=("${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$REPO/deployment/standalone/compose.yaml")
ADMIN_URL=$(get_value DATABASE_ADMIN_URL)
if [[ -z $ADMIN_URL ]]; then
  COMPOSE+=(--profile local-db)
  ADMIN_URL="postgresql://postgres:$(get_value POSTGRES_PASSWORD)@postgres/findme"
fi
export FINDME_VERSION=$(cat "$STATE/deployed-commit")
"${COMPOSE[@]}" run --rm --no-deps \
  -e "DATABASE_URL_ADMIN=$ADMIN_URL" \
  -e "DB_RUNTIME_PASSWORD=$(get_value DB_RUNTIME_PASSWORD)" \
  -e "DB_IDENTITY_PASSWORD=$(get_value DB_IDENTITY_PASSWORD)" \
  -e "DB_AUTH_PASSWORD=$(get_value DB_AUTH_PASSWORD)" \
  app node dist/standalone/setup.js >/dev/null
echo "已更新：用户名 $NAME，新密码已生效。"
