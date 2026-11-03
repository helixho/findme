#!/usr/bin/env bash
# Run inside the target Linux instance from any directory.
set -Eeuo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
STATE=${FINDME_STATE_DIR:-}
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
      echo 'Usage: scripts/install-deploy.sh [--state-dir ABSOLUTE_PATH] [--port 8000] [--public-url HTTPS_URL] [--no-publish]'
      echo 'Linux only. Installs missing Docker/Compose, builds this checkout, initializes and deploys. Never deletes existing data.'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo 'Run this on the target Linux instance.' >&2; exit 1; }
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT > 0 && PORT < 65536)) || { echo 'Invalid port' >&2; exit 1; }
if [[ -z $STATE ]]; then
  if [[ -d /data ]]; then STATE=/data/findme; else STATE=/var/lib/findme; fi
fi
[[ $STATE == /* && $STATE != *[$'\n\r\t ']* ]] || { echo 'State directory must be an absolute path without whitespace.' >&2; exit 1; }
SUDO=()
if ((EUID != 0)); then SUDO=(sudo); fi
if ! command -v docker >/dev/null; then
  . /etc/os-release
  [[ $ID == debian || $ID == ubuntu ]] || { echo 'Automatic Docker installation supports Debian/Ubuntu; install Docker and Compose, then rerun.' >&2; exit 1; }
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y ca-certificates curl
  "${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
  "${SUDO[@]}" curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  "${SUDO[@]}" chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" |
    "${SUDO[@]}" tee /etc/apt/sources.list.d/findme-docker.list >/dev/null
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  "${SUDO[@]}" systemctl enable --now docker
  if ! docker info >/dev/null 2>&1; then DOCKER=("${SUDO[@]}" docker); fi
fi
if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y docker-compose-plugin
fi
"${DOCKER[@]}" info >/dev/null
[[ -d $REPO/.git ]] || { echo 'Deploy a Git checkout from the remote repository; use scripts/bootstrap-deploy.sh.' >&2; exit 1; }
[[ -z $(git -C "$REPO" status --porcelain) ]] || { echo 'Refusing to build an uncommitted checkout.' >&2; exit 1; }
COMMIT=$(git -C "$REPO" rev-parse HEAD)
[[ -z ${FINDME_DEPLOY_COMMIT:-} || $FINDME_DEPLOY_COMMIT == "$COMMIT" ]] || { echo 'Source commit mismatch.' >&2; exit 1; }
export FINDME_VERSION=$COMMIT
# Restart policies need the engine at boot; do not restart an already-running engine.
if command -v systemctl >/dev/null; then "${SUDO[@]}" systemctl enable docker; fi
"${SUDO[@]}" mkdir -p "$STATE"
"${SUDO[@]}" chown "$(id -u):$(id -g)" "$STATE"
ENV_FILE=$STATE/runtime.env
get_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
if [[ -f $ENV_FILE ]]; then
  SAVED_PORT=$(get_value FINDME_PORT)
  [[ $PORT == "$SAVED_PORT" ]] || { echo "Use the saved port $SAVED_PORT (edit $ENV_FILE to change it)." >&2; exit 1; }
  SAVED_URL=$(get_value FINDME_PUBLIC_URL)
  [[ -z $PUBLIC_URL || $PUBLIC_URL == "$SAVED_URL" ]] || { echo "Edit FINDME_PUBLIC_URL in $ENV_FILE to change the origin." >&2; exit 1; }
  PUBLIC_URL=$SAVED_URL
fi
if [[ -z $PUBLIC_URL ]] && ((PUBLISH)) && command -v instabox-port >/dev/null; then
  # Publishing is deliberate for an Instabox deployment. No Cloudflare changes.
  PORT_RESULT=$(instabox-port publish "$PORT" --name FindMe)
  PUBLIC_URL=$(printf '%s\n' "$PORT_RESULT" | sed -nE 's@.*(https://[^[:space:]"<>]+).*@\1@p' | head -1)
  [[ -n $PUBLIC_URL ]] || { echo 'Could not resolve the published URL; rerun with --public-url.' >&2; exit 1; }
fi
PUBLIC_URL=${PUBLIC_URL:-http://localhost:$PORT}
PUBLIC_URL=${PUBLIC_URL%/}
[[ $PUBLIC_URL =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ || $PUBLIC_URL =~ ^http://(localhost|127\.0\.0\.1):[0-9]+$ ]] || { echo 'Public URL must be an HTTPS origin (or localhost HTTP).' >&2; exit 1; }
if [[ ! -f $ENV_FILE ]]; then
  umask 077
  random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  {
    printf 'FINDME_STATE_DIR=%s\nFINDME_PORT=%s\nFINDME_PUBLIC_URL=%s\n' "$STATE" "$PORT" "$PUBLIC_URL"
    printf 'POSTGRES_PASSWORD=%s\n' "$(random_hex)"
    for role in RUNTIME IDENTITY AUTH; do printf 'DB_%s_PASSWORD=%s\n' "$role" "$(random_hex)"; done
    printf 'ACCOUNT_SECRET=%s\nOWNER_EMAIL=owner@findme.local\nOWNER_PASSWORD=%s\n' "$(random_hex)" "$(random_hex)"
    printf 'CLOUD_INFERENCE_ENABLED=0\nCLOUD_PROFILE_CALL_LIMIT=0\nDEEPSEEK_MODEL=deepseek-v4-flash\nDEEPSEEK_API_KEY=\n'
  } > "$ENV_FILE"
fi
"${SUDO[@]}" mkdir -p "$STATE/files"
"${SUDO[@]}" chown 1000:1000 "$STATE/files"
COMPOSE=("${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$REPO/deployment/standalone/compose.yaml")
echo '[deploy] Building the complete application from this checkout'
"${COMPOSE[@]}" build app
"${COMPOSE[@]}" up -d --wait postgres
echo '[deploy] Applying schema and initializing the account (existing data preserved)'
"${COMPOSE[@]}" run --rm --no-deps \
  -e "DATABASE_URL_MIGRATION=postgresql://postgres:$(get_value POSTGRES_PASSWORD)@postgres/findme" \
  -e "DB_RUNTIME_PASSWORD=$(get_value DB_RUNTIME_PASSWORD)" \
  -e "DB_IDENTITY_PASSWORD=$(get_value DB_IDENTITY_PASSWORD)" \
  -e "DB_AUTH_PASSWORD=$(get_value DB_AUTH_PASSWORD)" \
  app node dist/standalone/setup.js
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 app
"${COMPOSE[@]}" exec -T app node -e 'for (const p of ["/", "/health?strict=1", "/ready"]) { const r=await fetch("http://127.0.0.1:8000"+p); if(!r.ok) throw Error(p+":"+r.status); } console.log("[deploy] Web, database, account role and worker ready")'
printf '%s\n' "$COMMIT" > "$STATE/deployed-commit"
printf '\nFindMe ready: %s\nAccount: owner@findme.local\nCredentials and runtime settings: %s\n' "$PUBLIC_URL" "$ENV_FILE"
echo 'Read OWNER_PASSWORD from that file on the instance. Model inference is off until configured.'
