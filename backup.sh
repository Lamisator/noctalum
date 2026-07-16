#!/usr/bin/env bash
# Take a hot backup of the running Postgres via pg_dump.
#
# Usage:
#   ./backup.sh                     # dump to ./backups on the *local* machine (dev)
#   ./backup.sh --remote            # dump to $REMOTE_WORK_DIR/backups on the server
#
# Output filename: noctalum-YYYYMMDDTHHMMSSZ.sql.gz  (custom-format would be
# faster/smaller but plain SQL is a lot easier to grep, diff, and restore
# with `psql < file`.)
#
# WHY pg_dump and not `cp -r pgdata/`: Postgres is writing to its data
# directory continuously — snapshotting the raw files while the server
# runs risks a torn write and a corrupt restore. pg_dump takes a
# consistent snapshot in a single transaction, works while the server
# serves traffic, and produces a portable file that restores against any
# Postgres 12+ (including a different major version).

set -euo pipefail

MODE="local"
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) MODE="remote"; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="noctalum-${STAMP}.sql.gz"

if [ "$MODE" = "local" ]; then
  mkdir -p ./backups
  echo "Dumping local Postgres to ./backups/${FILENAME}..."
  # The dev docker-compose exposes Postgres on 127.0.0.1:5432; the app's
  # env-file / .env sets POSTGRES_PASSWORD.
  PGPASSWORD="${POSTGRES_PASSWORD:-devpassword}" \
    pg_dump --no-owner --no-privileges \
      -h 127.0.0.1 -p 5432 -U noctalum noctalum \
    | gzip > "./backups/${FILENAME}"
  ls -lh "./backups/${FILENAME}"
else
  ROOT="$(cd "$(dirname "$0")" && pwd)"
  DEPLOY_ENV="$ROOT/.deploy.env"
  if [ ! -f "$DEPLOY_ENV" ]; then
    echo "error: $DEPLOY_ENV not found — needed for SSH_KEY / SSH_HOST / REMOTE_WORK_DIR" >&2
    exit 1
  fi
  # shellcheck source=.deploy.env.example
  . "$DEPLOY_ENV"
  echo "Dumping remote Postgres to ${REMOTE_WORK_DIR}/backups/${FILENAME}..."
  # `docker exec` runs pg_dump inside the postgres container so we don't
  # need psql client installed on the host and we don't publish the
  # Postgres port outside the internal db network. The password is read
  # from /run/secrets-style env inside the container.
  ssh -i "$SSH_KEY" "$SSH_HOST" \
    "cd $REMOTE_WORK_DIR && docker exec noctalum-postgres pg_dump --no-owner --no-privileges -U noctalum noctalum | gzip > backups/${FILENAME}"
  ssh -i "$SSH_KEY" "$SSH_HOST" "ls -lh $REMOTE_WORK_DIR/backups/${FILENAME}"
fi

echo "Backup complete."
