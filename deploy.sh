#!/usr/bin/env bash
# Deploy Noctalum to the production server.
#
# Usage:
#   ./deploy.sh                      # build everything, then deploy
#   ./deploy.sh --skip-build         # deploy already-built dist/ artifacts (no rebuild)
#   ./deploy.sh --countdown 30       # warn users N seconds before shutdown (default: 15)
#
# Database migration from a legacy SQLite file is done separately via
# `cmd/sqlite-to-pg` — see its --help. deploy.sh does not touch the
# database.

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
countdown=60

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)  skip_build=true  ; shift ;;
    --transfer-db)
      echo "error: --transfer-db is no longer supported. Use cmd/sqlite-to-pg to migrate a SQLite backup into Postgres." >&2
      exit 1
      ;;
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
# pgdata holds the Postgres data directory bind-mount. postgres:16's
# entrypoint chowns it to UID 999 on first init if it's empty, so we
# just need it to exist — no chown here.
ssh -i "$SSH_KEY" "$SSH_HOST" \
  "mkdir -p $REMOTE_APP_DIR/downloads $REMOTE_WORK_DIR/data $REMOTE_WORK_DIR/pgdata $REMOTE_WORK_DIR/backups"

# First-run bootstrap: if .env does not exist on the server, mint a
# strong random POSTGRES_PASSWORD and write it. We *never* overwrite
# an existing .env — rotating the password after the DB is already
# initialised would lock the app out. openssl ships with the target
# host so no extra install step is needed.
echo "Bootstrapping .env if missing..."
ssh -i "$SSH_KEY" "$SSH_HOST" bash -s "$REMOTE_WORK_DIR" <<'REMOTE_ENV'
set -euo pipefail
cd "$1"
ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  echo "  .env already exists — leaving it alone"
else
  PW="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-40)"
  printf 'POSTGRES_PASSWORD=%s\n' "$PW" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  wrote fresh .env with a random POSTGRES_PASSWORD"
fi
REMOTE_ENV

echo "Copying docker-compose.yml..."
# Push the production compose file (Traefik labels, external proxy network,
# fixed container_name) — NOT the repo-root docker-compose.yml, which is the
# dev-flavored variant used for local runs and would knock the live container
# off Traefik if deployed.
scp -i "$SSH_KEY" "$ROOT/docker-compose.prod.yml" "$SSH_HOST:$REMOTE_WORK_DIR/docker-compose.yml"

# Trigger a graceful shutdown: write the countdown (in seconds) to the trigger
# file that the server polls every 2 s.  The server broadcasts a deploy_warning
# to all connected users, then sends itself SIGTERM after the countdown elapses.
# No HTTP endpoint is involved — file-write access requires SSH access to the
# host, which is already a prerequisite for this deploy script.
#
# Detection strategy: `docker inspect` the container's State.StartedAt
# timestamp before and after the trigger.  The self-SIGTERM makes the
# process exit; docker's `restart: unless-stopped` policy immediately
# restarts the container, which bumps StartedAt — that transition is
# our "grace period fully elapsed" signal.  Previous versions polled
# `curl http://localhost:8675/api/me` on the server, which never
# reached the container (the prod compose file doesn't publish 8675
# to the host — Traefik fronts it), so the poll bailed out on the
# first attempt and `docker compose down` fired before the app had
# even started its countdown.
#
# All polling runs inside a single SSH session so we don't pay ~200 ms
# of connection overhead per iteration.
echo "Triggering graceful shutdown (${countdown}s warning)..."
if ssh -i "$SSH_KEY" "$SSH_HOST" bash -s "$countdown" "$REMOTE_WORK_DIR" <<'REMOTE_TRIGGER'
set -u
countdown="$1"
workdir="$2"
started_before="$(docker inspect --format='{{.State.StartedAt}}' noctalum 2>/dev/null || true)"
printf '%s\n' "$countdown" > "$workdir/data/shutdown_trigger"
if [ -z "$started_before" ]; then
  echo "  container not running — skipping wait, proceeding straight to compose down"
  exit 0
fi
echo "  trigger written; waiting for container restart (StartedAt was $started_before)"
deadline=$(( $(date +%s) + countdown + 15 ))
while true; do
  started_now="$(docker inspect --format='{{.State.StartedAt}}' noctalum 2>/dev/null || true)"
  if [ -n "$started_now" ] && [ "$started_now" != "$started_before" ]; then
    echo "  container restarted at $started_now — grace period complete"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "  warning: container did not restart within countdown+15s — proceeding anyway" >&2
    break
  fi
  sleep 2
done
REMOTE_TRIGGER
then
  :
else
  echo "note: shutdown-trigger SSH failed — proceeding with docker compose down" >&2
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
