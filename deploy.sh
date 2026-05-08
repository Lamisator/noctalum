#!/bin/bash
set -e

SSH_KEY="$HOME/.ssh/id_ssh"
SSH_HOST="root@k-inf1-server.kloeck-it.de"
REMOTE_WORK_DIR="/home/marius/contestlogger"
REMOTE_APP_DIR="$REMOTE_WORK_DIR/app"
TRANSFER_DB=false

for arg in "$@"; do
  case "$arg" in
    --transfer-db) TRANSFER_DB=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

echo "Building server binary (via Docker for glibc compatibility)..."
docker run --rm \
  -v "$(pwd):/src" \
  -w /src \
  golang:1.23-bookworm \
  go build -buildvcs=false -o contestlog-server .

echo "Building helper and WSJT-X binaries..."
./build.sh --helper-only
./build.sh --wsjtx-only

echo "Preparing remote directories..."
ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p $REMOTE_APP_DIR/downloads $REMOTE_WORK_DIR/data"

echo "Copying docker-compose.yml..."
scp -i "$SSH_KEY" docker-compose.yml "$SSH_HOST:$REMOTE_WORK_DIR/"

echo "Stopping service..."
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose down" || true

echo "Copying server binary..."
scp -i "$SSH_KEY" contestlog-server "$SSH_HOST:$REMOTE_APP_DIR/"
ssh -i "$SSH_KEY" "$SSH_HOST" "chmod +x $REMOTE_APP_DIR/contestlog-server"

echo "Copying helper and WSJT-X binaries..."
scp -i "$SSH_KEY" dist/contestlog-helper-* dist/contestlog-wsjtx-* "$SSH_HOST:$REMOTE_APP_DIR/downloads/"

echo "Starting service..."
ssh -i "$SSH_KEY" "$SSH_HOST" "cd $REMOTE_WORK_DIR && docker compose up -d"

echo "Deployment complete."
