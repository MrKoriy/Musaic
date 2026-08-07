#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
server_dir="$script_dir/server"
remote_host="${MUSAIC_DEPLOY_HOST:-root@45.146.167.109}"

if [[ ! -d "$server_dir/src" || ! -f "$server_dir/package.json" ]]; then
  echo "Musaic server sources not found at: $server_dir" >&2
  exit 1
fi

echo "Deploying $server_dir to $remote_host:/opt/musaic-server"
echo "Persistent database, environment, secrets, downloads, and virtual environments are excluded."

if [[ -n "${SSHPASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  ssh_command=(sshpass -e ssh)
else
  ssh_command=(ssh)
fi

COPYFILE_DISABLE=1 tar -C "$server_dir" \
  --exclude='./.env' \
  --exclude='./.musaic.secret' \
  --exclude='./musaic.db*' \
  --exclude='./downloads' \
  --exclude='./node_modules' \
  --exclude='./sidecar/.venv' \
  --exclude='./.lyrics-venv' \
  --exclude='./.backups' \
  --exclude='./dist' \
  --exclude='./.DS_Store' \
  --exclude='./._*' \
  -czf - . | "${ssh_command[@]}" "$remote_host" '
set -Eeuo pipefail

remote_dir=/opt/musaic-server
mkdir -p "$remote_dir" /opt/musaic-backups
tar -xzf - -C "$remote_dir"
cd "$remote_dir"

/root/.bun/bin/bun install --frozen-lockfile
/root/.bun/bin/bun run typecheck
sidecar/.venv/bin/python -m pip install -q -r sidecar/requirements.txt

backup_dir="/opt/musaic-backups/predeploy-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"

server_stopped=0
restart_on_error() {
  if [[ "$server_stopped" == 1 ]]; then
    systemctl start musaic.service || true
  fi
}
trap restart_on_error EXIT

systemctl stop musaic.service
server_stopped=1
cp -a musaic.db "$backup_dir/"
[[ ! -f musaic.db-wal ]] || cp -a musaic.db-wal "$backup_dir/"
[[ ! -f musaic.db-shm ]] || cp -a musaic.db-shm "$backup_dir/"

systemctl restart musaic-sidecar.service
systemctl start musaic.service
server_stopped=0
trap - EXIT

systemctl is-active --quiet musaic-sidecar.service
systemctl is-active --quiet musaic.service

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if health="$(curl -fsS http://127.0.0.1:3001/health)"; then
    echo "Deploy complete: $health"
    exit 0
  fi
  sleep 1
done

echo "Services started, but the health endpoint did not respond." >&2
journalctl -u musaic.service -n 30 --no-pager >&2
exit 1
'
