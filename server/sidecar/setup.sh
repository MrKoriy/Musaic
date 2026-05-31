#!/usr/bin/env bash
# Set up the Musaic media sidecar (Yandex Music + YouTube Music + yt-dlp).
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

echo "[sidecar] creating venv (.venv)…"
"$PYTHON" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
echo "[sidecar] installing deps…"
.venv/bin/pip install --quiet -r requirements.txt

echo "[sidecar] done. Versions:"
.venv/bin/python - <<'PY'
import yandex_music, ytmusicapi, yt_dlp
print("  yandex-music", yandex_music.__version__)
print("  ytmusicapi  ", getattr(ytmusicapi, "__version__", "?"))
print("  yt-dlp      ", yt_dlp.version.__version__)
PY
echo "[sidecar] start manually with: .venv/bin/python app.py"
echo "[sidecar] (the Bun server also auto-spawns it on startup)"
