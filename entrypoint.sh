#!/bin/bash
set -e

monika_log() {
  if [ "${MONIKA_LOG_TO_STDERR:-}" = "1" ] || [ "${AGENT_RUNNER_MODE:-}" = "1" ]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

# ── Runtime layout ───────────────────────────────────────
# Monika runs as a standalone container. The image owns Pi/extensions/defaults;
# compose mounts selected persistent state under /app/.pi and /data.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/app/.pi/agent}"
# Agentd's delivery ledger, retained-result custody, and operator audits need a
# dedicated persistent root before the retention inventory runs at startup.
operator_root_input="${PI_SUBAGENT_OPERATOR_ROOT:-/data/pi-subagent-operator-state}"
if [[ "$operator_root_input" != /* ]]; then
  monika_log "[monika] ERROR: PI_SUBAGENT_OPERATOR_ROOT must be an absolute dedicated path"
  exit 1
fi
export PI_SUBAGENT_OPERATOR_ROOT="$(realpath -m -- "$operator_root_input")"
if [[ "$PI_SUBAGENT_OPERATOR_ROOT" == "/" || "$(dirname -- "$PI_SUBAGENT_OPERATOR_ROOT")" == "/" ]]; then
  monika_log "[monika] ERROR: PI_SUBAGENT_OPERATOR_ROOT must not be a filesystem or top-level mount root"
  exit 1
fi
ssh_lock_extension="$PI_CODING_AGENT_DIR/extensions/ssh.ts"
ssh_lock_helper="$PI_CODING_AGENT_DIR/extensions/ssh-lock.mjs"
if [[ -f "$ssh_lock_extension" && -f "$ssh_lock_helper" ]]; then
  ssh_lock_extension_sha="$(sha256sum "$ssh_lock_extension" | awk '{print $1}')"
  ssh_lock_helper_sha="$(sha256sum "$ssh_lock_helper" | awk '{print $1}')"
  actual_ssh_lock_digest="$(printf '%s\n%s\n' "$ssh_lock_extension_sha" "$ssh_lock_helper_sha" | sha256sum | awk '{print $1}')"
  if [[ -n "${PI_SUBAGENT_SSH_LOCK_CODE_DIGEST:-}" && "$PI_SUBAGENT_SSH_LOCK_CODE_DIGEST" != "$actual_ssh_lock_digest" ]]; then
    die "bundled SSH lock code does not match the image attestation"
  fi
  export PI_SUBAGENT_SSH_LOCK_CODE_DIGEST="$actual_ssh_lock_digest"
fi
MEMSTORE_DATA_DIR="${MEMSTORE_DATA_DIR:-/data/memstore}"
MEMSTORE_SOCKET="${MEMSTORE_SOCKET:-/tmp/memstore.sock}"
export MEMSTORE_SOCKET
export HOME="${MONIKA_HOME:-/app}"
monika_log "[monika] Standalone mode: container-owned Pi runtime"
mkdir -p "$MEMSTORE_DATA_DIR" /data/sessions /app/.config /app/.ssh /app/.gnupg "$PI_CODING_AGENT_DIR"
install -d -m 0700 -- "$PI_SUBAGENT_OPERATOR_ROOT"

# One identity per container lifetime lets agentd distinguish a surviving runner
# after an agentd-only restart from a process destroyed by container replacement.
export MONIKA_RUNTIME_INSTANCE_FILE="${MONIKA_RUNTIME_INSTANCE_FILE:-/run/monika-runtime-instance.json}"
node - "$MONIKA_RUNTIME_INSTANCE_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = process.argv[2];
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, id: crypto.randomUUID(), createdAt: Date.now() })}\n`, { mode: 0o644 });
fs.renameSync(tmp, file);
NODE

# ── AgentLogs runtime state ──────────────────────────────
# AgentLogs writes auth/config to ~/.config/agentlogs. Keep that state separate
# from Monika's HOME so read-only runtime config mounts do not block login.
export AGENTLOGS_HOME="${AGENTLOGS_HOME:-/agentlogs-home}"
mkdir -p "$AGENTLOGS_HOME/.config/agentlogs"

# ── Runtime secrets (container-only persistent mode) ──────
# compose.yaml mounts host-owned private state at
# /runtime/secrets. Keep the image canonical for code/extensions, and link only
# host-owned model/keybinding files into Pi's agent dir when they exist.
link_secret_file() {
  local src="$1"
  local dest="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    ln -sf "$src" "$dest"
  fi
}

# Pi OAuth credentials are mutable runtime state: Pi refreshes access tokens and
# persists the new expiry back to auth.json. /runtime/secrets is intentionally
# read-only, so seed a writable persistent auth file from secrets on first start
# and point Pi at that copy.
PI_AUTH_STATE_DIR="${PI_AUTH_STATE_DIR:-/data/pi-agent-auth}"
PI_AUTH_STATE_FILE="${PI_AUTH_STATE_FILE:-$PI_AUTH_STATE_DIR/auth.json}"
mkdir -p "$PI_AUTH_STATE_DIR"
if [ ! -f "$PI_AUTH_STATE_FILE" ]; then
  if [ -f "/runtime/secrets/pi-agent/auth.json" ]; then
    cp "/runtime/secrets/pi-agent/auth.json" "$PI_AUTH_STATE_FILE"
  elif [ -f "/runtime/secrets/auth.json" ]; then
    cp "/runtime/secrets/auth.json" "$PI_AUTH_STATE_FILE"
  else
    printf '{}\n' > "$PI_AUTH_STATE_FILE"
  fi
  chmod 600 "$PI_AUTH_STATE_FILE" 2>/dev/null || true
fi
mkdir -p "$PI_CODING_AGENT_DIR"
ln -sf "$PI_AUTH_STATE_FILE" "$PI_CODING_AGENT_DIR/auth.json"

# Pi project-trust decisions are mutable runtime state too. Keep them under the
# existing persistent /data mount so direct interactive sessions do not need to
# approve the same administrator-chosen workspace after every image recreation.
PI_TRUST_STATE_DIR="${PI_TRUST_STATE_DIR:-/data/pi-agent-trust}"
PI_TRUST_STATE_FILE="${PI_TRUST_STATE_FILE:-$PI_TRUST_STATE_DIR/trust.json}"
mkdir -p "$PI_TRUST_STATE_DIR"
if [ ! -f "$PI_TRUST_STATE_FILE" ]; then
  printf '{}\n' > "$PI_TRUST_STATE_FILE"
  chmod 600 "$PI_TRUST_STATE_FILE" 2>/dev/null || true
fi
ln -sf "$PI_TRUST_STATE_FILE" "$PI_CODING_AGENT_DIR/trust.json"

# Pi's refreshed built-in provider catalogs are cache state, not deployment
# configuration. Persist the cache across image recreation so agentd and direct
# Pi sessions can revalidate it instead of starting cold after every deploy.
PI_MODELS_STATE_DIR="${PI_MODELS_STATE_DIR:-/data/pi-agent-models}"
PI_MODELS_STORE_FILE="${PI_MODELS_STORE_FILE:-$PI_MODELS_STATE_DIR/models-store.json}"
mkdir -p "$PI_MODELS_STATE_DIR"
if [ ! -f "$PI_MODELS_STORE_FILE" ]; then
  if [ -f "$PI_CODING_AGENT_DIR/models-store.json" ] && [ ! -L "$PI_CODING_AGENT_DIR/models-store.json" ]; then
    cp "$PI_CODING_AGENT_DIR/models-store.json" "$PI_MODELS_STORE_FILE"
  else
    printf '{}\n' > "$PI_MODELS_STORE_FILE"
  fi
  chmod 600 "$PI_MODELS_STORE_FILE" 2>/dev/null || true
fi
ln -sf "$PI_MODELS_STORE_FILE" "$PI_CODING_AGENT_DIR/models-store.json"

link_secret_file "/runtime/secrets/pi-agent/models.json" "$PI_CODING_AGENT_DIR/models.json"
link_secret_file "/runtime/secrets/pi-agent/keybindings.json" "$PI_CODING_AGENT_DIR/keybindings.json"
link_secret_file "/runtime/secrets/keybindings.json" "$PI_CODING_AGENT_DIR/keybindings.json"
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

# ── Git config / signing state ────────────────────────
# Runtime deployments can provide a full git config at /runtime/secrets/gitconfig,
# including commit signing settings. Copy it to writable container-local storage so
# later git config --global calls can safely apply env overrides without mutating
# the read-only runtime secrets mount.
if [ -f "/runtime/secrets/gitconfig" ]; then
  export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-$HOME/.gitconfig}"
  cp "/runtime/secrets/gitconfig" "$GIT_CONFIG_GLOBAL" 2>/dev/null || true
  chmod 600 "$GIT_CONFIG_GLOBAL" 2>/dev/null || true
fi

# ── Git identity overrides ──────────────────────────────
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
for secrets_file in "/app/.config/secrets.env" "/runtime/secrets/secrets.env"; do
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
# Download model config if it is not provided by runtime secrets and POOL_CONFIG_URL is set.
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
