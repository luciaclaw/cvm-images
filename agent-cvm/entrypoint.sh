#!/bin/bash
set -e

echo "[lucia] Starting inference bridge..."
cd /app/inference-bridge
/app/venv/bin/python -m uvicorn src.main:app --host 0.0.0.0 --port 8000 &

echo "[lucia] Starting orchestrator..."
cd /app/orchestrator
node dist/index.js
