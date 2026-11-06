#!/usr/bin/env bash
# Deploy the application directly on the target Linux host; Docker hosts only PostgreSQL.
set -Eeuo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
STATE=${FINDME_STATE_DIR:-}
if [[ -z $STATE ]]; then
  if [[ -d /data ]]; then STATE=/data/findme; else STATE=/var/lib/findme; fi
fi
PORT=${FINDME_PORT:-8000}
PUBLIC_URL=${FINDME_PUBLIC_URL:-}
PUBLISH=1
while (($#)); do
  case "$1" in
    --state-dir) STATE=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --public-url) PUBLIC_URL=${2:?}; shift 2 ;;
    --no-publish) PUBLISH=0; shift ;;
    -h|--help)
      echo 'Usage: scripts/install-deploy.sh [--state-dir ABS] [--port 8000] [--public-url HTTPS_ORIGIN] [--no-publish]'
      echo 'Builds API and static UI, then runs Node under systemd. Docker is used only for the database. Existing data is preserved.'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo 'Run this on the target Linux host.' >&2; exit 1; }
[[ $STATE == /* && $STATE != *[$'\n\r\t ']* && $REPO != *[$'\n\r\t ']* ]] || { echo 'Use absolute paths without whitespace.' >&2; exit 1; }
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT > 0 && PORT < 65536)) || { echo 'Invalid port.' >&2; exit 1; }
for command in node pnpm git systemctl; do command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }; done
NODE=$(command -v node)
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19)) throw Error("Node 22.19+ required")'
[[ -d $REPO/.git && -z $(git -C "$REPO" status --porcelain) ]] || { echo 'Deploy a clean Git checkout; preserve local work first.' >&2; exit 1; }
COMMIT=$(git -C "$REPO" rev-parse HEAD)
[[ -z ${FINDME_DEPLOY_COMMIT:-} || $FINDME_DEPLOY_COMMIT == "$COMMIT" ]] || { echo 'Source commit mismatch.' >&2; exit 1; }
SUDO=()
if ((EUID != 0)); then SUDO=(sudo); fi
"${SUDO[@]}" mkdir -p "$STATE"
"${SUDO[@]}" chown "$(id -u):$(id -g)" "$STATE"
ENV_FILE=$STATE/runtime.env
get_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
if [[ -f $ENV_FILE ]]; then
  [[ $PORT == "$(get_value FINDME_PORT)" ]] || { echo 'Use the saved port; explicitly edit runtime.env to change it.' >&2; exit 1; }
  SAVED_URL=$(get_value FINDME_PUBLIC_URL)
  [[ -z $PUBLIC_URL || $PUBLIC_URL == "$SAVED_URL" ]] || { echo 'Use the saved public URL.' >&2; exit 1; }
  PUBLIC_URL=$SAVED_URL
fi
if [[ -z $PUBLIC_URL ]] && ((PUBLISH)) && command -v instabox-port >/dev/null; then
  PORT_RESULT=$(instabox-port publish "$PORT" --name FindMe)
  PUBLIC_URL=$(printf '%s\n' "$PORT_RESULT" | sed -nE 's@.*(https://[^[:space:]"<>]+).*@\1@p' | head -1)
  [[ -n $PUBLIC_URL ]] || { echo 'Could not resolve the published URL.' >&2; exit 1; }
fi
PUBLIC_URL=${PUBLIC_URL:-http://localhost:$PORT}
PUBLIC_URL=${PUBLIC_URL%/}
[[ $PUBLIC_URL =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ || $PUBLIC_URL =~ ^http://(localhost|127\.0\.0\.1):[0-9]+$ ]] || { echo 'Invalid public origin.' >&2; exit 1; }
if [[ ! -f $ENV_FILE ]]; then
  umask 077
  random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  {
    printf 'FINDME_STATE_DIR=%s\nFINDME_PORT=%s\nFINDME_PUBLIC_URL=%s\n' "$STATE" "$PORT" "$PUBLIC_URL"
    printf 'POSTGRES_PASSWORD=%s\n' "$(random_hex)"
    for role in RUNTIME IDENTITY AUTH; do printf 'DB_%s_PASSWORD=%s\n' "$role" "$(random_hex)"; done
    printf 'ACCOUNT_SECRET=%s\n' "$(random_hex)"
  } > "$ENV_FILE"
fi
# Keep the existing database container and bind-mounted data. No application image is built.
LOCATION=$(get_value DATABASE_LOCATION)
if [[ -z $LOCATION || $LOCATION == postgres/findme ]]; then
  command -v docker >/dev/null || { echo 'Docker is required for the local PostgreSQL container.' >&2; exit 1; }
  docker compose version >/dev/null
  docker compose --env-file "$ENV_FILE" -f "$REPO/deployment/standalone/compose.yaml" --profile local-db up -d --no-recreate --wait postgres
fi
mkdir -p "$STATE/files" "$STATE/pnpm-store"
cd "$REPO"
echo '[deploy] Installing locked dependencies and building Node API / static UI (no application Docker build)'
CI=1 pnpm install --frozen-lockfile --store-dir "$STATE/pnpm-store"
pnpm --filter @findme/api build
VITE_CORE_API_BASE= VITE_APP_AUTH_MODE=account pnpm --filter @findme/app build
"$NODE" "$REPO/scripts/native-runtime.mjs" --state-dir "$STATE" --repo-root "$REPO" --setup

# User-owned inputs and database stay in place; only application execution changes.
SERVICE=/etc/systemd/system/findme-app.service
"${SUDO[@]}" tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=FindMe direct Node application
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$REPO
Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE $REPO/scripts/native-runtime.mjs --state-dir $STATE --repo-root $REPO
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
UNIT
"${SUDO[@]}" systemctl daemon-reload
# Stop only the legacy app, never compose down or the PostgreSQL container.
LEGACY_APP=$(docker ps -aq --filter label=com.docker.compose.project=findme --filter label=com.docker.compose.service=app 2>/dev/null || true)
if [[ -n $LEGACY_APP ]]; then docker stop --time 120 "$LEGACY_APP" >/dev/null; fi
"${SUDO[@]}" systemctl enable findme-app >/dev/null
"${SUDO[@]}" systemctl restart findme-app
READY=0
for ((i=0;i<60;i++)); do
  if FINDME_CHECK_PORT=$PORT "$NODE" --input-type=module -e 'for(const p of ["/", "/health?strict=1", "/ready"]){ const r=await fetch("http://127.0.0.1:"+process.env.FINDME_CHECK_PORT+p,{signal:AbortSignal.timeout(1500)});if(!r.ok)process.exit(1);}' >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if (( ! READY )); then
  echo 'Direct application did not become ready; inspect journalctl -u findme-app.' >&2
  if [[ -n $LEGACY_APP ]]; then
    "${SUDO[@]}" systemctl disable --now findme-app >/dev/null
    docker start "$LEGACY_APP" >/dev/null
    echo 'Previous application restored; direct-run deployment remains incomplete.' >&2
  fi
  exit 1
fi
# A stopped legacy app must not reclaim the port after a future Docker restart.
if [[ -n $LEGACY_APP ]]; then docker rm "$LEGACY_APP" >/dev/null; fi
printf '%s\n' "$COMMIT" > "$STATE/deployed-commit"
printf '\nFindMe ready: %s (Node / systemd findme-app; database preserved)\n' "$PUBLIC_URL"
