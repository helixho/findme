#!/usr/bin/env bash
set -euo pipefail

echo "FindMe 的 Box 部署入口已退役；后端发布用 pnpm cf:deploy，目标 App 发布用 pnpm app:deploy。" >&2
exit 1
