#!/usr/bin/env bash
# Nightly Musaic database backup.
# Uses the SQLite online-backup API (safe while the server is running in WAL mode),
# verifies the copy with PRAGMA quick_check, and rotates old backups.
#
# Env overrides:
#   MUSAIC_DB_PATH   source database (default: /opt/musaic-server/shared/musaic.db)
#   MUSAIC_BACKUP_DIR destination directory (default: /opt/musaic-server/backups)
#   MUSAIC_BACKUP_KEEP how many dated backups to keep (default: 14)
#   MUSAIC_BACKUP_REMOTE optional off-site target for the dated copy:
#                     "rclone:<remote>:<path>" uses rclone, anything else is an
#                     rsync destination such as user@host:/srv/musaic-backups
#   MUSAIC_BACKUP_REMOTE_SECRETS=1 also ship .env and .musaic.secret off-site
#                     (off by default: the secret decrypts stored provider tokens)

set -Eeuo pipefail

db_path="${MUSAIC_DB_PATH:-/opt/musaic-server/shared/musaic.db}"
backup_dir="${MUSAIC_BACKUP_DIR:-/opt/musaic-server/backups}"
keep="${MUSAIC_BACKUP_KEEP:-14}"

if [[ ! -f "$db_path" ]]; then
  echo "Database not found: $db_path" >&2
  exit 1
fi

mkdir -p "$backup_dir"

stamp="$(date +%Y-%m-%d)"
dest_db="$backup_dir/musaic-$stamp.db"
tmp_db="$dest_db.tmp"

rm -f -- "$tmp_db"

export MUSAIC_BACKUP_SRC="$db_path"
export MUSAIC_BACKUP_DST="$tmp_db"

python3 - <<'PY'
import os
import sqlite3
import sys

src_path = os.environ["MUSAIC_BACKUP_SRC"]
dst_path = os.environ["MUSAIC_BACKUP_DST"]

src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
dst = sqlite3.connect(dst_path)
try:
    src.backup(dst)
    row = dst.execute("PRAGMA quick_check").fetchone()
finally:
    dst.close()
    src.close()

if not row or row[0] != "ok":
    os.unlink(dst_path)
    print(f"integrity check failed: {row}", file=sys.stderr)
    sys.exit(1)
PY

mv -f -- "$tmp_db" "$dest_db"

# Config and secret are tiny; keep a fresh copy next to the dated backups.
if [[ -f /opt/musaic-server/shared/.env ]]; then
  cp -a /opt/musaic-server/shared/.env "$backup_dir/env-latest"
fi
if [[ -f /opt/musaic-server/shared/.musaic.secret ]]; then
  cp -a /opt/musaic-server/shared/.musaic.secret "$backup_dir/musaic.secret-latest"
fi

# Rotate: keep the newest $keep dated database backups.
ls -1 "$backup_dir"/musaic-*.db 2>/dev/null | sort -r | tail -n "+$((keep + 1))" | while IFS= read -r stale; do
  rm -f -- "$stale"
done

size="$(du -h "$dest_db" | cut -f1)"
echo "Backup complete: $dest_db ($size), keeping $keep dated backups."

remote="${MUSAIC_BACKUP_REMOTE:-}"
if [[ -n "$remote" ]]; then
  offsite=("$dest_db")
  if [[ "${MUSAIC_BACKUP_REMOTE_SECRETS:-0}" == "1" ]]; then
    for extra in "$backup_dir/env-latest" "$backup_dir/musaic.secret-latest"; do
      [[ -f "$extra" ]] && offsite+=("$extra")
    done
  fi
  # A failed off-site copy fails the unit so `systemctl --failed` surfaces it.
  if [[ "$remote" == rclone:* ]]; then
    command -v rclone >/dev/null 2>&1 || { echo "rclone is not installed" >&2; exit 1; }
    for item in "${offsite[@]}"; do
      rclone copy --no-traverse "$item" "${remote#rclone:}"
    done
  else
    command -v rsync >/dev/null 2>&1 || { echo "rsync is not installed" >&2; exit 1; }
    rsync -a --timeout=120 -- "${offsite[@]}" "$remote/"
  fi
  echo "Off-site copy complete: $remote"
fi
