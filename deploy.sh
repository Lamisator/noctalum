#!/usr/bin/env bash
# Deploy ContestLog to the production server.
#
# Usage:
#   ./deploy.sh                  # build everything, then deploy
#   ./deploy.sh --skip-build     # deploy already-built dist/ artifacts (no rebuild)
#   ./deploy.sh --transfer-db    # also push the local contestlog.db to the server

set -euo pipefail

SSH_KEY="$HOME/.ssh/id_ssh"
SSH_HOST="root@k-inf1-server.kloeck-it.de"
REMOTE_WORK_DIR="/home/marius/contestlogger"
REMOTE_APP_DIR="$REMOTE_WORK_DIR/app"

skip_build=false
transfer_db=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)  skip_build=true  ;;
    --transfer-db) transfer_db=true ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
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

echo "Stopping service..."
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose down" || true

echo "Copying server binary..."
scp -i "$SSH_KEY" "$ROOT/dist/contestlog-linux-amd64" "$SSH_HOST:$REMOTE_APP_DIR/contestlog-server"
ssh -i "$SSH_KEY" "$SSH_HOST" "chmod +x $REMOTE_APP_DIR/contestlog-server"

echo "Copying helper, WSJT-X, and GUI binaries to downloads..."
# Use nullglob so missing globs (e.g. skipped GUI builds) are silently dropped.
shopt -s nullglob
downloads=(
  "$ROOT"/dist/contestlog-helper-*
  "$ROOT"/dist/contestlog-wsjtx-*
)
shopt -u nullglob
if [ ${#downloads[@]} -eq 0 ]; then
  echo "warning: no helper/wsjtx binaries found in dist/ — was build skipped?" >&2
else
  scp -i "$SSH_KEY" "${downloads[@]}" "$SSH_HOST:$REMOTE_APP_DIR/downloads/"
fi

if [ "$transfer_db" = true ]; then
  echo "Transferring database..."
  scp -i "$SSH_KEY" "$ROOT/contestlog.db" "$SSH_HOST:$REMOTE_WORK_DIR/data/"
fi

echo "Starting service..."
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose up -d"

echo "Deployment complete."
