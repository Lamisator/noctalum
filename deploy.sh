#!/usr/bin/env bash
# Deploy Noctalum to the production server.
#
# Usage:
#   ./deploy.sh                      # build everything, then deploy
#   ./deploy.sh --skip-build         # deploy already-built dist/ artifacts (no rebuild)
#   ./deploy.sh --countdown 30       # warn users N seconds before shutdown (default: 60)
#
# Database migration from a legacy SQLite file is done separately via
# `cmd/sqlite-to-pg` — see its --help. deploy.sh does not touch the
# database.
#
# Reliability model
# -----------------
# The old failure mode: `docker compose down` fired early, then a
# hung `scp` of the helper binaries left prod offline for as long as
# it took an operator to notice. Two structural changes stop that
# from happening again:
#
#   1. Upload-first. Every file that has to land on the server (the
#      compose file, the server binary, helper downloads, the
#      systemd units) is uploaded while the OLD app is still
#      serving. Compose file and server binary are staged as
#      `*.new` so the running instance never sees a mid-write file.
#      If any upload fails or hangs, the shutdown window never
#      opens and users don't notice.
#
#   2. Recovery trap. Once we enter the shutdown-and-swap window
#      an EXIT trap is set that will attempt `docker compose up -d`
#      no matter how the script exits (error, kill, hang timeout).
#      A successful swap clears the trap; anything else at least
#      gets Postgres+app back on their feet before the operator
#      wakes up.
#
#   3. SSH keep-alive. ConnectTimeout=10 plus 60 s of silence
#      (ServerAliveInterval*Count) forces a stalled connection to
#      die with an error the trap can catch, instead of hanging
#      indefinitely as it did during the v0.71 audit-coverage
#      deploy.

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

# Shared SSH options: keep-alive so a stalled SFTP dies within ~60 s
# (4 pings, 15 s apart) instead of hanging. ConnectTimeout=10 caps
# the initial handshake.
SSH_OPTS=(
  -i "$SSH_KEY"
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)

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

# ------------------------------------------------------------------
# Phase 1 — pre-flight: dirs, .env, stale-file cleanup.
# Old app keeps serving throughout this phase.
# ------------------------------------------------------------------

echo "Preparing remote directories..."
# pgdata holds the Postgres data directory bind-mount. postgres:16's
# entrypoint chowns it to UID 999 on first init if it's empty, so we
# just need it to exist — no chown here.
ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "mkdir -p $REMOTE_APP_DIR/downloads $REMOTE_WORK_DIR/data $REMOTE_WORK_DIR/pgdata $REMOTE_WORK_DIR/backups"

# Clean up any *.new files left behind by a previous deploy that
# crashed mid-upload. Safe to remove: they're never live until the
# atomic mv at the end of the downtime window.
ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "rm -f $REMOTE_WORK_DIR/docker-compose.yml.new $REMOTE_APP_DIR/noctalum-server.new"

# First-run bootstrap: if .env does not exist on the server, mint a
# strong random POSTGRES_PASSWORD and write it. We *never* overwrite
# an existing .env — rotating the password after the DB is already
# initialised would lock the app out. openssl ships with the target
# host so no extra install step is needed.
echo "Bootstrapping .env if missing..."
ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s "$REMOTE_WORK_DIR" <<'REMOTE_ENV'
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

# ------------------------------------------------------------------
# Phase 2 — uploads: compose, binary, helpers, systemd. Old app
# still serving traffic — nothing here can knock it over.
# ------------------------------------------------------------------

echo "Uploading compose file (staged as .new)..."
scp "${SSH_OPTS[@]}" "$ROOT/docker-compose.prod.yml" \
  "$SSH_HOST:$REMOTE_WORK_DIR/docker-compose.yml.new"

echo "Uploading server binary (staged as .new)..."
scp "${SSH_OPTS[@]}" "$ROOT/dist/noctalum-linux-amd64" \
  "$SSH_HOST:$REMOTE_APP_DIR/noctalum-server.new"

echo "Uploading helper, WSJT-X, and GUI binaries to downloads..."
# In-place upload is acceptable here: these are read-only static
# artifacts served under /downloads/. A user mid-download during
# the scp overlap could get a truncated file, but the affected
# window is single-digit seconds per file and downloads are rare.
# Use nullglob so missing globs (skipped GUI builds) are silent.
shopt -s nullglob
downloads=(
  "$ROOT"/dist/noctalum-helper-*
  "$ROOT"/dist/noctalum-wsjtx-*
)
shopt -u nullglob
if [ ${#downloads[@]} -eq 0 ]; then
  echo "warning: no helper/wsjtx binaries found in dist/ — was build skipped?" >&2
else
  scp "${SSH_OPTS[@]}" "${downloads[@]}" \
    "$SSH_HOST:$REMOTE_APP_DIR/downloads/"
fi

echo "Installing systemd restore hook..."
# UI-triggered database restore is done by a host-side systemd unit
# (see deploy/systemd/noctalum-restore.*): the app writes a JSON
# trigger file to $REMOTE_WORK_DIR/data/restore_trigger, a
# PathModified path unit picks it up, and the service unit executes
# a shell script that stops the container, feeds the .sql.gz into
# psql, and starts the container back up. Copying the units and
# daemon-reload is safe with the old app still serving — the units
# only fire when the trigger file appears.
scp "${SSH_OPTS[@]}" \
  "$ROOT/deploy/systemd/noctalum-restore.path" \
  "$ROOT/deploy/systemd/noctalum-restore.service" \
  "$ROOT/deploy/systemd/noctalum-restore.sh" \
  "$SSH_HOST:/etc/systemd/system/"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "chmod +x /etc/systemd/system/noctalum-restore.sh && systemctl daemon-reload && systemctl enable --now noctalum-restore.path"

# ------------------------------------------------------------------
# Phase 3 — downtime window. From here to the successful `docker
# compose up -d` an EXIT trap will attempt to bring the stack up
# no matter how the script exits. Success clears the trap.
# ------------------------------------------------------------------

deploy_succeeded=false
recover() {
  if [ "$deploy_succeeded" = true ]; then
    return
  fi
  echo "!!! deploy exited early during the downtime window — attempting recovery" >&2
  # Best effort: try to bring the stack back up. If the .new files
  # were successfully renamed the new binary runs; otherwise the
  # previous binary is still on disk and comes back. Either way
  # prod is serving something instead of nothing.
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
    "cd $REMOTE_WORK_DIR && docker compose up -d" || \
    echo "!!! recovery `docker compose up -d` also failed — hand-fix needed" >&2
}
trap recover EXIT

# Trigger a graceful shutdown: write the countdown (in seconds) to the trigger
# file that the server polls every 2 s.  The server broadcasts a deploy_warning
# to all connected users, then sends itself SIGTERM after the countdown elapses.
#
# Detection strategy: `docker inspect` the container's State.StartedAt
# timestamp before and after the trigger.  The self-SIGTERM makes the
# process exit; docker's `restart: unless-stopped` policy immediately
# restarts the container, which bumps StartedAt — that transition is
# our "grace period fully elapsed" signal.
#
# All polling runs inside a single SSH session so we don't pay ~200 ms
# of connection overhead per iteration.
echo "Triggering graceful shutdown (${countdown}s warning)..."
if ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s "$countdown" "$REMOTE_WORK_DIR" <<'REMOTE_TRIGGER'
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

echo "Stopping stack + swapping in new artifacts..."
# Everything on one SSH round-trip so the "app down" window is as
# tight as possible: compose down, atomic renames, compose up. If
# any command fails the whole heredoc aborts (set -e) and the trap
# above kicks in.
ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s "$REMOTE_WORK_DIR" "$REMOTE_APP_DIR" <<'REMOTE_SWAP'
set -euo pipefail
workdir="$1"
appdir="$2"
cd "$workdir"

docker compose down

# Atomic swap of the staged .new files. `mv` on the same
# filesystem is a rename (single inode metadata update) — the
# in-container view flips in one go, no partial-write window.
if [ -f docker-compose.yml.new ]; then
  mv docker-compose.yml.new docker-compose.yml
fi
if [ -f "$appdir/noctalum-server.new" ]; then
  mv "$appdir/noctalum-server.new" "$appdir/noctalum-server"
  chmod +x "$appdir/noctalum-server"
fi

docker compose up -d
REMOTE_SWAP

deploy_succeeded=true
trap - EXIT
echo "Deployment complete."

# ------------------------------------------------------------------
# Post-deploy: Telegram announcement (non-fatal — the notifier
# itself exits 0 on missing config or network errors).
# ------------------------------------------------------------------

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
