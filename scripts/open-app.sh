#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/.env" ]]; then
  echo "missing $ROOT/.env" >&2
  exit 1
fi

set -a
source "$ROOT/.env"
set +a

: "${APP_ACCESS_TOKEN:?APP_ACCESS_TOKEN is required}"
: "${FINDME_APP_URL:?FINDME_APP_URL is required}"

URL="$(APP_ACCESS_TOKEN="$APP_ACCESS_TOKEN" python3 - <<'PY'
import os
from urllib.parse import quote

token = quote(os.environ["APP_ACCESS_TOKEN"], safe="")
base = os.environ["FINDME_APP_URL"].rstrip("/")
print(f"{base}/#access_token={token}")
PY
)"

open "$URL"
