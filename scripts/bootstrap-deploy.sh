#!/usr/bin/env bash
# Can be downloaded and run directly on a fresh target instance.
set -Eeuo pipefail
REPOSITORY=${FINDME_REPOSITORY:-https://github.com/helixho/findme.git}
REF=${FINDME_REF:-main}
if [[ -d /data/workspace ]]; then DEFAULT_CHECKOUT=/data/workspace/findme;
else DEFAULT_CHECKOUT=${HOME:?}/workspace/findme; fi
CHECKOUT=${FINDME_CHECKOUT:-$DEFAULT_CHECKOUT}
if ! command -v git >/dev/null; then
  if ((EUID == 0)); then apt-get update && apt-get install -y git;
  else sudo apt-get update && sudo apt-get install -y git; fi
fi
NEW_CHECKOUT=0
if [[ ! -d $CHECKOUT/.git ]]; then
  [[ ! -e $CHECKOUT ]] || { echo "Checkout path already exists: $CHECKOUT" >&2; exit 1; }
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --no-checkout "$REPOSITORY" "$CHECKOUT"
  NEW_CHECKOUT=1
fi
[[ $(git -C "$CHECKOUT" remote get-url origin) == "$REPOSITORY" ]] || { echo 'Checkout origin does not match FINDME_REPOSITORY.' >&2; exit 1; }
if (( ! NEW_CHECKOUT )); then
  [[ -z $(git -C "$CHECKOUT" status --porcelain) ]] || { echo 'Target checkout has local changes; preserve them before deploying.' >&2; exit 1; }
fi
git -C "$CHECKOUT" fetch --depth=1 origin "$REF"
COMMIT=$(git -C "$CHECKOUT" rev-parse FETCH_HEAD)
git -C "$CHECKOUT" checkout --detach "$COMMIT"
echo "[deploy] Source commit: $COMMIT"
FINDME_DEPLOY_COMMIT=$COMMIT bash "$CHECKOUT/scripts/install-deploy.sh" "$@"
