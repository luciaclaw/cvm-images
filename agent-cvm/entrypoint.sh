#!/bin/bash
set -e

echo "[lucia] Starting inference bridge..."
cd /app/inference-bridge
PYTHONUNBUFFERED=1 /app/venv/bin/python -m uvicorn src.main:app --host 0.0.0.0 --port 8000 2>&1 &
BRIDGE_PID=$!

# Give the bridge a moment to start, then verify it's alive
sleep 2
if ! kill -0 $BRIDGE_PID 2>/dev/null; then
  echo "[lucia] ERROR: Inference bridge failed to start!"
  wait $BRIDGE_PID 2>/dev/null || true
fi

echo "[lucia] Starting orchestrator..."
cd /app/orchestrator
node dist/index.js
