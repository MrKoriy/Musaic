#!/usr/bin/env bash
# setup-lyrics.sh — Install Python dependencies for Musaic AI lyrics pipeline
#
# Required:
#   - Python 3.10+ with pip
#   - ~4GB disk space (Demucs + Parakeet models)
#   - ~8GB RAM recommended (16GB for faster processing)
#
# Usage:
#   chmod +x server/scripts/setup-lyrics.sh
#   ./server/scripts/setup-lyrics.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/../.lyrics-venv"

log() { echo "[setup-lyrics] $*"; }
err() { echo "[setup-lyrics] ERROR: $*" >&2; exit 1; }

# ─── Check Python ─────────────────────────────────────────────────────────────

log "Checking Python installation..."

PYTHON=""
for cmd in python3.12 python3.11 python3.10 python3; do
  if command -v "$cmd" &>/dev/null; then
    version=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    major=${version%%.*}
    minor=${version##*.}
    if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  log "Python 3.10+ not found. Attempting to install..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      brew install python@3.12
      PYTHON="python3.12"
    else
      err "Homebrew not found. Install Python 3.10+ manually from https://python.org"
    fi
  elif command -v apt-get &>/dev/null; then
    sudo apt-get update && sudo apt-get install -y python3.11 python3.11-venv python3-pip
    PYTHON="python3.11"
  else
    err "Cannot auto-install Python. Please install Python 3.10+ manually."
  fi
fi

log "Using Python: $PYTHON ($($PYTHON --version))"

# ─── Create virtualenv ─────────────────────────────────────────────────────────

log "Creating virtualenv at $VENV_DIR..."
"$PYTHON" -m venv "$VENV_DIR"

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

log "Upgrading pip..."
"$VENV_PIP" install --upgrade pip setuptools wheel

# ─── Install PyTorch ─────────────────────────────────────────────────────────

log "Installing PyTorch (CPU/MPS)..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: install standard PyTorch (supports Metal/MPS on Apple Silicon)
  "$VENV_PIP" install torch torchaudio
else
  # Linux CPU-only (smaller download, no CUDA needed for local use)
  "$VENV_PIP" install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi

# ─── Install Demucs ───────────────────────────────────────────────────────────

log "Installing Demucs (vocal separation)..."
"$VENV_PIP" install demucs

# ─── Install Parakeet TDT (NVIDIA NeMo ASR) ──────────────────────────────────

log "Installing NeMo toolkit (Parakeet ASR)..."
"$VENV_PIP" install nemo_toolkit[asr]

# ─── Install helper dependencies ─────────────────────────────────────────────

log "Installing helper packages..."
"$VENV_PIP" install requests soundfile librosa

# ─── Write .env hint ──────────────────────────────────────────────────────────

ENV_FILE="$SCRIPT_DIR/../../.env"
if [ -f "$ENV_FILE" ] && ! grep -q "PYTHON_PATH" "$ENV_FILE"; then
  echo "" >> "$ENV_FILE"
  echo "# Python virtualenv for AI lyrics pipeline" >> "$ENV_FILE"
  echo "PYTHON_PATH=$VENV_DIR/bin/python" >> "$ENV_FILE"
  log "Added PYTHON_PATH to .env"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

log ""
log "Setup complete!"
log ""
log "The AI lyrics pipeline is now ready. It will use:"
log "  - Demucs htdemucs_ft model for vocal separation"
log "  - Parakeet TDT 1.1B (NVIDIA NeMo) for transcription"
log "  - LLM cleanup via OpenRouter (set OPENROUTER_API_KEY in server/.env)"
log ""
log "First run will download model weights (~4GB). This is normal."
log ""
log "To enable: add to server/.env:"
log "  PYTHON_PATH=$VENV_DIR/bin/python"
