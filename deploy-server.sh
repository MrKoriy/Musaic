#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
server_dir="$script_dir/server"
remote_host="${MUSAIC_DEPLOY_HOST:-root@45.146.167.109}"
remote_dir="/opt/musaic-server"
service_name="musaic-server.service"
legacy_service_name="musaic.service"
sidecar_service_name="musaic-sidecar.service"
action="${1:-deploy}"
backup_path="${2:-}"

usage() {
  printf 'Usage: %s [deploy|rollback|restore BACKUP_DIR]\n' "${BASH_SOURCE[0]}" >&2
}

case "$action" in
  deploy|rollback|restore)
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ "$action" == "restore" && -z "$backup_path" ]]; then
  usage
  exit 2
fi

if [[ "${MUSAIC_DEPLOY_SSHPASS:-0}" != "0" && "${MUSAIC_DEPLOY_SSHPASS:-0}" != "1" ]]; then
  echo "MUSAIC_DEPLOY_SSHPASS must be 0 or 1." >&2
  exit 2
fi

ssh_command=(ssh)
if [[ "${MUSAIC_DEPLOY_SSHPASS:-0}" == "1" ]]; then
  if [[ -z "${SSHPASS:-}" ]]; then
    echo "MUSAIC_DEPLOY_SSHPASS=1 requires SSHPASS to be set." >&2
    exit 2
  fi
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "MUSAIC_DEPLOY_SSHPASS=1 requires sshpass to be installed." >&2
    exit 2
  fi
  ssh_command=(sshpass -e ssh)
fi

if [[ "$action" != "rollback" && "$action" != "restore" ]]; then
  if [[ ! -d "$server_dir/src" || ! -f "$server_dir/package.json" ]]; then
    echo "Musaic server sources not found at: $server_dir" >&2
    exit 1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required for local deployment checks." >&2
    exit 1
  fi

  echo "Running local server install, build, and typecheck checks."
  pushd "$server_dir" >/dev/null
  bun install --frozen-lockfile
  bun run build
  bun run typecheck
  popd >/dev/null

  echo "Deploying $server_dir to $remote_host:$remote_dir"
  echo "Persistent database, environment, secrets, downloads, covers, and virtual environments stay outside releases."

  COPYFILE_DISABLE=1 tar -C "$script_dir" \
    --exclude='server/.env' \
    --exclude='server/.musaic.secret' \
    --exclude='server/musaic.db*' \
    --exclude='server/downloads' \
    --exclude='server/covers' \
    --exclude='server/node_modules' \
    --exclude='server/sidecar/.venv' \
    --exclude='server/.lyrics-venv' \
    --exclude='server/.backups' \
    --exclude='server/dist' \
    --exclude='server/coverage' \
    --exclude='server/.DS_Store' \
    --exclude='server/._*' \
    -czf - server deploy | "${ssh_command[@]}" "$remote_host" '
set -Eeuo pipefail

remote_dir=/opt/musaic-server
releases_dir="$remote_dir/releases"
current_link="$remote_dir/current"
shared_dir="$remote_dir/shared"
backup_root=/opt/musaic-backups
service_name=musaic-server.service
legacy_service_name=musaic.service
sidecar_service_name=musaic-sidecar.service
release_id="$(date +%Y%m%d-%H%M%S)-$$"
release_dir="$releases_dir/$release_id"
previous_release=""
server_stopped=0

mkdir -p "$releases_dir" "$shared_dir" "$backup_root"
mkdir "$release_dir"
tar -xzf - -C "$release_dir"

if [[ -f "$release_dir/deploy/musaic-server.service" ]]; then
  install -m 0644 "$release_dir/deploy/musaic-server.service" /etc/systemd/system/musaic-server.service
  systemctl daemon-reload
fi

if systemctl cat "$service_name" >/dev/null 2>&1; then
  service_name="musaic-server.service"
elif systemctl cat "$legacy_service_name" >/dev/null 2>&1; then
  service_name="$legacy_service_name"
else
  echo "No Musaic systemd service is installed after release transfer." >&2
  exit 1
fi

if [[ -L "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link")"
fi

copy_if_missing() {
  local source_path="$1"
  local destination="$2"
  if [[ ! -e "$destination" && ! -L "$destination" && -e "$source_path" ]]; then
    cp -a "$source_path" "$destination"
  fi
}

migrate_directory() {
  local source_path="$1"
  local destination="$2"
  if [[ ! -e "$destination" && -d "$source_path" ]]; then
    mv "$source_path" "$destination"
  fi
  mkdir -p "$destination"
}

prepare_sidecar() {
  if [[ ! -f "$release_dir/server/sidecar/requirements.txt" ]]; then
    return 0
  fi

  local venv="$shared_dir/sidecar-venv"
  if [[ ! -x "$venv/bin/python" ]]; then
    python3 -m venv "$venv"
  fi
  "$venv/bin/python" -m pip install -q -r "$release_dir/server/sidecar/requirements.txt"
  ln -s "$venv" "$release_dir/server/sidecar/.venv"
}

switch_release() {
  local target="$1"
  rm -f "$current_link.next"
  ln -s "$target" "$current_link.next"
  mv -Tf "$current_link.next" "$current_link"
}

backup_item() {
  local source_path="$1"
  if [[ -e "$source_path" || -L "$source_path" ]]; then
    if [[ -d "$source_path" && ! -L "$source_path" ]]; then
      # Audio and cover caches are written with temp-file + rename semantics;
      # hard-linked snapshots preserve them without duplicating gigabytes.
      cp -al "$source_path" "$backup_dir/"
    else
      cp -a "$source_path" "$backup_dir/"
    fi
  fi
}

rotate_backups() {
  local candidate
  local -a backup_dirs=()
  local -a ordered_backups=()

  for candidate in "$backup_root"/predeploy-*; do
    [[ -d "$candidate" ]] && backup_dirs+=("$candidate")
  done

  if ((${#backup_dirs[@]} > 7)); then
    mapfile -t ordered_backups < <(printf "%s\n" "${backup_dirs[@]}" | sort -r)
    for ((i = 7; i < ${#ordered_backups[@]}; i++)); do
      rm -rf -- "${ordered_backups[i]}"
    done
  fi
}

health_url() {
  local port=3001 cert key
  if [[ -f "$shared_dir/.env" ]]; then
    port="$(sed -n "/^PORT=/s/^PORT=//p" "$shared_dir/.env" | sed -n 1p)"
    cert="$(sed -n "/^TLS_CERT=/s/^TLS_CERT=//p" "$shared_dir/.env" | sed -n 1p)"
    key="$(sed -n "/^TLS_KEY=/s/^TLS_KEY=//p" "$shared_dir/.env" | sed -n 1p)"
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || port=3001
  if [[ -n "$cert" && -n "$key" ]]; then
    printf "https://127.0.0.1:%s/health\n" "$port"
  else
    printf "http://127.0.0.1:%s/health\n" "$port"
  fi
}

health_gate() {
  local health url
  url="$(health_url)"
  for attempt in {1..10}; do
    if [[ "$url" == https://* ]]; then
      health="$(curl --insecure --fail --silent --show-error --max-time 2 "$url" 2>/dev/null || true)"
    else
      health="$(curl --fail --silent --show-error --max-time 2 "$url" 2>/dev/null || true)"
    fi
    if [[ "$health" == *\"ok\":true* ]]; then
      printf "Health gate passed: %s\n" "$health"
      return 0
    fi
    sleep 2
  done
  return 1
}

prune_releases() {
  local candidate
  local -a releases=()
  local -a ordered=()
  for candidate in "$releases_dir"/*; do
    [[ -d "$candidate" ]] && releases+=("$candidate")
  done
  mapfile -t ordered < <(printf "%s\n" "${releases[@]}" | sort -r)
  for ((i = 3; i < ${#ordered[@]}; i++)); do
    [[ "$(readlink -f "$current_link")" == "$(readlink -f "${ordered[i]}")" ]] && continue
    rm -rf -- "${ordered[i]}"
  done
}

restore_previous_release() {
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    switch_release "$previous_release"
  fi
  systemctl restart "$service_name" || true
  server_stopped=0
}

deploy_failed() {
  local status=$?
  if ((status != 0 && server_stopped == 1)); then
    restore_previous_release
  fi
  exit "$status"
}
trap deploy_failed EXIT

systemctl stop "$service_name" || true
server_stopped=1
if [[ "$service_name" == "musaic-server.service" ]] && systemctl is-active --quiet "$legacy_service_name"; then
  systemctl stop "$legacy_service_name"
fi
if systemctl cat "$sidecar_service_name" >/dev/null 2>&1; then
  systemctl stop "$sidecar_service_name" || true
fi

# Migrate data from the former flat deployment before creating release links.
for suffix in "" "-wal" "-shm"; do
  copy_if_missing "$remote_dir/musaic.db$suffix" "$shared_dir/musaic.db$suffix"
  copy_if_missing "$remote_dir/current/server/musaic.db$suffix" "$shared_dir/musaic.db$suffix"
done
for candidate in "$remote_dir/.env" "$remote_dir/server/.env" "$remote_dir/current/server/.env"; do
  copy_if_missing "$candidate" "$shared_dir/.env"
done
for candidate in "$remote_dir/.musaic.secret" "$remote_dir/server/.musaic.secret" "$remote_dir/current/server/.musaic.secret"; do
  copy_if_missing "$candidate" "$shared_dir/.musaic.secret"
done
migrate_directory "$remote_dir/downloads" "$shared_dir/downloads"
migrate_directory "$remote_dir/current/server/downloads" "$shared_dir/downloads"
migrate_directory "$remote_dir/covers" "$shared_dir/covers"
migrate_directory "$remote_dir/current/server/covers" "$shared_dir/covers"

backup_dir="$backup_root/predeploy-$release_id"
mkdir -p "$backup_dir"
backup_item "$shared_dir/musaic.db"
backup_item "$shared_dir/musaic.db-wal"
backup_item "$shared_dir/musaic.db-shm"
backup_item "$shared_dir/.env"
backup_item "$shared_dir/.musaic.secret"
backup_item "$shared_dir/downloads"
backup_item "$shared_dir/covers"
rotate_backups

(
  cd "$release_dir/server"
  /root/.bun/bin/bun install --frozen-lockfile
)
prepare_sidecar

if [[ -f "$shared_dir/.env" ]]; then
  ln -s "$shared_dir/.env" "$release_dir/server/.env"
fi
if [[ -e "$shared_dir/.musaic.secret" ]]; then
  ln -s "$shared_dir/.musaic.secret" "$release_dir/server/.musaic.secret"
fi
ln -s "$shared_dir/musaic.db" "$release_dir/server/musaic.db"
ln -s "$shared_dir/downloads" "$release_dir/server/downloads"
ln -s "$shared_dir/covers" "$release_dir/server/covers"

switch_release "$release_dir"
systemctl restart "$sidecar_service_name" 2>/dev/null || true
systemctl daemon-reload
systemctl start "$service_name"
server_stopped=0

if ! health_gate; then
  echo "Health gate failed; rolling back to the previous release." >&2
  journalctl -u "$service_name" -n 30 --no-pager >&2 || true
  restore_previous_release
  exit 1
fi

prune_releases
trap - EXIT
printf "Deploy complete: %s\n" "$release_dir"
'
    exit 0
fi

if [[ "$action" == "rollback" ]]; then
  "${ssh_command[@]}" "$remote_host" 'bash -s' <<'REMOTE_ROLLBACK'
set -Eeuo pipefail

remote_dir=/opt/musaic-server
releases_dir="$remote_dir/releases"
current_link="$remote_dir/current"
shared_dir="$remote_dir/shared"
service_name=musaic-server.service
legacy_service_name=musaic.service

if ! systemctl cat "$service_name" >/dev/null 2>&1 && systemctl cat "$legacy_service_name" >/dev/null 2>&1; then
  service_name="$legacy_service_name"
fi

if [[ ! -L "$current_link" ]]; then
  echo "No current release symlink found at $current_link." >&2
  exit 1
fi

current_target="$(readlink -f "$current_link")"
release_candidates=()
for candidate in "$releases_dir"/*; do
  [[ -d "$candidate" ]] || continue
  [[ "$(readlink -f "$candidate")" == "$current_target" ]] && continue
  release_candidates+=("$candidate")
done

if ((${#release_candidates[@]} == 0)); then
  echo "No previous release is available for rollback." >&2
  exit 1
fi

mapfile -t ordered_releases < <(printf "%s\n" "${release_candidates[@]}" | sort -r)
target="${ordered_releases[0]}"
echo "Rolling back $current_target -> $target"

switch_release() {
  local release="$1"
  rm -f "$current_link.next"
  ln -s "$release" "$current_link.next"
  mv -Tf "$current_link.next" "$current_link"
}

health_gate() {
  local health port cert key url
  port="$(sed -n "/^PORT=/s/^PORT=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
  cert="$(sed -n "/^TLS_CERT=/s/^TLS_CERT=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
  key="$(sed -n "/^TLS_KEY=/s/^TLS_KEY=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
  [[ "$port" =~ ^[0-9]+$ ]] || port=3001
  if [[ -n "$cert" && -n "$key" ]]; then url="https://127.0.0.1:${port}/health"; else url="http://127.0.0.1:${port}/health"; fi
  for attempt in {1..10}; do
    if [[ "$url" == https://* ]]; then
      health="$(curl --insecure --fail --silent --show-error --max-time 2 "$url" 2>/dev/null || true)"
    else
      health="$(curl --fail --silent --show-error --max-time 2 "$url" 2>/dev/null || true)"
    fi
    if [[ "$health" == *'"ok":true'* ]]; then
      printf 'Health gate passed: %s\n' "$health"
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_failed() {
  local status=$?
  if ((status != 0)); then
    switch_release "$current_target" || true
    systemctl restart "$service_name" || true
  fi
  exit "$status"
}
trap rollback_failed EXIT

systemctl stop "$service_name"
switch_release "$target"
systemctl daemon-reload
systemctl start "$service_name"

if ! health_gate; then
  echo "Rollback target failed the health gate; restoring the current release." >&2
  switch_release "$current_target"
  systemctl restart "$service_name" || true
  trap - EXIT
  exit 1
fi

trap - EXIT
echo "Rollback complete: $target"
REMOTE_ROLLBACK
  exit 0
fi

if [[ ! "$backup_path" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Restore path must be an absolute path without shell metacharacters." >&2
  exit 2
fi
printf -v quoted_backup_path '%q' "$backup_path"

"${ssh_command[@]}" "$remote_host" "bash -s -- $quoted_backup_path" <<'REMOTE_RESTORE'
set -Eeuo pipefail

backup_path="$1"
remote_dir=/opt/musaic-server
shared_dir="$remote_dir/shared"
service_name=musaic-server.service
legacy_service_name=musaic.service

if ! systemctl cat "$service_name" >/dev/null 2>&1 && systemctl cat "$legacy_service_name" >/dev/null 2>&1; then
  service_name="$legacy_service_name"
fi
if [[ ! -d "$backup_path" ]]; then
  echo "Backup directory not found: $backup_path" >&2
  exit 1
fi

restore_item() {
  local name="$1"
  if [[ -e "$backup_path/$name" || -L "$backup_path/$name" ]]; then
    rm -rf -- "$shared_dir/$name"
    cp -a "$backup_path/$name" "$shared_dir/"
  fi
}

systemctl stop "$service_name"
mkdir -p "$shared_dir"
for suffix in "-wal" "-shm"; do
  [[ -e "$backup_path/musaic.db$suffix" ]] || rm -f "$shared_dir/musaic.db$suffix"
done
restore_item musaic.db
restore_item musaic.db-wal
restore_item musaic.db-shm
restore_item .env
restore_item .musaic.secret
restore_item downloads
restore_item covers
systemctl start "$service_name"

port="$(sed -n "/^PORT=/s/^PORT=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
cert="$(sed -n "/^TLS_CERT=/s/^TLS_CERT=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
key="$(sed -n "/^TLS_KEY=/s/^TLS_KEY=//p" "$shared_dir/.env" 2>/dev/null | sed -n '1p' || true)"
[[ "$port" =~ ^[0-9]+$ ]] || port=3001
if [[ -n "$cert" && -n "$key" ]]; then health_url="https://127.0.0.1:${port}/health"; else health_url="http://127.0.0.1:${port}/health"; fi
for attempt in {1..10}; do
  if [[ "$health_url" == https://* ]]; then
    health="$(curl --insecure --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null || true)"
  else
    health="$(curl --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null || true)"
  fi
  if [[ "$health" == *'"ok":true'* ]]; then
    printf 'Restore complete: %s\n' "$health"
    exit 0
  fi
  sleep 2
done

echo "Restored files but the health endpoint did not respond." >&2
journalctl -u "$service_name" -n 30 --no-pager >&2 || true
exit 1
REMOTE_RESTORE
