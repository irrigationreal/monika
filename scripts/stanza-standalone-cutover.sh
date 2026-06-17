#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${MONIKA_RUNTIME_DIR:-$ROOT/runtime}"
BACKUP_ROOT="${MONIKA_CUTOVER_BACKUP_ROOT:-$HOME/repos/monika-cutover-backups}"
STAMP="${MONIKA_CUTOVER_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
LOG_DIR="$BACKUP_DIR/logs"
OLD_PI="${MONIKA_OLD_PI:-$HOME/.pi}"
OLD_AGENTLOGS="${MONIKA_OLD_AGENTLOGS:-$HOME/.agentlogs}"
YES=0
UNSAFE=0

usage() {
  cat <<USAGE
Usage: $0 [--yes] [--unsafe] <command>

Commands:
  plan       Print the cutover plan and current paths.
  preflight  Check host tools and repository state.
  stop       Stop old host-mode containers (monika-forum, monika).
  backup     Create a cold backup under $BACKUP_ROOT/<timestamp>/.
  migrate    Populate ./runtime and rewrite copied state for standalone mode.
  start      Start compose.stanza.yaml.
  verify     Run runtime/container health checks.
  execute    Run preflight, stop, backup, migrate, start, verify.
  rollback   Stop standalone and start the old host-mode compose files.

Use execute only from a host shell, not from inside an active Pi session.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    --unsafe) UNSAFE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) break ;;
  esac
done
CMD="${1:-plan}"

log() { printf '[cutover] %s\n' "$*"; }
run() { log "+ $*"; "$@"; }
confirm() {
  if [[ "$YES" == 1 ]]; then return 0; fi
  printf '%s [type YES]: ' "$1" >&2
  read -r answer
  [[ "$answer" == YES ]]
}

container_running() {
  docker ps --format '{{.Names}}' | grep -Eq "^($1)$"
}
any_monika_running() {
  container_running monika || container_running monika-forum
}
require_tools() {
  for tool in docker tar zstd rsync node; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
  done
  docker compose version >/dev/null
}

plan() {
  cat <<PLAN
Stanza standalone cutover plan

Repository: $ROOT
Runtime:    $RUNTIME
Old Pi:     $OLD_PI
Backups:    $BACKUP_ROOT/<timestamp>
Compose:    $ROOT/compose.stanza.yaml

execute phases:
  1. preflight host tools and compose config
  2. stop old host-mode containers
  3. create cold backup of ~/.pi, ~/.agentlogs, and repo source
  4. copy state into ./runtime as real files, no symlinks
  5. rewrite copied paths for standalone mode
  6. start compose.stanza.yaml
  7. verify health and data invariants

Rollback:
  $0 rollback

PLAN
}

preflight() {
  require_tools
  cd "$ROOT"
  [[ -f compose.stanza.yaml ]] || { echo "compose.stanza.yaml missing" >&2; exit 1; }
  [[ -x scripts/stanza-standalone-migrate.mjs ]] || { echo "migration helper missing/not executable" >&2; exit 1; }
  docker compose -f compose.stanza.yaml config >/dev/null
  [[ -d "$OLD_PI/agent/sessions" ]] || { echo "old Pi sessions not found at $OLD_PI/agent/sessions" >&2; exit 1; }
  [[ -d "$OLD_PI/memstore" ]] || { echo "old memstore not found at $OLD_PI/memstore" >&2; exit 1; }
  log "preflight ok"
}

stop_old() {
  cd "$ROOT"
  log "Stopping old host-mode deployment. This terminates the active Monika session."
  if [[ "$YES" != 1 ]]; then
    confirm "Stop monika and monika-forum now?" || { echo "aborted" >&2; exit 1; }
  fi
  docker compose -f compose.yaml -f compose.forum.yaml down || true
  docker stop monika-forum monika >/dev/null 2>&1 || true
  if any_monika_running; then
    docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
    echo "monika containers are still running" >&2
    exit 1
  fi
  log "old containers stopped"
}

make_backup() {
  mkdir -p "$LOG_DIR"
  log "Writing cold backup to $BACKUP_DIR"
  [[ ! -e "$BACKUP_DIR/home-pi.tar.zst" ]] || { echo "backup already exists: $BACKUP_DIR" >&2; exit 1; }
  if any_monika_running && [[ "$UNSAFE" != 1 ]]; then
    echo "containers are running; refusing cold backup without --unsafe" >&2
    exit 1
  fi
  run tar --xattrs --acls -I zstd --exclude="*.sock" -cpf "$BACKUP_DIR/home-pi.tar.zst" -C "$HOME" .pi
  if [[ -d "$OLD_AGENTLOGS" ]]; then
    run tar --xattrs --acls -I zstd -cpf "$BACKUP_DIR/agentlogs.tar.zst" -C "$HOME" .agentlogs
  fi
  run tar --xattrs --acls -I zstd --exclude='./runtime' --exclude='./runner-runtime' --exclude='./services/forum/node_modules' -cpf "$BACKUP_DIR/monika-repo-source.tar.zst" -C "$ROOT" .
  cat > "$BACKUP_DIR/manifest.json" <<MANIFEST
{
  "timestamp": "$STAMP",
  "repository": "$ROOT",
  "runtime": "$RUNTIME",
  "oldPi": "$OLD_PI",
  "oldAgentlogs": "$OLD_AGENTLOGS"
}
MANIFEST
  (cd "$BACKUP_DIR" && find . -type f -maxdepth 2 -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
  log "backup complete"
}

copy_real() {
  local src="$1" dest="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dest")"
    rsync -aL --delete --exclude='*.sock' "$src" "$dest"
  fi
}

write_ssh_config() {
  mkdir -p "$RUNTIME/secrets/ssh"
  chmod 700 "$RUNTIME/secrets/ssh" || true
  if [[ -f /persist/keys/ssh-local ]]; then
    cp -L /persist/keys/ssh-local "$RUNTIME/secrets/ssh/ssh-local"
    chmod 600 "$RUNTIME/secrets/ssh/ssh-local" || true
  fi
  cat > "$RUNTIME/secrets/ssh/config" <<SSHCONF
Host stanza host.docker.internal
  HostName host.docker.internal
  User monika
  IdentityFile /root/.ssh/ssh-local
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
SSHCONF
  chmod 600 "$RUNTIME/secrets/ssh/config" || true
}

write_forum_env_if_missing() {
  mkdir -p "$RUNTIME/secrets"
  if [[ ! -f "$RUNTIME/secrets/forum.env" ]]; then
    if [[ -f "$OLD_PI/forum/forum.env" ]]; then
      cp -L "$OLD_PI/forum/forum.env" "$RUNTIME/secrets/forum.env"
    else
      cat > "$RUNTIME/secrets/forum.env" <<'FORUMENV'
# Stanza standalone forum runtime.
# Preserve existing secrets here if the old deployment used non-default auth.
CODEX_FORUM_AGENT_MODEL=codex/gpt-5.5
FORUMENV
    fi
    chmod 600 "$RUNTIME/secrets/forum.env" || true
  fi
}

migrate() {
  if any_monika_running && [[ "$UNSAFE" != 1 ]]; then
    echo "containers are running; refusing migration without --unsafe" >&2
    exit 1
  fi
  cd "$ROOT"
  log "Populating runtime at $RUNTIME"
  mkdir -p "$RUNTIME" "$RUNTIME/data" "$RUNTIME/persona" "$RUNTIME/pi-agent" "$RUNTIME/forum" "$RUNTIME/secrets" "$RUNTIME/import" "$RUNTIME/agentlogs-home"
  copy_real "$OLD_PI/memstore/" "$RUNTIME/data/memstore/"
  copy_real "$OLD_PI/stateful-memory/" "$RUNTIME/persona/"
  copy_real "$OLD_PI/agent/sessions/" "$RUNTIME/pi-agent/sessions/"
  copy_real "$OLD_PI/agent/skills/" "$RUNTIME/pi-agent/skills/"
  copy_real "$OLD_PI/forum/" "$RUNTIME/forum/"
  copy_real "$OLD_AGENTLOGS/" "$RUNTIME/agentlogs-home/"

  [[ -f "$OLD_PI/agent/auth.json" ]] && cp -L "$OLD_PI/agent/auth.json" "$RUNTIME/secrets/auth.json"
  [[ -f "$OLD_PI/agent/models.json" ]] && cp -L "$OLD_PI/agent/models.json" "$RUNTIME/secrets/models.json"
  [[ -f "$OLD_PI/agent/keybindings.json" ]] && cp -L "$OLD_PI/agent/keybindings.json" "$RUNTIME/secrets/keybindings.json"
  [[ -f "$HOME/.config/secrets.env" ]] && cp -L "$HOME/.config/secrets.env" "$RUNTIME/secrets/secrets.env"
  [[ -f "$HOME/.gitconfig" ]] && cp -L "$HOME/.gitconfig" "$RUNTIME/secrets/gitconfig"
  [[ -d "$HOME/.config/gnupg" ]] && copy_real "$HOME/.config/gnupg/" "$RUNTIME/secrets/gnupg/"
  find "$RUNTIME/secrets" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$RUNTIME/secrets" -type f -exec chmod 600 {} + 2>/dev/null || true
  write_ssh_config
  write_forum_env_if_missing

  node "$ROOT/scripts/stanza-standalone-migrate.mjs"
  log "migration complete"
}

start_new() {
  cd "$ROOT"
  run docker compose -f compose.stanza.yaml up -d --build
}

verify() {
  cd "$ROOT"
  node "$ROOT/scripts/stanza-standalone-migrate.mjs" verify
  docker ps --format '{{.Names}}' | grep -qx monika || { docker ps; echo "monika container not running" >&2; exit 1; }
  docker ps --format '{{.Names}}' | grep -qx monika-forum || { docker ps; echo "monika-forum container not running" >&2; exit 1; }
  for i in {1..60}; do
    if docker exec monika curl -fsS http://127.0.0.1:7724/healthz >/dev/null 2>&1; then break; fi
    sleep 1
    [[ "$i" == 60 ]] && { docker logs --tail 200 monika; echo "agentd health check failed" >&2; exit 1; }
  done
  for i in {1..60}; do
    if curl -fsS http://127.0.0.1:4310/healthz >/dev/null 2>&1 && curl -fsS http://127.0.0.1:4310/api/healthz >/dev/null 2>&1; then break; fi
    sleep 1
    [[ "$i" == 60 ]] && { docker logs --tail 200 monika-forum; echo "forum health check failed" >&2; exit 1; }
  done
  docker exec monika curl -fsS http://127.0.0.1:7724/v1/models >/dev/null
  log "verification ok"
}

rollback() {
  cd "$ROOT"
  if [[ "$YES" != 1 ]]; then
    confirm "Rollback to old host-mode compose?" || { echo "aborted" >&2; exit 1; }
  fi
  docker compose -f compose.stanza.yaml down || true
  docker compose -f compose.yaml -f compose.forum.yaml up -d
  log "rollback started old host-mode deployment"
}

execute() {
  preflight
  stop_old
  make_backup
  migrate
  start_new
  verify
}

case "$CMD" in
  plan) plan ;;
  preflight) preflight ;;
  stop) stop_old ;;
  backup) make_backup ;;
  migrate) migrate ;;
  start) start_new ;;
  verify) verify ;;
  execute) execute ;;
  rollback) rollback ;;
  *) usage; exit 2 ;;
esac
