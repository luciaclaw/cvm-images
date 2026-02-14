#!/bin/bash
set -e

# ── Ensure a stable VAULT_MASTER_KEY across restarts ──
# If not set externally, generate once and persist to the data volume.
# This key encrypts all credentials and memories in SQLite.
VAULT_KEY_FILE="${DATA_DIR:-/data}/.vault_master_key"

if [ -z "$VAULT_MASTER_KEY" ]; then
  if [ -f "$VAULT_KEY_FILE" ]; then
    VAULT_MASTER_KEY=$(cat "$VAULT_KEY_FILE")
    echo "[lucia] Loaded VAULT_MASTER_KEY from $VAULT_KEY_FILE"
  else
    VAULT_MASTER_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
    echo "$VAULT_MASTER_KEY" > "$VAULT_KEY_FILE"
    chmod 600 "$VAULT_KEY_FILE"
    echo "[lucia] Generated and persisted VAULT_MASTER_KEY to $VAULT_KEY_FILE"
  fi
  export VAULT_MASTER_KEY
fi

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
