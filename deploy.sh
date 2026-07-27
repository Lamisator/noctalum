#!/usr/bin/env bash
# Deploy Noctalum to the production or staging environment.
#
# Usage:
#   ./deploy.sh -prod                # build everything, then deploy to prod
#   ./deploy.sh -staging             # build everything, then deploy to staging
#   ./deploy.sh                      # prompt interactively for the environment
#   ./deploy.sh -staging --skip-build
#   ./deploy.sh -prod    --countdown 30
#   ./deploy.sh -staging -nohelpers  # skip helper/wsjtx/GUI build + upload
#                                    # (server + notifier only — much faster)
#   ./deploy.sh -prod --cpp-macos       # enable C++ macOS cross-compile
#                                    # (off by default — needs
#                                    #  cpp/third_party/osxcross-sdk/
#                                    #  populated with a MacOSX SDK)
#   ./deploy.sh -prod --cpp-no-windows  # skip C++ Windows cross-compile
#
# Environment selection is mandatory. If neither -prod nor -staging is
# given, the script asks on stdin. Deploying to staging never triggers
# the Telegram announcement (staging releases are not user-facing).
#
# The two environments share the same server (SSH_HOST) and the same
# codebase, but live in different remote directories (see
# PROD_REMOTE_WORK_DIR / STAGING_REMOTE_WORK_DIR in .deploy.env) with
# their own Postgres data, .env, compose file and Docker container
# names — a bad deploy to one cannot touch the other's data.
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

# Load deployment secrets (SSH key path, server hostname, remote directories).
# Copy .deploy.env.example → .deploy.env and fill in your values.
DEPLOY_ENV="$(dirname "$0")/.deploy.env"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "error: $DEPLOY_ENV not found — copy .deploy.env.example and fill in your values" >&2
  exit 1
fi
# shellcheck source=.deploy.env.example
. "$DEPLOY_ENV"

# Shared SSH options: keep-alive so a stalled SFTP dies within ~60 s
# (4 pings, 15 s apart) instead of hanging. ConnectTimeout=10 caps
# the initial handshake.
SSH_OPTS=(
  -i "$SSH_KEY"
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)

# ------------------------------------------------------------------
# Argument parsing.
# The environment flag (-prod / -staging) is mandatory. We keep the
# other flags (--skip-build, --countdown) after it in any order, and
# reject the legacy --transfer-db explicitly to guide operators to
# cmd/sqlite-to-pg.
# ------------------------------------------------------------------

env_flag=""
skip_build=false
no_helpers=false
cpp_no_windows=false
# macOS cross-compile stays off unless the operator explicitly opts in
# via --cpp-macos.  Matches build.sh's default (see note there).
cpp_macos=false
countdown=60

while [ $# -gt 0 ]; do
  case "$1" in
    -prod|--prod)
      env_flag=prod ; shift ;;
    -staging|--staging)
      env_flag=staging ; shift ;;
    --skip-build)
      skip_build=true ; shift ;;
    -nohelpers|--no-helpers)
      no_helpers=true ; shift ;;
    # C++ platform toggles — forwarded verbatim to build.sh.
    #   --cpp-no-windows : skip Windows cross-compile (default: on)
    #   --cpp-macos      : enable macOS cross-compile (default: off,
    #                      needs cpp/third_party/osxcross-sdk/ populated)
    #   --cpp-no-macos   : accepted but a no-op (macOS is off by default)
    --cpp-no-windows)
      cpp_no_windows=true ; shift ;;
    --cpp-no-macos)
      shift ;;
    --cpp-macos)
      cpp_macos=true ; shift ;;
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

# If no environment flag was given, prompt interactively rather than
# guessing — deploying to the wrong environment is a silent, hard-to-
# reverse mistake, so we make the operator name it explicitly.
if [ -z "$env_flag" ]; then
  if [ ! -t 0 ]; then
    echo "error: environment flag is required (-prod or -staging) when stdin is not a TTY" >&2
    exit 1
  fi
  while [ -z "$env_flag" ]; do
    printf 'Select environment (staging/prod): '
    read -r reply
    case "${reply,,}" in
      prod|production)  env_flag=prod ;;
      staging|stage)    env_flag=staging ;;
      *) echo "  please answer 'staging' or 'prod'" ;;
    esac
  done
fi

# Resolve the per-environment settings up front so the rest of the
# script only references generic variable names.
case "$env_flag" in
  prod)
    REMOTE_WORK_DIR="${PROD_REMOTE_WORK_DIR:-}"
    COMPOSE_FILE="docker-compose.prod.yml"
    CONTAINER_NAME="noctalum"
    NOTIFY_TELEGRAM=true
    ;;
  staging)
    REMOTE_WORK_DIR="${STAGING_REMOTE_WORK_DIR:-}"
    COMPOSE_FILE="docker-compose.staging.yml"
    CONTAINER_NAME="noctalum-staging"
    NOTIFY_TELEGRAM=false
    ;;
esac
if [ -z "$REMOTE_WORK_DIR" ]; then
  echo "error: remote work dir for $env_flag not set — add ${env_flag^^}_REMOTE_WORK_DIR to .deploy.env" >&2
  exit 1
fi

REMOTE_APP_DIR="$REMOTE_WORK_DIR/app"

echo "==> deploying to $env_flag ($SSH_HOST:$REMOTE_WORK_DIR)"

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ "$skip_build" = false ]; then
  build_args=()
  if [ "$no_helpers" = true ]; then
    echo "Building server + notifier only (--no-helpers)..."
    build_args+=(--no-helpers)
  else
    echo "Building all binaries..."
  fi
  [ "$cpp_no_windows" = true ] && build_args+=(--cpp-no-windows)
  [ "$cpp_macos"      = true ] && build_args+=(--cpp-macos)
  "$ROOT/build.sh" "${build_args[@]}"
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

echo "Uploading compose file ($COMPOSE_FILE, staged as .new)..."
scp "${SSH_OPTS[@]}" "$ROOT/$COMPOSE_FILE" \
  "$SSH_HOST:$REMOTE_WORK_DIR/docker-compose.yml.new"

echo "Uploading server binary (staged as .new)..."
scp "${SSH_OPTS[@]}" "$ROOT/dist/noctalum-linux-amd64" \
  "$SSH_HOST:$REMOTE_APP_DIR/noctalum-server.new"

if [ "$no_helpers" = true ]; then
  echo "Skipping helper/wsjtx/GUI upload (-nohelpers)."
else
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
    # Purge the remote /downloads/ directory first so retired artefacts
    # (e.g. an old .zip that a Fyne rewrite replaced with a .exe, or an
    # old-arch AppImage the current build no longer produces) can't
    # linger and shadow the fresh files in the download UI.  We only
    # purge the noctalum-{helper,wsjtx}-* namespace — anything else in
    # /downloads/ (dist-provided icons, README, ad-hoc uploads) is left
    # alone.  Ordering matters: purge THEN scp, never the reverse.
    ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
      "rm -f $REMOTE_APP_DIR/downloads/noctalum-helper-* $REMOTE_APP_DIR/downloads/noctalum-wsjtx-*"
    scp "${SSH_OPTS[@]}" "${downloads[@]}" \
      "$SSH_HOST:$REMOTE_APP_DIR/downloads/"
  fi
fi

# The host-side restore hook is shared infrastructure: it uses a
# single systemd path unit watching prod's data/restore_trigger. We
# only (re)install it during prod deploys so that staging doesn't
# quietly overwrite prod's units with staging-flavoured copies.
if [ "$env_flag" = "prod" ]; then
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
fi

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
if ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s "$countdown" "$REMOTE_WORK_DIR" "$CONTAINER_NAME" <<'REMOTE_TRIGGER'
set -u
countdown="$1"
workdir="$2"
container="$3"
started_before="$(docker inspect --format='{{.State.StartedAt}}' "$container" 2>/dev/null || true)"
printf '%s\n' "$countdown" > "$workdir/data/shutdown_trigger"
if [ -z "$started_before" ]; then
  echo "  container not running — skipping wait, proceeding straight to compose down"
  exit 0
fi
echo "  trigger written; waiting for container restart (StartedAt was $started_before)"
deadline=$(( $(date +%s) + countdown + 15 ))
while true; do
  started_now="$(docker inspect --format='{{.State.StartedAt}}' "$container" 2>/dev/null || true)"
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
#
# Staging is intentionally silent: the release notes go out once,
# with the prod deploy, so the Telegram group only sees things that
# are actually live for users.
# ------------------------------------------------------------------

if [ "$NOTIFY_TELEGRAM" = true ]; then
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
else
  echo "Skipping Telegram announcement (staging deploy)."
fi
