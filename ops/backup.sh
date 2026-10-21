#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/compose-root.sh"

# A consistent logical dump taken while the stack keeps serving; host backups copy $ROOT/backups instead of the live
# PostgreSQL data directory. ADDRESS_BACKUP_KEEP newest dumps are kept.
keep=${ADDRESS_BACKUP_KEEP:-2}
case "$keep" in ''|*[!0-9]*|0) echo "ADDRESS_BACKUP_KEEP must be a positive integer" >&2; exit 1 ;; esac
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$ROOT/backups/address-$timestamp.dump"
temporary="$target.tmp"
mkdir -p "$ROOT/backups"
chmod 700 "$ROOT/backups"
exec 9>"$ROOT/backups/.lock"
flock -n 9 || { echo "Another address backup is running" >&2; exit 1; }
trap 'rm -f "$temporary"' EXIT HUP INT TERM
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=zstd:3' >"$temporary"
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list <"$temporary" >/dev/null
chmod 600 "$temporary"
mv "$temporary" "$target"
trap - EXIT HUP INT TERM
ls -1t "$ROOT"/backups/address-*.dump | tail -n +"$((keep + 1))" | while IFS= read -r old; do rm -f -- "$old"; done
echo "$target"
