#!/bin/bash
set -e

monika_log() {
  if [ "${MONIKA_LOG_TO_STDERR:-}" = "1" ] || [ "${AGENT_RUNNER_MODE:-}" = "1" ]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

# ── Mode detection ───────────────────────────────────────
# Host mode: /home/monika/.pi/agent exists (bind-mounted from host)
# Standalone mode: no host mounts, use bundled /app/.pi

if [ -d "/home/monika/.pi/agent" ]; then
  export PI_CODING_AGENT_DIR="/home/monika/.pi/agent"
  MEMSTORE_DATA_DIR="${MEMSTORE_DATA_DIR:-/home/monika/.pi/memstore}"
  MEMSTORE_SOCKET="${MEMSTORE_SOCKET:-/home/monika/.pi/memstore/memstore.sock}"
  export MONIKA_HOST_MODE=1
  export HOME=/home/monika
  # SSH config for host-mode auto-relocate: root's user config doesn't exist by
  # default (container runs as root, but SSH keys live in /home/monika/.ssh).
  # Create /root/.ssh/config pointing to the identity file if it doesn't exist.
  mkdir -p /root/.ssh
  if [ ! -f /root/.ssh/config ]; then
    echo "Host *\n    IdentityFile /persist/keys/ssh-local" > /root/.ssh/config
    chmod 600 /root/.ssh/config
  fi
  monika_log "[monika] Host mode: .pi mounted, SSH host shell enabled"
else
  export PI_CODING_AGENT_DIR="/app/.pi/agent"
  MEMSTORE_DATA_DIR="${MEMSTORE_DATA_DIR:-/data/memstore}"
  MEMSTORE_SOCKET="${MEMSTORE_SOCKET:-/tmp/memstore.sock}"
  unset MONIKA_HOST_MODE
  export HOME=/app
  monika_log "[monika] Standalone mode: bundled .pi, container shell"
  mkdir -p "$MEMSTORE_DATA_DIR" /data/sessions /app/.config /app/.ssh /app/.gnupg
fi

export MEMSTORE_SOCKET

# ── AgentLogs runtime state ──────────────────────────────
# AgentLogs writes auth/config to ~/.config/agentlogs. Keep that state separate
# from Monika's HOME so host-mode read-only .config mounts do not block login.
export AGENTLOGS_HOME="${AGENTLOGS_HOME:-/agentlogs-home}"
mkdir -p "$AGENTLOGS_HOME/.config/agentlogs"

# ── Runtime secrets (container-only persistent mode) ──────
# compose.local.yaml mounts host-owned private state at /runtime/secrets.
# Keep the image canonical for code/extensions, and link only host-owned auth/model
# files into Pi's agent dir when they exist.
link_secret_file() {
  local src="$1"
  local dest="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    ln -sf "$src" "$dest"
  fi
}

link_secret_file "/runtime/secrets/pi-agent/auth.json" "$PI_CODING_AGENT_DIR/auth.json"
link_secret_file "/runtime/secrets/pi-agent/models.json" "$PI_CODING_AGENT_DIR/models.json"
link_secret_file "/runtime/secrets/pi-agent/keybindings.json" "$PI_CODING_AGENT_DIR/keybindings.json"
link_secret_file "/runtime/secrets/auth.json" "$PI_CODING_AGENT_DIR/auth.json"
link_secret_file "/runtime/secrets/models.json" "$PI_CODING_AGENT_DIR/models.json"

# GPG keyrings on macOS/Parallels bind mounts cannot reliably host gpg-agent's
# Unix sockets. Copy the mounted keyring into a container-local GNUPGHOME.
if [ -d "/runtime/secrets/gnupg" ]; then
  export GNUPGHOME="${GNUPGHOME:-/tmp/gnupg}"
  rm -rf "$GNUPGHOME"
  mkdir -p "$GNUPGHOME"
  cp -a /runtime/secrets/gnupg/. "$GNUPGHOME"/ 2>/dev/null || true
  chmod 700 "$GNUPGHOME" 2>/dev/null || true
  find "$GNUPGHOME" -type f -exec chmod 600 {} + 2>/dev/null || true
fi

# ── Git config (host /etc/gitconfig isn't available in container) ──
# Identity is runtime-owned, not baked into the image. Configure it with env vars
# or an env-style file containing GIT_USER_NAME/GIT_USER_EMAIL (or
# GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL) in one of:
#   /runtime/secrets/git-identity.env
#   ~/.pi/git-identity.env
#   ~/.config/monika/git-identity.env
load_git_identity_file() {
  local file="$1"
  if [ -f "$file" ]; then
    set +e
    # shellcheck source=/dev/null
    source "$file"
    local source_status=$?
    set -e

    if [ "$source_status" -ne 0 ]; then
      monika_log "[monika] WARNING: sourcing $file returned $source_status; continuing"
    fi
  fi
}

load_git_identity_file "/runtime/secrets/git-identity.env"
load_git_identity_file "$(dirname "$PI_CODING_AGENT_DIR")/git-identity.env"
load_git_identity_file "$HOME/.pi/git-identity.env"
load_git_identity_file "$HOME/.config/monika/git-identity.env"

GIT_USER_NAME="${GIT_USER_NAME:-${GIT_AUTHOR_NAME:-}}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-${GIT_AUTHOR_EMAIL:-}}"

if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME" 2>/dev/null || true
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL" 2>/dev/null || true
fi
git config --global safe.directory "*" 2>/dev/null || true

# ── Source secrets if available ──────────────────────────
for secrets_file in "/home/monika/.config/secrets.env" "/app/.config/secrets.env" "/runtime/secrets/secrets.env"; do
  if [ -f "$secrets_file" ]; then
    # shellcheck source=/dev/null
    set +e
    set -a
    source "$secrets_file"
    source_status=$?
    set +a
    set -e

    if [ "$source_status" -ne 0 ]; then
      monika_log "[monika] WARNING: sourcing $secrets_file returned $source_status; continuing"
    fi
  fi
done

# ── Pool models config ───────────────────────────────────
# The pool provides a models.json with provider endpoints and auth.
# In host mode this is already at ~/.pi/agent/models.json (bind-mounted).
# For standalone mode, download it if not present and POOL_CONFIG_URL is set.
MODELS_JSON="$PI_CODING_AGENT_DIR/models.json"
if [ ! -f "$MODELS_JSON" ] && [ -n "$POOL_CONFIG_URL" ]; then
  monika_log "[monika] Downloading pool models config..."
  curl -sL "$POOL_CONFIG_URL" -o "$MODELS_JSON"
  chmod 600 "$MODELS_JSON"
fi

# ── Start memstore ───────────────────────────────────────
monika_log "[monika] Starting memstore (socket=$MEMSTORE_SOCKET)..."
memstore --socket="$MEMSTORE_SOCKET" --data-dir="$MEMSTORE_DATA_DIR" &
MEMSTORE_PID=$!

# Wait for socket
for i in $(seq 1 60); do
  [ -S "$MEMSTORE_SOCKET" ] && break
  sleep 0.1
done

if [ ! -S "$MEMSTORE_SOCKET" ]; then
  monika_log "[monika] ERROR: memstore socket not ready after 6s"
  exit 1
fi
monika_log "[monika] memstore ready (PID $MEMSTORE_PID)"

# ── Monika agent daemon ──────────────────────────────────
# Runner mode is a short-lived foreground job; keep agentd disabled unless a
# caller explicitly opts in.
if [ "${AGENT_RUNNER_MODE:-}" = "1" ]; then
  MONIKA_AGENTD_ENABLED="${MONIKA_AGENTD_ENABLED:-0}"
fi

AGENTD_PID=""
if [ "${MONIKA_AGENTD_ENABLED:-1}" != "0" ]; then
  monika_log "[monika] Starting agentd (port=${MONIKA_AGENTD_PORT:-7724})..."
  node /opt/agentd/src/server.mjs &
  AGENTD_PID=$!
fi

# ── Signal handling ──────────────────────────────────────
cleanup() {
  monika_log "[monika] Shutting down..."
  if [ -n "$AGENTD_PID" ]; then
    kill "$AGENTD_PID" 2>/dev/null || true
    wait "$AGENTD_PID" 2>/dev/null || true
  fi
  kill "$MEMSTORE_PID" 2>/dev/null
  wait "$MEMSTORE_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Run command or keep alive ────────────────────────────
if [ $# -gt 0 ]; then
  exec "$@"
else
  monika_log "[monika] Running. Use 'docker exec -it monika pi' for interactive session."
  wait "$MEMSTORE_PID"
fi
