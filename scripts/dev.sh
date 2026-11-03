#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

api_pid=""
app_pid=""
run_pids=()

cleanup() {
  for pid in "$api_pid" "$app_pid"; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [ ! -f "$PWD/.env" ]; then
  echo "缺少 .env。请按 .env.example 配置数据库与账号变量后再启动本地开发。" >&2
  exit 1
fi

set -a
source "$PWD/.env"
set +a

if [ -z "${DATABASE_URL_RUNTIME:-}" ]; then
  echo "缺少 DATABASE_URL_RUNTIME。" >&2
  exit 1
fi

pnpm --filter @findme/api dev &
api_pid=$!
VITE_CORE_API_BASE="http://127.0.0.1:${PORT:-8000}" pnpm --filter @findme/app dev &
app_pid=$!
run_pids=("$api_pid" "$app_pid")

echo "FindMe Core API / 目标 App 已启动：http://127.0.0.1:5174"
while kill -0 "${run_pids[@]}" >/dev/null 2>&1; do
  sleep 2
done

echo "FindMe 本地开发进程意外退出。" >&2
exit 1
