#!/bin/sh
# Set up the OCR venv (Apple Vision via PyObjC) for computer-use-intel.
# Idempotent: skips work if the venv already imports Vision + Quartz.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python3"

if [ -x "$PY" ] && "$PY" -c "import Vision, Quartz" >/dev/null 2>&1; then
  echo "[setup-ocr] venv already has Vision + Quartz — nothing to do."
  exit 0
fi

# Use the system python3 (universal x86_64+arm64) so the venv runs natively on Intel.
SYS_PY="/usr/bin/python3"
[ -x "$SYS_PY" ] || SYS_PY="$(command -v python3)"

echo "[setup-ocr] creating venv at $VENV using $SYS_PY"
"$SYS_PY" -m venv "$VENV"
"$PY" -m pip install -q --upgrade pip
echo "[setup-ocr] installing pyobjc-framework-Vision + pyobjc-framework-Quartz"
"$PY" -m pip install -q pyobjc-framework-Vision pyobjc-framework-Quartz
"$PY" -c "import Vision, Quartz; print('[setup-ocr] OK: Vision + Quartz import')"
