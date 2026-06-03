#!/usr/bin/env bash
# Deploy Noctalum to the production server.
#
# Usage:
#   ./deploy.sh                      # build everything, then deploy
#   ./deploy.sh --skip-build         # deploy already-built dist/ artifacts (no rebuild)
#   ./deploy.sh --transfer-db        # also push the local noctalum.db to the server
#   ./deploy.sh --countdown 30       # warn users N seconds before shutdown (default: 15)

set -euo pipefail

# Load deployment secrets (SSH key path, server hostname, remote directory).
# Copy .deploy.env.example → .deploy.env and fill in your values.
DEPLOY_ENV="$(dirname "$0")/.deploy.env"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "error: $DEPLOY_ENV not found — copy .deploy.env.example and fill in your values" >&2
  exit 1
fi
# shellcheck source=.deploy.env.example
. "$DEPLOY_ENV"

REMOTE_APP_DIR="$REMOTE_WORK_DIR/app"

skip_build=false
transfer_db=false
countdown=60

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)  skip_build=true  ; shift ;;
    --transfer-db) transfer_db=true ; shift ;;
    --countdown)
      countdown="$2"
      if ! [[ "$countdown" =~ ^[0-9]+$ ]] || [ "$countdown" -lt 1 ]; then
        echo "error: --countdown requires a positive integer" >&2; exit 1
      fi
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ "$skip_build" = false ]; then
  echo "Building all binaries..."
  "$ROOT/build.sh"
fi

echo "Preparing remote directories..."
ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p $REMOTE_APP_DIR/downloads $REMOTE_WORK_DIR/data"

echo "Copying docker-compose.yml..."
scp -i "$SSH_KEY" "$ROOT/docker-compose.yml" "$SSH_HOST:$REMOTE_WORK_DIR/"

# Trigger a graceful shutdown: write the countdown (in seconds) to the trigger
# file that the server polls every 2 s.  The server broadcasts a deploy_warning
# to all connected users, then sends itself SIGTERM after the countdown elapses.
# No HTTP endpoint is involved — file-write access requires SSH access to the
# host, which is already a prerequisite for this deploy script.
echo "Triggering graceful shutdown (${countdown}s warning)..."
if ssh -i "$SSH_KEY" "$SSH_HOST" \
    "printf '%s\n' '${countdown}' > $REMOTE_WORK_DIR/data/shutdown_trigger" ; then
  echo "Shutdown triggered. Waiting for server to stop..."
  # Poll until the server stops responding (or give up after countdown + 10 s).
  deadline=$(( $(date +%s) + countdown + 10 ))
  while ssh -i "$SSH_KEY" "$SSH_HOST" \
      "curl -s --max-time 2 http://localhost:8675/api/me > /dev/null 2>&1"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "warning: server did not stop in time — forcing docker compose down" >&2
      ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose down" || true
      break
    fi
    sleep 1
  done
  echo "Server stopped."
else
  echo "note: SSH write failed — proceeding with docker compose down" >&2
  ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose down" || true
fi

# Ensure the container is fully removed before we start the new one.
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose down" || true

echo "Copying server binary..."
scp -i "$SSH_KEY" "$ROOT/dist/noctalum-linux-amd64" "$SSH_HOST:$REMOTE_APP_DIR/noctalum-server"
ssh -i "$SSH_KEY" "$SSH_HOST" "chmod +x $REMOTE_APP_DIR/noctalum-server"

echo "Copying helper, WSJT-X, and GUI binaries to downloads..."
# Use nullglob so missing globs (e.g. skipped GUI builds) are silently dropped.
shopt -s nullglob
downloads=(
  "$ROOT"/dist/noctalum-helper-*
  "$ROOT"/dist/noctalum-wsjtx-*
)
shopt -u nullglob
if [ ${#downloads[@]} -eq 0 ]; then
  echo "warning: no helper/wsjtx binaries found in dist/ — was build skipped?" >&2
else
  scp -i "$SSH_KEY" "${downloads[@]}" "$SSH_HOST:$REMOTE_APP_DIR/downloads/"
fi

if [ "$transfer_db" = true ]; then
  echo "Transferring database..."
  scp -i "$SSH_KEY" "$ROOT/noctalum.db" "$SSH_HOST:$REMOTE_WORK_DIR/data/"
fi

echo "Starting service..."
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose up -d"

echo "Deployment complete."

# Announce the new version to the Telegram subscribers' group (non-fatal —
# the notifier itself exits 0 on missing config or network errors).
notifier_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
notifier_arch="$(uname -m)"
case "$notifier_arch" in
  x86_64)         notifier_arch=amd64 ;;
  aarch64|arm64)  notifier_arch=arm64 ;;
esac
notifier="$ROOT/dist/noctalum-notify-telegram-${notifier_os}-${notifier_arch}"
if [ -x "$notifier" ]; then
  "$notifier" --changelog "$ROOT/internal/server/web/app.js" || true
else
  echo "note: $notifier missing — rebuild with ./build.sh to enable Telegram announcements" >&2
fi
