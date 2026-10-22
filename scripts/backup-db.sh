#!/usr/bin/env sh
set -eu
umask 077
: "${DATABASE_URL:?Set DATABASE_URL to the database to back up}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/harvestguard-$STAMP.dump"
SUFFIX=0
while ! (set -C; : > "$FILE") 2>/dev/null; do
  SUFFIX=$((SUFFIX + 1))
  FILE="$BACKUP_DIR/harvestguard-$STAMP-$SUFFIX.dump"
done
trap 'rm -f "$FILE"' 0 HUP INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$FILE" "$DATABASE_URL"
trap - 0 HUP INT TERM
printf 'Backup created: %s\n' "$FILE"
