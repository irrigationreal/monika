#!/bin/bash
set -e

# ── Mode detection ───────────────────────────────────────
# Production: /home/monika/.pi/agent exists (bind-mounted from host)
# Test/standalone: no host mounts, use bundled /app/.pi

if [ -d "/home/monika/.pi/agent" ]; then
  export PI_CODING_AGENT_DIR="/home/monika/.pi/agent"
  MEMSTORE_DATA_DIR="/home/monika/.pi/memstore"
  MEMSTORE_SOCKET="/home/monika/.pi/memstore/memstore.sock"
  export MONIKA_HOST_MODE=1
  export HOME=/home/monika
  echo "[monika] Production mode: host .pi mounted, SSH host shell enabled"
else
  export PI_CODING_AGENT_DIR="/app/.pi/agent"
  MEMSTORE_DATA_DIR="/data/memstore"
  MEMSTORE_SOCKET="/data/memstore.sock"
  unset MONIKA_HOST_MODE
  export HOME=/app
  echo "[monika] Test/standalone mode: bundled .pi, container shell"
  mkdir -p "$MEMSTORE_DATA_DIR" /data/sessions
fi

export MEMSTORE_SOCKET

# ── Git config (host /etc/gitconfig isn't available in container) ──
git config --global user.name "Monika" 2>/dev/null
git config --global user.email "monika@neosynth.net" 2>/dev/null
git config --global safe.directory "*" 2>/dev/null

# ── Source secrets if available ──────────────────────────
if [ -f "/home/monika/.config/secrets.env" ]; then
  # shellcheck source=/dev/null
  source /home/monika/.config/secrets.env
fi

# ── Pool models config ───────────────────────────────────
# The pool provides a models.json with provider endpoints and auth.
# In production this is already at ~/.pi/agent/models.json (bind-mounted).
# For test/standalone, download it if not present and POOL_CONFIG_URL is set.
MODELS_JSON="$PI_CODING_AGENT_DIR/models.json"
if [ ! -f "$MODELS_JSON" ] && [ -n "$POOL_CONFIG_URL" ]; then
  echo "[monika] Downloading pool models config..."
  curl -sL "$POOL_CONFIG_URL" -o "$MODELS_JSON"
  chmod 600 "$MODELS_JSON"
fi

# ── Start memstore ───────────────────────────────────────
echo "[monika] Starting memstore (socket=$MEMSTORE_SOCKET)..."
memstore --socket="$MEMSTORE_SOCKET" --data-dir="$MEMSTORE_DATA_DIR" &
MEMSTORE_PID=$!

# Wait for socket
for i in $(seq 1 60); do
  [ -S "$MEMSTORE_SOCKET" ] && break
  sleep 0.1
done

if [ ! -S "$MEMSTORE_SOCKET" ]; then
  echo "[monika] ERROR: memstore socket not ready after 6s"
  exit 1
fi
echo "[monika] memstore ready (PID $MEMSTORE_PID)"

# ── Signal handling ──────────────────────────────────────
cleanup() {
  echo "[monika] Shutting down..."
  kill "$MEMSTORE_PID" 2>/dev/null
  wait "$MEMSTORE_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Run command or keep alive ────────────────────────────
if [ $# -gt 0 ]; then
  exec "$@"
else
  echo "[monika] Running. Use 'docker exec -it monika pi' for interactive session."
  wait "$MEMSTORE_PID"
fi
