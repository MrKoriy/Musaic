#!/usr/bin/env bash
# Restore a Musaic database backup.
# Usage: restore-db.sh /opt/musaic-server/backups/musaic-2026-09-06.db
#
# Stops the server, swaps the database (stale WAL/SHM files are removed —
# they must never outlive their database), restarts, and health-checks.
# A pre-restore snapshot of the current database is saved next to the backups.

set -Eeuo pipefail

backup_path="${1:-}"

if [[ -z "$backup_path" ]]; then
  echo "Usage: $0 <backup-file.db>" >&2
  exit 2
fi

if [[ ! "$backup_path" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Backup path must be absolute without shell metacharacters." >&2
  exit 2
fi

if [[ ! -f "$backup_path" ]]; then
  echo "Backup file not found: $backup_path" >&2
  exit 1
fi

shared_dir="/opt/musaic-server/shared"
db_path="$shared_dir/musaic.db"
backup_dir="/opt/musaic-server/backups"
service_name="musaic-server.service"

if command -v systemctl >/dev/null 2>&1 && systemctl cat "$service_name" >/dev/null 2>&1; then
  :
else
  service_name="musaic.service"
fi

# Verify the backup is a readable SQLite database before touching anything.
if ! python3 - "$backup_path" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    row = db.execute("PRAGMA quick_check").fetchone()
finally:
    db.close()
sys.exit(0 if row and row[0] == "ok" else 1)
PY
then
  echo "Backup failed the integrity check: $backup_path" >&2
  exit 1
fi

restore_failed() {
  local status=$?
  if ((status != 0)) && [[ -f "$backup_dir/pre-restore.db" ]]; then
    echo "Restore failed; putting the pre-restore database back." >&2
    rm -f -- "$db_path" "$db_path-wal" "$db_path-shm"
    mv -f -- "$backup_dir/pre-restore.db" "$db_path"
    systemctl restart "$service_name" || true
  fi
  exit "$status"
}
trap restore_failed EXIT

echo "Stopping $service_name..."
systemctl stop "$service_name"

mkdir -p "$backup_dir"
if [[ -f "$db_path" ]]; then
  cp -a -- "$db_path" "$backup_dir/pre-restore.db"
fi

rm -f -- "$db_path-wal" "$db_path-shm"
cp -- "$backup_path" "$db_path.db-restore"
mv -f -- "$db_path.db-restore" "$db_path"

echo "Starting $service_name..."
systemctl start "$service_name"

port="$(sed -n "/^PORT=/s/^PORT=//p" "$shared_dir/.env" 2>/dev/null | sed -n 1p || true)"
cert="$(sed -n "/^TLS_CERT=/s/^TLS_CERT=//p" "$shared_dir/.env" 2>/dev/null | sed -n 1p || true)"
key="$(sed -n "/^TLS_KEY=/s/^TLS_KEY=//p" "$shared_dir/.env" 2>/dev/null | sed -n 1p || true)"
[[ "$port" =~ ^[0-9]+$ ]] || port=3001
if [[ -n "$cert" && -n "$key" ]]; then
  health_url="https://127.0.0.1:${port}/health"
else
  health_url="http://127.0.0.1:${port}/health"
fi

for attempt in {1..15}; do
  if [[ "$health_url" == https://* ]]; then
    health="$(curl --insecure --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null || true)"
  else
    health="$(curl --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null || true)"
  fi
  if [[ "$health" == *'"ok":true'* ]]; then
    trap - EXIT
    echo "Restore complete: $backup_path"
    echo "Health: $health"
    exit 0
  fi
  sleep 2
done

echo "Restored, but the health endpoint did not respond." >&2
journalctl -u "$service_name" -n 30 --no-pager >&2 || true
exit 1
