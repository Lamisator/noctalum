#!/usr/bin/env bash
# Executed by noctalum-restore.service in response to the app writing
# /srv/docker/noctalum/data/restore_trigger from a UI-triggered restore.
#
# Contract with the app (internal/server/backups.go handleBackupRestore):
#   - Trigger file is a JSON blob:
#       {"backup_file":"noctalum-...sql.gz","requested_by":"<user>",
#        "requested_at":"<rfc3339>","safety_backup":"noctalum-...sql.gz"}
#   - The app has already taken `safety_backup` right before writing
#     the trigger, so a botched restore leaves us with a one-step
#     rollback in ./backups/.
#   - This script is responsible for deleting the trigger file
#     ON EVERY EXIT PATH (success OR failure), otherwise the systemd
#     path unit would re-fire on the next PathModified event.
#
# Steps:
#   1. Parse the trigger to get backup_file.
#   2. Verify the file exists in ./backups/.
#   3. `docker compose stop noctalum`
#   4. `zcat ./backups/<file> | docker exec -i noctalum-postgres psql -U noctalum -d noctalum`
#   5. Delete the trigger.
#   6. `docker compose start noctalum`
#
# All output goes to journalctl -u noctalum-restore.service.

set -euo pipefail

WORKDIR="/srv/docker/noctalum"
TRIGGER="$WORKDIR/data/restore_trigger"
BACKUPS="$WORKDIR/backups"
COMPOSE_FILE="$WORKDIR/docker-compose.yml"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cleanup_trigger() { rm -f "$TRIGGER"; }
# EXIT trap fires on both normal completion and any `set -e` abort, so
# the trigger always gets removed — no infinite re-firing loops.
trap cleanup_trigger EXIT

if [ ! -f "$TRIGGER" ]; then
  log "no trigger file at $TRIGGER — nothing to do"
  exit 0
fi

log "restore requested; parsing trigger"
# We could hard-depend on jq, but python3 ships with debian-slim and is
# already elsewhere in the deploy path. Fall back to a plain regex if
# neither is available (defensive; not the expected path).
BACKUP_FILE=""
if command -v jq >/dev/null 2>&1; then
  BACKUP_FILE="$(jq -r '.backup_file' < "$TRIGGER")"
elif command -v python3 >/dev/null 2>&1; then
  BACKUP_FILE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["backup_file"])' "$TRIGGER")"
else
  BACKUP_FILE="$(grep -oE '"backup_file":"[^"]+"' "$TRIGGER" | head -1 | sed 's/.*"backup_file":"//;s/"$//')"
fi

if [ -z "$BACKUP_FILE" ]; then
  log "ERROR: trigger file did not contain backup_file — refusing to restore"
  exit 1
fi
# Defensive: forbid path traversal even though the app validated the
# name already. Belt-and-suspenders against a compromised app process.
case "$BACKUP_FILE" in
  */*|*..*) log "ERROR: backup_file contains suspicious characters: $BACKUP_FILE"; exit 1 ;;
esac

BACKUP_PATH="$BACKUPS/$BACKUP_FILE"
if [ ! -f "$BACKUP_PATH" ]; then
  log "ERROR: backup file not found: $BACKUP_PATH"
  exit 1
fi

log "target backup: $BACKUP_PATH ($(stat -c%s "$BACKUP_PATH") bytes)"
log "stopping noctalum container"
docker compose -f "$COMPOSE_FILE" --project-directory "$WORKDIR" stop noctalum

log "loading backup into postgres"
if zcat "$BACKUP_PATH" | docker exec -i noctalum-postgres \
    psql -v ON_ERROR_STOP=1 -U noctalum -d noctalum >/dev/null; then
  log "restore succeeded"
else
  RC=$?
  log "ERROR: psql load exited $RC — starting noctalum anyway to avoid an outage"
  docker compose -f "$COMPOSE_FILE" --project-directory "$WORKDIR" start noctalum
  exit "$RC"
fi

log "starting noctalum container"
docker compose -f "$COMPOSE_FILE" --project-directory "$WORKDIR" start noctalum

log "done"
