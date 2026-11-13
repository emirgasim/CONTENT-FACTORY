#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-7860}"
CPU_THREADS="${CPU_THREADS:-2}"

echo "[Content Factory] Starting MOSS-TTS-Nano ONNX CPU service..."
cd /opt/moss
micromamba run -n content-factory python app_onnx.py \
  --host 127.0.0.1 \
  --port 18083 \
  --cpu-threads "$CPU_THREADS" &
MOSS_PID=$!

cleanup() {
  kill "$MOSS_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd /app
echo "[Content Factory] Starting API and render worker on port $PORT..."
micromamba run -n content-factory uvicorn gateway:app \
  --host 0.0.0.0 --port "$PORT" --workers 1
