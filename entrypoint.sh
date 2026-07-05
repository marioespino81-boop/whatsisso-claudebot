#!/bin/bash
# Runs the WhatsApp bridge (Go/whatsmeow) and the Claude auto-responder
# (Node) side by side in the same container, sharing localhost so the
# bridge's Host-header allow-list keeps working.
set -e

mkdir -p /app/bridge/store

echo "[entrypoint] starting whatsapp-bridge..."
cd /app/bridge
./whatsapp-bridge &
BRIDGE_PID=$!

echo "[entrypoint] starting auto-responder..."
cd /app/autoresponder
node index.js &
APP_PID=$!

# If either process dies, bring the whole container down so the platform
# (EasyPanel/Docker) restarts it cleanly instead of limping along half-alive.
terminate() {
  echo "[entrypoint] shutting down..."
  kill -TERM "$BRIDGE_PID" "$APP_PID" 2>/dev/null || true
  wait
}
trap terminate SIGTERM SIGINT

wait -n "$BRIDGE_PID" "$APP_PID"
EXIT_CODE=$?
echo "[entrypoint] a process exited (code $EXIT_CODE), stopping container"
terminate
exit "$EXIT_CODE"
