#!/usr/bin/env sh
set -eu
umask 077
: "${DATABASE_URL:?Set DATABASE_URL to an empty restore target database}"
BACKUP_FILE="${1:?Usage: scripts/restore-db.sh <backup-file>}"
case "$BACKUP_FILE" in
  *.dump) ;;
  *) echo "Refusing non-.dump input" >&2; exit 2 ;;
esac
DB_NAME=$(printf '%s\n' "$DATABASE_URL" | sed -nE 's|^[a-zA-Z][a-zA-Z0-9+.-]*://([^/]*@)?[^/]+/([^?/#]+)([?].*)?$|\2|p')
if [ -z "$DB_NAME" ]; then
  echo "Refusing restore: DATABASE_URL must contain a parseable database name" >&2
  exit 2
fi
case "$DB_NAME" in
  *_restore_test) ;;
  *)
    if [ "${ALLOW_NON_TEST_RESTORE:-false}" != "true" ]; then
      echo "Refusing restore unless database name ends with _restore_test. Set ALLOW_NON_TEST_RESTORE=true only after explicit operator review." >&2
      exit 2
    fi
    ;;
esac
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 2
fi
if ! pg_restore --list "$BACKUP_FILE" >/dev/null; then
  echo "Backup file is not a valid PostgreSQL custom-format archive" >&2
  exit 2
fi
IS_EMPTY=$(psql "$DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --command="SELECT NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname !~ '^pg_'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
  );")
if [ "$IS_EMPTY" != "t" ]; then
  echo "Refusing restore: target database must not contain user schema objects" >&2
  exit 2
fi
pg_restore --no-owner --no-acl --exit-on-error --dbname="$DATABASE_URL" "$BACKUP_FILE"
printf 'Restore completed into database: %s\n' "$DB_NAME"
