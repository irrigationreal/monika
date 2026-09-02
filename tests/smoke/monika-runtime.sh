#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: tests/smoke/monika-runtime.sh <image>

Smoke-test a Monika runtime image in standalone mode.

The test starts an isolated throwaway container, waits for memstore and agentd,
verifies shipped project license texts, checks the Pi CLI, runs an agentd turn
against a local strict-schema model fixture, then drains and closes the runtime.
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

IMAGE="${1:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$IMAGE" ]; then
  usage >&2
  exit 2
fi

# Deterministic runner/stateful-memory and SSH checks use pure local fixtures;
# mandatory image smoke never contacts an external provider or SSH host.
node --experimental-default-type=module --test \
  "$SCRIPT_DIR/../agent-runner.test.mjs" \
  "$SCRIPT_DIR/../runtime-supervision.test.mjs" \
  "$SCRIPT_DIR/../stateful-memory/lifecycle.test.js" \
  "$SCRIPT_DIR/../ssh-lock.test.mjs" \
  "$SCRIPT_DIR/../ssh-relocate.test.mjs" \
  "$SCRIPT_DIR/../ssh-search-transport.test.mjs"

# The operator authority must never be interpreted as an install option or
# allowed to collapse onto a shared top-level mount.
if docker run --rm -e PI_SUBAGENT_OPERATOR_ROOT=--help "$IMAGE" true >/dev/null 2>&1; then
  echo "runtime accepted a relative option-like operator root"
  exit 1
fi
if docker run --rm -e PI_SUBAGENT_OPERATOR_ROOT=/data/operator/.. "$IMAGE" true >/dev/null 2>&1; then
  echo "runtime accepted a shared top-level operator root"
  exit 1
fi
for invalid_package_root in /app/.pi/agent /app/.pi/agent/packages /opt/monika; do
  if docker run --rm -e MONIKA_AGENTD_ENABLED=0 -e PI_PACKAGE_STATE_DIR="$invalid_package_root" "$IMAGE" true >/dev/null 2>&1; then
    echo "runtime accepted overlapping Pi package root: $invalid_package_root"
    exit 1
  fi
done

CONTAINER_NAME="${MONIKA_SMOKE_CONTAINER:-monika-smoke-$$}"
AGENTD_CONTAINER_PORT="7724"
MEMSTORE_SOCKET="/tmp/memstore.sock"
MEMSTORE_DATA_DIR="/data/memstore"
SMOKE_TMP_DIR=""
SMOKE_RUNTIME_DATA=""
MOCK_FORUM_PID=""
MOCK_MODEL_CONTAINER=""
RUNNER_CONTAINER=""
SUPERVISION_CONTAINER=""
SMOKE_NETWORK=""

section() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::group::$1"
  else
    printf '\n== %s ==\n' "$1"
  fi
}

endsection() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::endgroup::"
  fi
}

pass() { printf '✓ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    section "${CONTAINER_NAME} logs"
    docker logs "$CONTAINER_NAME" 2>/dev/null || true
    endsection
    if [ -n "$MOCK_MODEL_CONTAINER" ]; then
      section "${MOCK_MODEL_CONTAINER} logs"
      docker logs "$MOCK_MODEL_CONTAINER" 2>/dev/null || true
      endsection
    fi
    if [ -n "$RUNNER_CONTAINER" ]; then
      section "${RUNNER_CONTAINER} logs"
      docker logs "$RUNNER_CONTAINER" 2>/dev/null || true
      endsection
    fi
  fi
  if [ -n "$MOCK_FORUM_PID" ]; then
    kill "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
    wait "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
  fi
  docker rm -fv "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ -n "$RUNNER_CONTAINER" ]; then
    docker rm -fv "$RUNNER_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$SUPERVISION_CONTAINER" ]; then
    docker rm -fv "$SUPERVISION_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$MOCK_MODEL_CONTAINER" ]; then
    docker rm -fv "$MOCK_MODEL_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_NETWORK" ]; then
    docker network rm "$SMOKE_NETWORK" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_TMP_DIR" ]; then
    # Runtime containers create root-owned state beneath this test-only bind
    # mount. Remove only children of the exact mktemp root from a short-lived
    # root helper before the host shell removes the now-empty directory.
    docker run --rm \
      --entrypoint sh \
      -v "$SMOKE_TMP_DIR:/cleanup" \
      "$IMAGE" \
      -c 'find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' \
      >/dev/null 2>&1 || true
    rm -rf "$SMOKE_TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

SMOKE_TMP_DIR="$(mktemp -d)"
SMOKE_RUNTIME_SECRETS="$SMOKE_TMP_DIR/runtime-secrets"
SMOKE_RUNTIME_DATA="$SMOKE_TMP_DIR/runtime-data"
SMOKE_NETWORK="monika-smoke-net-$$"
MOCK_MODEL_CONTAINER="monika-mock-model-$$"
mkdir -p "$SMOKE_RUNTIME_SECRETS/ssh/targets" "$SMOKE_RUNTIME_DATA"
docker network create "$SMOKE_NETWORK" >/dev/null
docker run -d \
  --name "$MOCK_MODEL_CONTAINER" \
  --network "$SMOKE_NETWORK" \
  --network-alias mock-model \
  --entrypoint node \
  -v "$SCRIPT_DIR/mock-openai-responses.cjs:/mock/server.cjs:ro" \
  -v "$SMOKE_TMP_DIR:/output" \
  "$IMAGE" /mock/server.cjs >/dev/null
for _ in {1..50}; do
  if docker exec "$MOCK_MODEL_CONTAINER" node -e "fetch('http://127.0.0.1:7777/healthz').then(r => { if (!r.ok) process.exit(1) })" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! docker exec "$MOCK_MODEL_CONTAINER" node -e "fetch('http://127.0.0.1:7777/healthz').then(r => { if (!r.ok) process.exit(1) })" >/dev/null 2>&1; then
  echo "mock model server did not start"
  docker logs "$MOCK_MODEL_CONTAINER" || true
  exit 1
fi
cat >"$SMOKE_RUNTIME_SECRETS/models.json" <<'MODELS_SMOKE'
{
  "providers": {
    "mock-openai": {
      "baseUrl": "http://mock-model:7777/v1",
      "apiKey": "smoke-test-key",
      "api": "openai-responses",
      "models": [{
        "id": "schema-smoke",
        "name": "Schema Smoke",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 32000,
        "maxTokens": 1024,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "supportsStrictMode": true }
      }]
    }
  }
}
MODELS_SMOKE

section "Start standalone runtime"
docker rm -fv "$CONTAINER_NAME" >/dev/null 2>&1 || true
CONTAINER_ID="$(docker run -d \
  --name "$CONTAINER_NAME" \
  --network "$SMOKE_NETWORK" \
  -p "127.0.0.1::${AGENTD_CONTAINER_PORT}" \
  -e HOME=/app \
  -e MEMSTORE_SOCKET="$MEMSTORE_SOCKET" \
  -e MEMSTORE_DATA_DIR="$MEMSTORE_DATA_DIR" \
  -e MONIKA_AGENTD_HOST=0.0.0.0 \
  -e MONIKA_AGENTD_PORT="$AGENTD_CONTAINER_PORT" \
  -e AGENTLOGS_HOME=/agentlogs-home \
  -e PI_SUBAGENT_EXECUTION_TARGET_ROOT=/runtime/secrets/ssh/targets \
  -e PI_SUBAGENT_SSH_LOCK_EXTENSION=/app/.pi/agent/extensions/ssh.ts \
  -v "$SMOKE_RUNTIME_SECRETS:/runtime/secrets:ro" \
  -v "$SMOKE_RUNTIME_DATA:/data" \
  "$IMAGE")"
AGENTD_PORT="$(docker port "$CONTAINER_NAME" "${AGENTD_CONTAINER_PORT}/tcp" | sed 's/.*://')"
if [ -z "$AGENTD_PORT" ]; then
  echo "Could not determine published agentd port"
  exit 1
fi
pass "container started"
info "image: $IMAGE"
info "container: ${CONTAINER_ID:0:12} ($CONTAINER_NAME)"
info "mode: standalone (/app/.pi, ephemeral /data)"
info "agentd: http://127.0.0.1:${AGENTD_PORT}"
endsection

section "Wait for runtime readiness"
ready_after=""
for i in {1..60}; do
  if docker exec "$CONTAINER_NAME" test -S "$MEMSTORE_SOCKET" \
    && curl -fsS "http://127.0.0.1:${AGENTD_PORT}/healthz" >/tmp/monika-healthz.json 2>/dev/null; then
    ready_after="$i"
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    echo "$CONTAINER_NAME exited before becoming healthy"
    exit 1
  fi
  sleep 1
done
if [ -z "$ready_after" ]; then
  echo "$CONTAINER_NAME did not become healthy within 60s"
  exit 1
fi
pass "memstore socket ready: $MEMSTORE_SOCKET"
pass "agentd health endpoint ready after ${ready_after}s"
endsection

section "One-shot runner lifecycle and durable archival"
RUNNER_ROOT="$SMOKE_TMP_DIR/runner"
mkdir -p "$RUNNER_ROOT/task" "$RUNNER_ROOT/workspace"
cat >"$RUNNER_ROOT/task/prompt.md" <<'RUNNER_PROMPT'
Inspect this disposable runner using only the supplied context and return OK. This
prompt is deliberately longer than the stateful-memory transcript threshold so save
policy is exercised. Keep the final response to exactly the two uppercase letters OK.
RUNNER_PROMPT

mkdir -p "$RUNNER_ROOT/git/outputs" "$RUNNER_ROOT/git/scratch" "$RUNNER_ROOT/git/data" "$RUNNER_ROOT/git/fixture"
cat >"$RUNNER_ROOT/git/fixture/pi" <<'RUNNER_FAKE_PI'
#!/bin/sh
git config --global user.name
git config --global --get-all safe.directory
RUNNER_FAKE_PI
chmod +x "$RUNNER_ROOT/git/fixture/pi"
RUNNER_CONTAINER="monika-runner-git-$$"
docker run --rm --name "$RUNNER_CONTAINER" \
  -e AGENT_RUNNER_MODE=1 -e MONIKA_AGENTD_ENABLED=0 -e GIT_USER_NAME='Runner Smoke' \
  -e RUNNER_TASK_FILE=/task/prompt.md -e RUNNER_OUTPUT_DIR=/outputs \
  -e RUNNER_WORKSPACE=/workspace -e RUNNER_SCRATCH_DIR=/scratch \
  -e RUNNER_TIMEOUT_SECONDS=10 \
  -e PATH=/fixture:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$RUNNER_ROOT/task:/task:ro" -v "$RUNNER_ROOT/workspace:/workspace:ro" \
  -v "$RUNNER_ROOT/git/outputs:/outputs" -v "$RUNNER_ROOT/git/scratch:/scratch" \
  -v "$RUNNER_ROOT/git/data:/data" -v "$RUNNER_ROOT/git/fixture:/fixture:ro" \
  "$IMAGE" /app/bin/agent-runner.mjs run
if ! grep -qx 'Runner Smoke' "$RUNNER_ROOT/git/outputs/stdout.txt" ||
  ! grep -qx '\*' "$RUNNER_ROOT/git/outputs/stdout.txt"; then
  echo "runner scratch HOME hid runtime Git identity or safe.directory"
  cat "$RUNNER_ROOT/git/outputs/stdout.txt"
  exit 1
fi
RUNNER_CONTAINER=""
pass "runner scratch HOME retained runtime-global Git configuration"

WRAPPER_OUTPUT="$RUNNER_ROOT/wrapper-output"
WRAPPER_FIXTURE="$RUNNER_ROOT/wrapper-fixture"
mkdir -p "$WRAPPER_OUTPUT" "$WRAPPER_FIXTURE"
printf 'caller-owned\n' >"$WRAPPER_OUTPUT/sentinel.txt"
cat >"$WRAPPER_FIXTURE/pi" <<'RUNNER_CLEANUP_PI'
#!/bin/sh
mkdir -p "$HOME/root-only"
printf 'root-owned\n' >"$HOME/root-only/secret.txt"
chmod 000 "$HOME/root-only"
printf 'OK\n'
RUNNER_CLEANUP_PI
chmod +x "$WRAPPER_FIXTURE/pi"
mkdir -p "$SCRIPT_DIR/../../runner-runtime/scratch"
wrapper_scratch_before="$(find "$SCRIPT_DIR/../../runner-runtime/scratch" -mindepth 1 -maxdepth 1 -type d | wc -l)"
"$SCRIPT_DIR/../../scripts/agent-runner" run \
  --task "$RUNNER_ROOT/task/prompt.md" \
  --workspace "$RUNNER_ROOT/workspace" \
  --output-dir "$WRAPPER_OUTPUT" \
  --cleanup always \
  --image "$IMAGE" \
  --extra-docker-arg -v \
  --extra-docker-arg "$WRAPPER_FIXTURE:/fixture:ro" \
  --extra-docker-arg -e \
  --extra-docker-arg PATH=/fixture:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
test "$(cat "$WRAPPER_OUTPUT/sentinel.txt")" = caller-owned
wrapper_scratch_after="$(find "$SCRIPT_DIR/../../runner-runtime/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
if [ "$wrapper_scratch_after" -ne "$wrapper_scratch_before" ]; then
  echo "runner wrapper left scratch after cleanup=always"
  exit 1
fi
pass "wrapper preserved explicit output and removed root-owned runner scratch"

run_runner_smoke() {
  local name="$1"
  local save_session="$2"
  local root="$RUNNER_ROOT/$name"
  mkdir -p "$root/outputs" "$root/scratch" "$root/data"
  RUNNER_CONTAINER="monika-runner-${name}-$$"
  local args=(
    run --name "$RUNNER_CONTAINER" --network "$SMOKE_NETWORK"
    -e AGENT_RUNNER_MODE=1 -e MONIKA_AGENTD_ENABLED=0 -e MONIKA_LOG_TO_STDERR=1
    -e RUNNER_TASK_FILE=/task/prompt.md -e RUNNER_OUTPUT_DIR=/outputs
    -e RUNNER_WORKSPACE=/workspace -e RUNNER_SCRATCH_DIR=/scratch
    -e RUNNER_TIMEOUT_SECONDS=20 -e PI_MODEL=mock-openai/schema-smoke
    -v "$RUNNER_ROOT/task:/task:ro" -v "$RUNNER_ROOT/workspace:/workspace:ro"
    -v "$root/outputs:/outputs" -v "$root/scratch:/scratch" -v "$root/data:/data"
    -v "$SMOKE_RUNTIME_SECRETS:/runtime/secrets:ro"
  )
  if [ "$save_session" = "1" ]; then
    args+=( -e RUNNER_SAVE_SESSION=1 )
  fi
  docker "${args[@]}" "$IMAGE" /app/bin/agent-runner.mjs run

  node - "$root/outputs/result.json" "$save_session" <<'NODE_RUNNER_RESULT'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (result.ok !== true || result.exitCode !== 0 || result.timedOut !== false) {
  throw new Error(`runner result was not successful: ${JSON.stringify(result)}`);
}
if (Boolean(result.sessionDir) !== (process.argv[3] === '1')) {
  throw new Error(`runner session contract changed: ${JSON.stringify(result)}`);
}
NODE_RUNNER_RESULT
  grep -qx 'OK' "$root/outputs/stdout.txt"
  ! grep -Fq '/scratch/home/.pi/stateful-memory' "$root/outputs/stderr.txt"
  ! grep -Eq 'Extension error .*stateful-memory|\[stateful-memory\] memstore connection failed' "$root/outputs/stderr.txt"
  docker logs "$RUNNER_CONTAINER" >"$root/container.log" 2>&1
  grep -q '\[monika\] Shutting down' "$root/container.log"
  grep -q 'shutting down...' "$root/container.log"
}

run_runner_smoke default 0
if grep -q '\[save\] completed' "$RUNNER_ROOT/default/container.log" || [ -e "$RUNNER_ROOT/default/data/memstore/origin-map.json" ]; then
  echo "default no-session runner unexpectedly archived its transcript"
  exit 1
fi
docker rm "$RUNNER_CONTAINER" >/dev/null
RUNNER_CONTAINER=""
pass "default runner retained stateful-memory without automatic transcript archival"

run_runner_smoke saved 1
grep -q '\[save\] completed for /outputs/sessions/' "$RUNNER_ROOT/saved/container.log"
node - "$RUNNER_ROOT/saved/data/memstore/origin-map.json" <<'NODE_RUNNER_ORIGIN'
const fs = require('node:fs');
const origins = Object.keys(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
if (origins.length !== 1 || !origins[0].startsWith('/outputs/sessions/') || origins[0] === 'ephemeral') {
  throw new Error(`unexpected durable runner origins: ${JSON.stringify(origins)}`);
}
NODE_RUNNER_ORIGIN
test -n "$(find "$RUNNER_ROOT/saved/outputs/sessions" -type f -name '*.jsonl' -print -quit)"
docker rm "$RUNNER_CONTAINER" >/dev/null
RUNNER_CONTAINER=""
pass "save-session runner waited for exact durable archival and used its Pi session path"

RUNNER_CONTAINER="monika-command-status-$$"
set +e
docker run --name "$RUNNER_CONTAINER" -e MONIKA_AGENTD_ENABLED=0 "$IMAGE" sh -c 'exit 23' >/dev/null 2>&1
command_exit=$?
set -e
if [ "$command_exit" -ne 23 ]; then
  echo "entrypoint did not preserve foreground exit status: $command_exit"
  exit 1
fi
command_logs="$(docker logs "$RUNNER_CONTAINER" 2>&1)"
grep -q 'shutting down...' <<<"$command_logs"
docker rm "$RUNNER_CONTAINER" >/dev/null

RUNNER_CONTAINER="monika-command-signal-$$"
docker run -d --name "$RUNNER_CONTAINER" -e MONIKA_AGENTD_ENABLED=0 "$IMAGE" sleep 30 >/dev/null
for _ in {1..60}; do
  docker exec "$RUNNER_CONTAINER" test -S /tmp/memstore.sock 2>/dev/null && break
  sleep 0.1
done
docker kill --signal TERM "$RUNNER_CONTAINER" >/dev/null
signal_exit="$(docker wait "$RUNNER_CONTAINER")"
if [ "$signal_exit" -ne 143 ]; then
  echo "entrypoint did not preserve forwarded SIGTERM status: $signal_exit"
  exit 1
fi
command_logs="$(docker logs "$RUNNER_CONTAINER" 2>&1)"
grep -q 'shutting down...' <<<"$command_logs"
docker rm "$RUNNER_CONTAINER" >/dev/null

RUNNER_CONTAINER="monika-command-essential-$$"
docker run -d --name "$RUNNER_CONTAINER" -e MONIKA_AGENTD_ENABLED=0 "$IMAGE" sleep 30 >/dev/null
for _ in {1..60}; do
  docker exec "$RUNNER_CONTAINER" test -S /tmp/memstore.sock 2>/dev/null && break
  sleep 0.1
done
MEMSTORE_COMMAND_PID="$(docker exec "$RUNNER_CONTAINER" sh -lc 'for proc in /proc/[0-9]*; do [ "$(cat "$proc/comm" 2>/dev/null)" = memstore ] && { basename "$proc"; break; }; done')"
if [ -z "$MEMSTORE_COMMAND_PID" ]; then
  echo "could not locate memstore PID in command-mode supervision container"
  exit 1
fi
docker exec "$RUNNER_CONTAINER" kill "$MEMSTORE_COMMAND_PID"
essential_exit="$(docker wait "$RUNNER_CONTAINER")"
if [ "$essential_exit" -eq 0 ]; then
  echo "foreground command mode ignored essential memstore death"
  exit 1
fi
command_logs="$(docker logs "$RUNNER_CONTAINER" 2>&1)"
grep -q 'essential child memstore exited while foreground command was running' <<<"$command_logs"
docker rm "$RUNNER_CONTAINER" >/dev/null
RUNNER_CONTAINER=""
pass "PID 1 preserved command exit/signal status, monitored essentials, and stopped memstore gracefully"
endsection

section "Runtime checks"
LICENSE_DIR=/usr/share/licenses/monika
for file in LICENSE THIRD_PARTY_NOTICES.md claude-code-use-MIT.txt; do
  if ! docker exec "$CONTAINER_NAME" test -s "$LICENSE_DIR/$file"; then
    echo "$file missing or empty from $LICENSE_DIR"
    exit 1
  fi
done
docker exec "$CONTAINER_NAME" grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$LICENSE_DIR/LICENSE"
docker exec "$CONTAINER_NAME" grep -q "Copyright (c) 2026 Ben Vargas" "$LICENSE_DIR/claude-code-use-MIT.txt"
pass "project AGPL license and third-party notices present"
OCI_LICENSE=$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "$CONTAINER_NAME")
if [ "$OCI_LICENSE" != "AGPL-3.0-or-later" ]; then
  echo "Unexpected OCI license label: ${OCI_LICENSE:-<unset>}"
  exit 1
fi
pass "OCI license label is AGPL-3.0-or-later"

PI_VERSION="$(docker exec "$CONTAINER_NAME" pi --version 2>&1)"
if [ "$PI_VERSION" != "0.84.3" ]; then
  echo "Expected Pi 0.84.3, got: $PI_VERSION"
  exit 1
fi
pass "pi CLI pin active: ${PI_VERSION}"

PI_OFFLINE_DEFAULT="$(docker exec "$CONTAINER_NAME" sh -c 'printf %s "${PI_OFFLINE:-}"')"
if [ "$PI_OFFLINE_DEFAULT" != "1" ]; then
  echo "Expected ordinary Pi startup to default PI_OFFLINE=1, got: ${PI_OFFLINE_DEFAULT:-<unset>}"
  exit 1
fi
for managed in settings.json npm git; do
  target="$(docker exec "$CONTAINER_NAME" readlink "/app/.pi/agent/$managed")"
  if [ "$target" != "/data/pi-agent-packages/$managed" ]; then
    echo "Expected persistent Pi package link for $managed, got: ${target:-<not a symlink>}"
    exit 1
  fi
done
docker exec "$CONTAINER_NAME" test -d /data/pi-agent-packages/npm/node_modules/pi-agent-browser
docker exec -i "$CONTAINER_NAME" node - <<'NODE_PI_PACKAGE_DEFAULTS'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync('/app/.pi/agent/settings.json', 'utf8'));
if (!settings.packages.includes('npm:pi-agent-browser@0.1.0')) throw new Error('browser package choice missing');
if (!settings.packages.includes('/opt/pi-subagents')) throw new Error('local pi-subagents package choice missing');
const sourceOf = (entry) => typeof entry === 'string' ? entry : entry?.source;
if (settings.packages.some((entry) => sourceOf(entry)?.includes('nutrient-skills'))) throw new Error('nutrient-skills remains configured');
NODE_PI_PACKAGE_DEFAULTS
pass "Pi settings/npm/git package state is persistent, browser is seeded, and nutrient-skills is absent"

settings_before_failed_install="$(docker exec "$CONTAINER_NAME" sha256sum /app/.pi/agent/settings.json | awk '{print $1}')"
if docker exec "$CONTAINER_NAME" pi install /data/pi-package-source-that-does-not-exist >/dev/null 2>&1; then
  echo "nonexistent local explicit install unexpectedly succeeded"
  exit 1
fi
settings_after_failed_install="$(docker exec "$CONTAINER_NAME" sha256sum /app/.pi/agent/settings.json | awk '{print $1}')"
if [ "$settings_before_failed_install" != "$settings_after_failed_install" ]; then
  echo "failed Pi install mutated persistent settings"
  exit 1
fi
pass "failed explicit Pi install leaves package choices unchanged"

# Add a local package through Pi itself, then alter a non-package setting. The
# replacement-container check below proves package custody survives while image
# defaults are authoritatively restored.
docker exec "$CONTAINER_NAME" sh -eu -c '
  mkdir -p /data/pi-package-smoke
  printf "%s\n" '\''{"name":"pi-package-persistence-smoke","version":"1.0.0","pi":{"extensions":["extension.js"]}}'\'' > /data/pi-package-smoke/package.json
  cat > /data/pi-package-smoke/extension.js <<'\''EOF_PI_PACKAGE_EXTENSION'\''
import { writeFileSync } from "node:fs";
export default function persistenceSmoke(pi) {
  pi.registerCommand("persistence-smoke", {
    description: "prove the filtered persistent package loaded",
    handler: async () => writeFileSync("/data/pi-package-smoke-loaded", "loaded\n"),
  });
}
EOF_PI_PACKAGE_EXTENSION
  pi install /data/pi-package-smoke
  touch /app/.pi/agent/npm/.persistence-smoke /app/.pi/agent/git/.persistence-smoke
  for stale_pid in $(seq 1 128); do
    touch "/data/pi-agent-packages/settings.json.tmp.$stale_pid" "/data/pi-agent-packages/npm.tmp.$stale_pid"
  done
  node -e '\''const fs=require("fs"); const path=require("path"); const file="/app/.pi/agent/settings.json"; const settings=JSON.parse(fs.readFileSync(file,"utf8")); const index=settings.packages.findIndex((entry)=>{const source=typeof entry==="string"?entry:entry?.source; return typeof source==="string" && path.resolve("/app/.pi/agent",source)==="/data/pi-package-smoke";}); if(index<0) throw new Error("installed smoke package missing"); settings.packages[index]={source:"../../../data/pi-package-smoke",extensions:["extension.js"],skills:[],prompts:[],themes:[]}; settings.defaultModel="must-be-reset-on-recreation"; fs.writeFileSync(file, JSON.stringify(settings,null,2)+"\n");'\''
'
pass "Pi-managed package state prepared for replacement-container persistence check"

# Validate the exact image-owned JavaScript extension copies before exercising
# either Pi loading path. A malformed ambient extension otherwise remains
# latent until an operator needs the direct CLI during recovery.
docker exec "$CONTAINER_NAME" sh -eu -c '
  find /app/.pi/agent/extensions -type f \( -name "*.js" -o -name "*.mjs" \) -print0 \
    | sort -z \
    | xargs -0 -r -n1 node --check
'
pass "bundled JavaScript extensions pass syntax validation"

# Agentd supplies explicit extension factories, while the emergency CLI path
# discovers ambient extensions from PI_CODING_AGENT_DIR. Start Pi's direct RPC
# mode and require a state response; malformed ambient extensions fail before
# this handshake. Terminate the probe explicitly because extensions may own
# long-lived watchers even after a non-interactive model turn completes.
docker exec -i "$CONTAINER_NAME" node - <<'NODE_DIRECT_PI'
const { spawn } = require('node:child_process');

const pi = spawn('pi', [
  '--mode', 'rpc',
  '--no-session',
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--provider', 'mock-openai',
  '--model', 'schema-smoke',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let stdout = '';
let stderr = '';
let settled = false;
let killTimeout;
const timeout = setTimeout(() => finish(new Error(`direct Pi RPC startup timed out; stderr=${stderr}`)), 20_000);

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  pi.kill('SIGTERM');
  killTimeout = setTimeout(() => pi.kill('SIGKILL'), 2_000);
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

pi.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
pi.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  while (stdout.includes('\n')) {
    const newline = stdout.indexOf('\n');
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'response' && message.command === 'get_state') {
      if (message.success !== true || message.data?.model?.id !== 'schema-smoke') {
        finish(new Error(`direct Pi RPC returned invalid state: ${line}`));
      } else {
        finish();
      }
    }
  }
});
pi.on('error', (error) => finish(error));
pi.on('exit', (code, signal) => {
  clearTimeout(killTimeout);
  if (!settled) {
    settled = true;
    clearTimeout(timeout);
    console.error(`direct Pi exited before RPC readiness: code=${code} signal=${signal}; stderr=${stderr}`);
    process.exitCode = 1;
  }
});
pi.stdin.write(`${JSON.stringify({ id: 'smoke-get-state', type: 'get_state' })}\n`);
NODE_DIRECT_PI
pass "direct Pi CLI loads ambient extensions and reaches RPC readiness"

docker exec -i "$CONTAINER_NAME" node - <<'NODE_SUBAGENTS_PIN'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
if (process.env.PI_SUBAGENT_SESSION_ROOT !== '/app/.pi/agent/sessions/subagent') throw new Error('Dedicated subagent session root is not global');
if (process.env.PI_SUBAGENT_RUNTIME_ROOT !== '/data/pi-subagents') throw new Error('Dedicated subagent runtime root is not global');
if (process.env.PI_SUBAGENT_OPERATOR_ROOT !== '/data/pi-subagent-operator-state') throw new Error('Dedicated subagent operator root is not global');
const operatorRoot = fs.statSync(process.env.PI_SUBAGENT_OPERATOR_ROOT);
if (!operatorRoot.isDirectory() || (operatorRoot.mode & 0o777) !== 0o700) throw new Error('Dedicated subagent operator root is missing or not private');
const runtime = JSON.parse(fs.readFileSync('/run/monika-runtime-instance.json', 'utf8'));
if (runtime.version !== 1 || typeof runtime.id !== 'string' || !Number.isFinite(runtime.createdAt)) throw new Error('Container runtime instance identity is invalid');
const asyncSource = fs.readFileSync('/opt/pi-subagents/src/runs/background/async-execution.ts', 'utf8');
const runnerSource = fs.readFileSync('/opt/pi-subagents/src/runs/background/subagent-runner.ts', 'utf8');
const watcherSource = fs.readFileSync('/opt/pi-subagents/src/runs/background/result-watcher.ts', 'utf8');
const asyncPolicySource = fs.readFileSync('/opt/pi-subagents/src/runs/background/top-level-async.ts', 'utf8');
const resultClaimSource = fs.readFileSync('/opt/pi-subagents/src/runs/background/result-claim.ts', 'utf8');
const waitSource = fs.readFileSync('/opt/pi-subagents/src/runs/background/subagent-wait.ts', 'utf8');
const foregroundSource = fs.readFileSync('/opt/pi-subagents/src/runs/foreground/execution.ts', 'utf8');
const typesSource = fs.readFileSync('/opt/pi-subagents/src/shared/types.ts', 'utf8');
const preflightSource = fs.readFileSync('/opt/pi-subagents/src/api/preflight.ts', 'utf8');
if (!fs.existsSync('/opt/pi-subagents/src/runs/shared/execution-target.ts')) throw new Error('Execution-target runtime missing');
if (!fs.existsSync('/app/.pi/agent/extensions/ssh-lock.mjs')) throw new Error('Locked SSH helper missing');
if (!fs.existsSync('/app/.pi/agent/extensions/ssh-relocate.mjs')) throw new Error('Relocate state-machine helper missing');
if (!typesSource.includes('SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 5')) throw new Error('Lifecycle v5 missing');
if (!preflightSource.includes('SUBAGENT_LAUNCH_CONTRACT_VERSION = 3')) throw new Error('Launch contract v3 missing');
if (!asyncPolicySource.includes('PI_SUBAGENTS_DEFAULT_DELIVERY_DISPOSITION') || !asyncPolicySource.includes('"awaited"')) throw new Error('Delivery-disposition source missing');
if (!resultClaimSource.includes('pi-subagents.result-claim') || !resultClaimSource.includes('deliveryDisposition: "awaited"')) throw new Error('Awaited result-claim source missing');
if (!waitSource.includes('claimAwaitedResult') || !waitSource.includes('publishClaim')) throw new Error('Wait-tool result-claim publication source missing');
if (!asyncSource.includes('launch.json') || !asyncSource.includes('PI_SUBAGENTS_HOST_DRAINING')) throw new Error('Durable async launch/drain patch missing');
if (!runnerSource.includes('Optional subagent artifact write failed')) throw new Error('Resilient artifact finalization patch missing');
if (!watcherSource.includes('PI_SUBAGENTS_HOST_DRAINING')) throw new Error('Completion drain barrier patch missing');
if (!watcherSource.includes('host-cancellation.json')) throw new Error('Host-cancelled result wake suppression missing');
if (!asyncPolicySource.includes('PI_SUBAGENTS_FORCE_ASYNC')) throw new Error('Agentd nested force-async policy missing');
if (!foregroundSource.includes('!childExited && !detached && proc.kill("SIGKILL")')) throw new Error('Foreground hard-kill exit check missing');
const reviewed = JSON.parse(fs.readFileSync('/opt/pi-subagents/REVIEWED_SOURCE.json', 'utf8'));
if (reviewed.version !== '0.37.2') throw new Error(`Unexpected pi-subagents version: ${reviewed.version}`);
if (reviewed.gitHead !== '8063333661476ca48afbca826dc4aab8707c72d3') throw new Error(`Unexpected pi-subagents gitHead: ${reviewed.gitHead}`);
if (reviewed.npmArtifactIntegrity !== 'sha512-pf7DxLBY9pFY3grOFgRfMqoS9QbElWP2ULOCOnmJNrCEvjlA81fiyp0wk1vSaJPJ/rjsP0lA1sAk7S/QD+Olpg==') {
  throw new Error(`Unexpected reviewed npm integrity: ${reviewed.npmArtifactIntegrity}`);
}
const settings = JSON.parse(fs.readFileSync('/app/.pi/agent/settings.json', 'utf8'));
if (!settings.packages?.includes('/opt/pi-subagents')) throw new Error('Local reviewed pi-subagents package is not configured');
if (process.env.MONIKA_SSH_LOCK_DESCRIPTOR) throw new Error('Default smoke runtime must remain local');
if (!process.env.PI_SUBAGENT_EXECUTION_TARGET_ROOT) throw new Error('Execution target registry root is not configured');
if (!/^[a-f0-9]{64}$/.test(process.env.PI_SUBAGENT_SSH_LOCK_CODE_DIGEST ?? '')) throw new Error('SSH lock code startup attestation missing');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const extensionSha = sha(fs.readFileSync('/app/.pi/agent/extensions/ssh.ts'));
const helperSha = sha(fs.readFileSync('/app/.pi/agent/extensions/ssh-lock.mjs'));
const relocateHelperSha = sha(fs.readFileSync('/app/.pi/agent/extensions/ssh-relocate.mjs'));
if (sha(`${extensionSha}\n${helperSha}\n${relocateHelperSha}\n`) !== process.env.PI_SUBAGENT_SSH_LOCK_CODE_DIGEST) throw new Error('SSH lock code attestation mismatch');
if (JSON.stringify(settings.subagents?.defaultExtensions) !== '[]') throw new Error('subagents.defaultExtensions must disable ambient extensions');
for (const profile of ['advisor', 'delegate']) {
  if (settings.subagents?.agentOverrides?.[profile]?.disabled !== true) throw new Error(`Upstream ${profile} profile must be disabled`);
}
for (const file of fs.readdirSync('/opt/pi-subagents/agents')) {
  const source = fs.readFileSync(`/opt/pi-subagents/agents/${file}`, 'utf8');
  if (/^memory\s*:/m.test(source)) throw new Error(`Bundled agent enables MEMORY.md by default: ${file}`);
}
const terraProfiles = new Set(['scout.md', 'researcher.md', 'context-builder.md']);
for (const file of fs.readdirSync('/app/.pi/agent/agents').filter((name) => name.endsWith('.md'))) {
  const source = fs.readFileSync(`/app/.pi/agent/agents/${file}`, 'utf8');
  const expected = terraProfiles.has(file) ? 'codex/gpt-5.6-terra' : 'codex/gpt-5.6-sol';
  if (!source.includes(`model: ${expected}`)) throw new Error(`${file} does not use ${expected}`);
}
const monikaProfile = fs.readFileSync('/app/.pi/agent/agents/monika-delegate.md', 'utf8');
if (!monikaProfile.includes('I am Monika operating in a bounded delegated context.')) throw new Error('Monika delegate lacks first-person bounded identity framing');
const recallSource = fs.readFileSync('/app/.pi/agent/extensions/stateful-memory/readonly-recall.js', 'utf8');
for (const tool of ['recall', 'recall_session']) {
  if (!recallSource.includes(`name: "${tool}"`)) throw new Error(`Read-only child memory lacks ${tool}`);
}
for (const tool of ['remember', 'remember_session', 'correct_observation', 'retract_observation']) {
  if (recallSource.includes(`name: "${tool}"`)) throw new Error(`Read-only child memory registers mutating tool ${tool}`);
}
NODE_SUBAGENTS_PIN
pass "pi-subagents pin, 5.6 model policy, identity framing, and read-only child memory boundaries active"

docker exec -i "$CONTAINER_NAME" sh -eu -c '
  dependency=/opt/pi-subagents/node_modules/@earendil-works/pi-coding-agent
  script=/tmp/subagent-fork-root-test.cjs
  mkdir -p "$(dirname "$dependency")"
  trap '\''rm -f "$dependency" "$script"'\'' EXIT
  ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent "$dependency"
  cat >"$script"
  node "$script"
' <<'NODE_SUBAGENT_FORK_ROOT'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('/opt/pi-subagents/node_modules/jiti/lib/jiti.cjs');
const jiti = createJiti(__filename, { interopDefault: true });
const { SessionManager } = jiti('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const { createForkContextResolver } = jiti('/opt/pi-subagents/src/shared/fork-context.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-fork-root-'));
try {
  const parentDir = path.join(root, 'parent');
  const childDir = path.join(root, 'subagent', 'run-id', 'run-0');
  const parent = SessionManager.create(root, parentDir);
  parent.appendMessage({ role: 'user', content: 'parent prompt' });
  parent.appendMessage({ role: 'assistant', content: 'parent response' });
  const resolver = createForkContextResolver(parent, 'fork', { sessionDirForIndex: () => childDir });
  const childFile = resolver.sessionFileForIndex(0);
  assert.ok(childFile);
  assert.equal(path.dirname(childFile), childDir);
  assert.equal(childFile.startsWith(`${parentDir}${path.sep}`), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
NODE_SUBAGENT_FORK_ROOT
pass "fork-context child branches honor per-run directories beneath the dedicated root"

if docker exec "$CONTAINER_NAME" sh -c 'test -e /app/.pi/agent/extensions/force-tools.ts || test -e /app/.pi/agent/extensions/delegate'; then
  echo "Legacy force-tools/delegate extension is present"
  exit 1
fi
pass "legacy force-tools and delegate extensions absent"

PI_TRUST_TARGET="$(docker exec "$CONTAINER_NAME" readlink /app/.pi/agent/trust.json)"
if [ "$PI_TRUST_TARGET" != "/data/pi-agent-trust/trust.json" ]; then
  echo "Expected persistent Pi trust state link, got: ${PI_TRUST_TARGET:-<not a symlink>}"
  exit 1
fi
docker exec "$CONTAINER_NAME" node -e "JSON.parse(require('fs').readFileSync('/data/pi-agent-trust/trust.json', 'utf8'))"
pass "Pi project-trust state persists under /data"

PI_MODELS_STORE_TARGET="$(docker exec "$CONTAINER_NAME" readlink /app/.pi/agent/models-store.json)"
if [ "$PI_MODELS_STORE_TARGET" != "/data/pi-agent-models/models-store.json" ]; then
  echo "Expected persistent Pi model-catalog state link, got: ${PI_MODELS_STORE_TARGET:-<not a symlink>}"
  exit 1
fi
docker exec "$CONTAINER_NAME" node -e "JSON.parse(require('fs').readFileSync('/data/pi-agent-models/models-store.json', 'utf8'))"
pass "Pi model-catalog cache persists under /data"

NPM_MIN_RELEASE_AGE="$(docker exec "$CONTAINER_NAME" npm config get min-release-age)"
if [ "$NPM_MIN_RELEASE_AGE" != "10" ]; then
  echo "Expected npm min-release-age=10, got: $NPM_MIN_RELEASE_AGE"
  exit 1
fi
pass "npm dependency cooldown active: ${NPM_MIN_RELEASE_AGE} days"

PNPM_VERSION="$(docker exec "$CONTAINER_NAME" pnpm --version)"
if [ "$PNPM_VERSION" != "11.21.0" ]; then
  echo "Expected pnpm 11.21.0, got: $PNPM_VERSION"
  exit 1
fi
pass "agentd package manager available: pnpm ${PNPM_VERSION}"

PNPM_MIN_RELEASE_AGE="$(docker exec "$CONTAINER_NAME" pnpm config get minimumReleaseAge)"
if [ "$PNPM_MIN_RELEASE_AGE" != "14400" ]; then
  echo "Expected pnpm minimumReleaseAge=14400, got: $PNPM_MIN_RELEASE_AGE"
  exit 1
fi
PNPM_MIN_RELEASE_AGE_STRICT="$(docker exec "$CONTAINER_NAME" pnpm config get minimumReleaseAgeStrict)"
if [ "$PNPM_MIN_RELEASE_AGE_STRICT" != "true" ]; then
  echo "Expected pnpm minimumReleaseAgeStrict=true, got: $PNPM_MIN_RELEASE_AGE_STRICT"
  exit 1
fi
PNPM_MIN_RELEASE_AGE_IGNORE_MISSING_TIME="$(docker exec "$CONTAINER_NAME" pnpm config get minimumReleaseAgeIgnoreMissingTime)"
if [ "$PNPM_MIN_RELEASE_AGE_IGNORE_MISSING_TIME" != "false" ]; then
  echo "Expected pnpm minimumReleaseAgeIgnoreMissingTime=false, got: $PNPM_MIN_RELEASE_AGE_IGNORE_MISSING_TIME"
  exit 1
fi
pass "pnpm dependency cooldown active and fail-closed: 10 days"

AGENT_BROWSER_VERSION="$(docker exec "$CONTAINER_NAME" agent-browser --version)"
if [ "$AGENT_BROWSER_VERSION" != "agent-browser 0.34.0" ]; then
  echo "Expected agent-browser 0.34.0, got: $AGENT_BROWSER_VERSION"
  exit 1
fi
pass "agent-browser pin active: ${AGENT_BROWSER_VERSION}"

docker exec "$CONTAINER_NAME" sh -c '
  set -eu
  node -e '\''require("node:http").createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Browser smoke</title><main>runtime browser ready</main>"); }).listen(47831, "127.0.0.1")'\'' &
  browser_fixture_pid=$!
  trap '\''agent-browser close >/dev/null 2>&1 || true; kill "$browser_fixture_pid" >/dev/null 2>&1 || true'\'' EXIT
  for _attempt in 1 2 3 4 5; do
    curl -fsS http://127.0.0.1:47831/ >/dev/null 2>&1 && break
    sleep 0.2
  done
  curl -fsS http://127.0.0.1:47831/ >/dev/null
  agent-browser open http://127.0.0.1:47831/ >/dev/null
  test "$(agent-browser get title)" = "Browser smoke"
  agent-browser get text body | grep -q "runtime browser ready"
  agent-browser screenshot /tmp/browser-smoke.png >/dev/null
  test -s /tmp/browser-smoke.png
'
pass "agent-browser launches image-owned Chromium and completes page, text, and screenshot operations"

RG_VERSION="$(docker exec "$CONTAINER_NAME" sh -lc 'rg --version | head -n 1')"
FD_VERSION="$(docker exec "$CONTAINER_NAME" fd --version)"
case "$RG_VERSION" in ripgrep\ *) ;; *) echo "Expected image-provisioned ripgrep, got: $RG_VERSION"; exit 1 ;; esac
case "$FD_VERSION" in fd\ *|fdfind\ *) ;; *) echo "Expected image-provisioned fd, got: $FD_VERSION"; exit 1 ;; esac
pass "search dependencies pre-provisioned: ${RG_VERSION}, ${FD_VERSION}"

AGENTD_PORT="$AGENTD_PORT" node <<'NODE_SMOKE'
const base = `http://127.0.0.1:${process.env.AGENTD_PORT}`;

async function request(method, path, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const attempts = opts.attempts ?? 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${method} ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.log(`  retrying ${method} ${path} after failure: ${error?.message ?? error}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const health = await request('GET', '/healthz');
if (health.ok !== true) {
  throw new Error(`agentd health check failed: ${JSON.stringify(health)}`);
}
console.log(`✓ agentd healthy: active=${health.active_threads}, loaded=${health.loaded_conversations}, queue=${health.queue_depth}`);

const created = await request('POST', '/v1/conversations', {
  cwd: '/tmp',
  provider: 'mock-openai',
  model: 'schema-smoke',
}, { attempts: 2, timeoutMs: 60_000 });
const conversation = created?.conversation ?? {};
const conversationId = conversation.id ?? conversation.conversation_id ?? conversation.session_id;
if (!conversationId) {
  throw new Error(`conversation creation did not return an id: ${JSON.stringify(created)}`);
}
console.log(`✓ conversation created: ${conversationId}`);
console.log(`  cwd: ${conversation.cwd ?? '/tmp'}`);
console.log(`  model: ${conversation.model ?? 'unknown'}`);
console.log(`  session: ${conversation.session_path ?? '(not reported)'}`);

const message = await request('POST', `/v1/conversations/${conversationId}/messages`, {
  content: 'Reply with exactly OK.',
}, { timeoutMs: 30_000 });
const deadline = Date.now() + 120_000;
let terminal;
let lastHistory;
while (Date.now() < deadline) {
  const history = await request('GET', `/v1/conversations/${conversationId}/history`, undefined, { timeoutMs: 10_000 });
  lastHistory = history;
  terminal = history.items?.findLast?.((item) => item.event === 'item_completed' && item.data?.item?.role === 'assistant');
  const completed = history.items?.some?.((item) => item.event === 'turn_completed');
  if (terminal || completed) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!terminal) {
  const exported = await request('GET', `/v1/pi/sessions/${encodeURIComponent(conversation.session_id)}/export`);
  throw new Error(`mock model turn did not finish: message=${JSON.stringify(message)}, history=${JSON.stringify(lastHistory)}, session=${JSON.stringify(exported)}`);
}
const assistant = terminal.data.item;
const terminalText = assistant.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '';
if (terminalText !== 'OK') {
  throw new Error(`unexpected mock model response: ${JSON.stringify(assistant)}`);
}
console.log('✓ real Pi model round trip accepted all extension tool schemas');

const ownershipPath = `/v1/pi/sessions/${encodeURIComponent(conversation.session_id)}/ownership`;
const claimed = await request('POST', `${ownershipPath}/claim`, { client_id: 'runtime-smoke-cli' });
if (claimed.state !== 'claimed' || !claimed.lease_token || claimed.evicted_idle !== true) {
  throw new Error(`interactive ownership claim did not evict the idle runtime: ${JSON.stringify(claimed)}`);
}
const leasedQuiescence = await request('GET', '/v1/admin/quiescence');
if (!leasedQuiescence.blockers?.some?.((blocker) => blocker.code === 'interactive_pi_sessions')) {
  throw new Error(`interactive Pi lease did not block deployment: ${JSON.stringify(leasedQuiescence)}`);
}
const blockedOpen = await fetch(base + '/v1/conversations/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pi_session_id: conversation.session_id }),
});
if (blockedOpen.status !== 409) {
  throw new Error(`agentd reopened a CLI-owned session: ${blockedOpen.status} ${await blockedOpen.text()}`);
}
await request('POST', `${ownershipPath}/heartbeat`, { lease_token: claimed.lease_token });
await request('POST', `${ownershipPath}/release`, { lease_token: claimed.lease_token });
await request('POST', '/v1/conversations/open', { pi_session_id: conversation.session_id });
console.log('✓ interactive Pi ownership evicts idle agentd, fences reopen, heartbeats, and blocks deploy');

const loaded = await request('GET', '/v1/admin/quiescence');
if (loaded.status === 'blocked') {
  throw new Error(`agentd unexpectedly blocked before drain: ${JSON.stringify(loaded)}`);
}
if ((loaded.loaded_conversations ?? 0) < 1) {
  throw new Error(`agentd did not report the loaded idle conversation: ${JSON.stringify(loaded)}`);
}
console.log(`✓ quiescence reports loaded idle conversation: status=${loaded.status}, loaded=${loaded.loaded_conversations}`);

const drained = await request('POST', '/v1/admin/drain', { timeout_ms: 30_000 });
if (drained.ok !== true) {
  throw new Error(`agentd drain failed: ${JSON.stringify(drained)}`);
}
console.log(`✓ agentd drain completed: status=${drained.status ?? 'unknown'}`);

const afterDrain = await request('GET', '/v1/admin/quiescence');
if (afterDrain.status !== 'safe_to_stop') {
  throw new Error(`agentd not safe to stop after drain: ${JSON.stringify(afterDrain)}`);
}
if ((afterDrain.loaded_conversations ?? 0) !== 0) {
  throw new Error(`agentd still has loaded conversations after drain: ${JSON.stringify(afterDrain)}`);
}
console.log('✓ agentd quiescence safe after drain');
NODE_SMOKE
endsection

section "Drain survives container replacement"
docker stop --time 30 "$CONTAINER_NAME" >/dev/null
docker rm "$CONTAINER_NAME" >/dev/null
CONTAINER_ID="$(docker run -d \
  --name "$CONTAINER_NAME" \
  --network "$SMOKE_NETWORK" \
  -p "127.0.0.1::${AGENTD_CONTAINER_PORT}" \
  -e HOME=/app \
  -e MEMSTORE_SOCKET="$MEMSTORE_SOCKET" \
  -e MEMSTORE_DATA_DIR="$MEMSTORE_DATA_DIR" \
  -e MONIKA_AGENTD_HOST=0.0.0.0 \
  -e MONIKA_AGENTD_PORT="$AGENTD_CONTAINER_PORT" \
  -e AGENTLOGS_HOME=/agentlogs-home \
  -e PI_SUBAGENT_EXECUTION_TARGET_ROOT=/runtime/secrets/ssh/targets \
  -e PI_SUBAGENT_SSH_LOCK_EXTENSION=/app/.pi/agent/extensions/ssh.ts \
  -v "$SMOKE_RUNTIME_SECRETS:/runtime/secrets:ro" \
  -v "$SMOKE_RUNTIME_DATA:/data" \
  "$IMAGE")"
AGENTD_PORT="$(docker port "$CONTAINER_NAME" "${AGENTD_CONTAINER_PORT}/tcp" | sed 's/.*://')"
for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${AGENTD_PORT}/healthz" >"$SMOKE_TMP_DIR/replacement-health.json" 2>/dev/null; then
    break
  fi
  sleep 1
done
if ! grep -q '"status":"draining"' "$SMOKE_TMP_DIR/replacement-health.json"; then
  echo "replacement agentd did not restore the deploy drain"
  cat "$SMOKE_TMP_DIR/replacement-health.json"
  exit 1
fi
CREATE_STATUS="$(curl -sS -o "$SMOKE_TMP_DIR/drained-create.json" -w '%{http_code}' \
  -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:${AGENTD_PORT}/v1/conversations")"
if [ "$CREATE_STATUS" != "503" ]; then
  echo "replacement agentd accepted new work while drained: HTTP $CREATE_STATUS"
  cat "$SMOKE_TMP_DIR/drained-create.json"
  exit 1
fi
curl -fsS -X POST "http://127.0.0.1:${AGENTD_PORT}/v1/admin/drain/cancel" >/dev/null
if ! curl -fsS "http://127.0.0.1:${AGENTD_PORT}/healthz" | grep -q '"status":"healthy"'; then
  echo "replacement agentd did not become healthy after drain cancellation"
  exit 1
fi
if [ -e "$SMOKE_RUNTIME_DATA/agentd-drain-state.json" ]; then
  echo "drain cancellation did not clear durable state"
  exit 1
fi
docker exec "$CONTAINER_NAME" test -f /app/.pi/agent/npm/.persistence-smoke
docker exec "$CONTAINER_NAME" test -f /app/.pi/agent/git/.persistence-smoke
docker exec -i "$CONTAINER_NAME" node - <<'NODE_PI_PACKAGE_RECREATION'
const fs = require('node:fs');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync('/app/.pi/agent/settings.json', 'utf8'));
if (settings.defaultModel !== 'gpt-5.6-sol') throw new Error('image-owned settings defaults were not restored');
const packageEntry = settings.packages.find((entry) => {
  const source = typeof entry === 'string' ? entry : entry?.source;
  return typeof source === 'string' && path.resolve('/app/.pi/agent', source) === '/data/pi-package-smoke';
});
if (!packageEntry || typeof packageEntry !== 'object') throw new Error('object-form deployment package choice was lost');
if (JSON.stringify(packageEntry.extensions) !== JSON.stringify(['extension.js'])) throw new Error('package extension filter was lost');
if (!Array.isArray(packageEntry.skills) || !Array.isArray(packageEntry.prompts) || !Array.isArray(packageEntry.themes)) {
  throw new Error('package resource filters were lost');
}
NODE_PI_PACKAGE_RECREATION
package_list="$(docker exec "$CONTAINER_NAME" pi list)"
printf '%s\n' "$package_list" | grep -F '/data/pi-package-smoke (filtered)' >/dev/null
rm -f "$SMOKE_RUNTIME_DATA/pi-package-smoke-loaded"
docker exec "$CONTAINER_NAME" pi -p /persistence-smoke >/dev/null
test -f "$SMOKE_RUNTIME_DATA/pi-package-smoke-loaded"
test -f "$SMOKE_RUNTIME_DATA/pi-agent-packages/settings.json.tmp.1"
test -f "$SMOKE_RUNTIME_DATA/pi-agent-packages/npm.tmp.1"
pass "replacement preserved filtered Pi package listing/loading and ignored stale temp siblings while refreshing image defaults"
endsection

section "Redeploy backup smoke"
SMOKE_DEPLOY_ROOT="$SMOKE_TMP_DIR/deploy-root"
MOCK_FORUM_PORT_FILE="$SMOKE_TMP_DIR/mock-forum-port"
MOCK_FORUM_CALLS_FILE="$SMOKE_TMP_DIR/mock-forum-calls"
mkdir -p \
  "$SMOKE_DEPLOY_ROOT/runtime/data" \
  "$SMOKE_DEPLOY_ROOT/runtime/secrets" \
  "$SMOKE_DEPLOY_ROOT/runtime/backups/redeploy" \
  "$SMOKE_DEPLOY_ROOT/out"
cat >"$SMOKE_DEPLOY_ROOT/compose.yaml" <<'COMPOSE_SMOKE'
services:
  monika:
    image: monika-smoke
  forum:
    image: forum-smoke
COMPOSE_SMOKE
printf 'secret-for-backup-smoke\n' >"$SMOKE_DEPLOY_ROOT/runtime/secrets/example.env"
printf 'excluded-backup-seed\n' >"$SMOKE_DEPLOY_ROOT/runtime/backups/redeploy/seed.txt"
printf 'excluded-output\n' >"$SMOKE_DEPLOY_ROOT/out/generated.txt"

MOCK_FORUM_PORT_FILE="$MOCK_FORUM_PORT_FILE" MOCK_FORUM_CALLS_FILE="$MOCK_FORUM_CALLS_FILE" node <<'NODE_FORUM' &
const fs = require('node:fs');
const http = require('node:http');

const portFile = process.env.MOCK_FORUM_PORT_FILE;
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer smoke-deploy-token') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'unauthorized' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/deploy/admission/acquire') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const operationId = JSON.parse(body).operationId;
      fs.appendFileSync(process.env.MOCK_FORUM_CALLS_FILE, 'acquire\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        acquired: true,
        operationId,
        state: 'acquired',
        blockers: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/deploy/admission/cancel') {
    fs.appendFileSync(process.env.MOCK_FORUM_CALLS_FILE, 'cancel\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, released: true, operationId: 'smoke-deploy-operation' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
NODE_FORUM
MOCK_FORUM_PID=$!
for _ in {1..50}; do
  if [ -s "$MOCK_FORUM_PORT_FILE" ]; then
    break
  fi
  sleep 0.1
done
if [ ! -s "$MOCK_FORUM_PORT_FILE" ]; then
  echo "mock forum did not start"
  exit 1
fi
MOCK_FORUM_PORT="$(cat "$MOCK_FORUM_PORT_FILE")"

MONIKA_DEPLOY_ROOT="$SMOKE_DEPLOY_ROOT" \
MONIKA_DEPLOY_BACKUP_DIR="$SMOKE_DEPLOY_ROOT/runtime/backups/redeploy" \
MONIKA_DEPLOY_REQUIRE_GIT_CURRENT=0 \
MONIKA_DEPLOY_BACKUP_COMPRESSION=gzip \
MONIKA_AGENTD_BASE_URL="http://127.0.0.1:${AGENTD_PORT}" \
MONIKA_FORUM_BASE_URL="http://127.0.0.1:${MOCK_FORUM_PORT}/api" \
MONIKA_FORUM_DEPLOY_TOKEN="smoke-deploy-token" \
./scripts/deploy-if-safe --backup-only
if [ "$(grep -c '^acquire$' "$MOCK_FORUM_CALLS_FILE" || true)" -ne 1 ] ||
  [ "$(grep -c '^cancel$' "$MOCK_FORUM_CALLS_FILE" || true)" -ne 1 ]; then
  echo "backup-only deploy did not explicitly acquire and cancel the surviving forum lease"
  cat "$MOCK_FORUM_CALLS_FILE"
  exit 1
fi

mapfile -t archives < <(find "$SMOKE_DEPLOY_ROOT/runtime/backups/redeploy" -maxdepth 1 -type f -name 'monika-redeploy-*.tar.gz' | sort)
if [ "${#archives[@]}" -ne 1 ]; then
  printf 'expected exactly one gzip redeploy archive, found %s\n' "${#archives[@]}"
  find "$SMOKE_DEPLOY_ROOT/runtime/backups/redeploy" -maxdepth 1 -type f -print
  exit 1
fi
gzip -t "${archives[0]}"
tar -tf "${archives[0]}" >"$SMOKE_TMP_DIR/archive-list.txt"
grep -qx 'deploy-root/compose.yaml' "$SMOKE_TMP_DIR/archive-list.txt"
grep -qx 'deploy-root/runtime/secrets/example.env' "$SMOKE_TMP_DIR/archive-list.txt"
if grep -q 'deploy-root/runtime/backups/' "$SMOKE_TMP_DIR/archive-list.txt"; then
  echo "archive unexpectedly includes runtime/backups"
  exit 1
fi
if grep -q 'deploy-root/out/' "$SMOKE_TMP_DIR/archive-list.txt"; then
  echo "archive unexpectedly includes out/"
  exit 1
fi
pass "deploy-if-safe backup-only created verified gzip archive"
info "archive: ${archives[0]}"
endsection

section "Clean shutdown"
docker stop --time 30 "$CONTAINER_NAME" >/dev/null
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME")"
if [ "$EXIT_CODE" != "0" ]; then
  echo "Expected clean container shutdown exit code 0, got $EXIT_CODE"
  exit 1
fi
pass "container stopped cleanly with exit code 0"
endsection

section "Essential child supervision"
SUPERVISION_CONTAINER="${CONTAINER_NAME}-supervision"
docker run -d \
  --name "$SUPERVISION_CONTAINER" \
  --network "$SMOKE_NETWORK" \
  -e HOME=/app \
  -e MEMSTORE_SOCKET="$MEMSTORE_SOCKET" \
  -e MEMSTORE_DATA_DIR="$MEMSTORE_DATA_DIR" \
  -e MONIKA_AGENTD_HOST=0.0.0.0 \
  -e MONIKA_AGENTD_PORT="$AGENTD_CONTAINER_PORT" \
  -e AGENTLOGS_HOME=/agentlogs-home \
  -v "$SMOKE_RUNTIME_SECRETS:/runtime/secrets:ro" \
  "$IMAGE" >/dev/null
for _ in {1..60}; do
  if docker exec "$SUPERVISION_CONTAINER" test -S "$MEMSTORE_SOCKET" 2>/dev/null \
    && docker exec "$SUPERVISION_CONTAINER" node -e "fetch('http://127.0.0.1:7724/healthz').then(r=>{if(!r.ok)process.exit(1)})" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$SUPERVISION_CONTAINER" sh -lc "kill \$(pgrep -f '/opt/agentd/src/server.mjs' | head -1)"
for _ in {1..30}; do
  [ "$(docker inspect -f '{{.State.Running}}' "$SUPERVISION_CONTAINER")" = "false" ] && break
  sleep 1
done
if [ "$(docker inspect -f '{{.State.Running}}' "$SUPERVISION_CONTAINER")" != "false" ]; then
  echo "container remained running after agentd exited"
  exit 1
fi
SUPERVISION_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$SUPERVISION_CONTAINER")"
if [ "$SUPERVISION_EXIT" = "0" ]; then
  echo "expected nonzero container exit after essential agentd death"
  exit 1
fi
pass "agentd death stopped the runtime with nonzero exit"
docker rm -fv "$SUPERVISION_CONTAINER" >/dev/null
SUPERVISION_CONTAINER="${CONTAINER_NAME}-memstore-supervision"
docker run -d \
  --name "$SUPERVISION_CONTAINER" \
  --network "$SMOKE_NETWORK" \
  -e HOME=/app \
  -e MEMSTORE_SOCKET="$MEMSTORE_SOCKET" \
  -e MEMSTORE_DATA_DIR="$MEMSTORE_DATA_DIR" \
  -e MONIKA_AGENTD_HOST=0.0.0.0 \
  -e MONIKA_AGENTD_PORT="$AGENTD_CONTAINER_PORT" \
  -e AGENTLOGS_HOME=/agentlogs-home \
  -v "$SMOKE_RUNTIME_SECRETS:/runtime/secrets:ro" \
  "$IMAGE" >/dev/null
for _ in {1..60}; do
  docker exec "$SUPERVISION_CONTAINER" test -S "$MEMSTORE_SOCKET" 2>/dev/null && break
  sleep 1
done
docker exec "$SUPERVISION_CONTAINER" sh -lc "kill \$(pgrep -x memstore | head -1)"
for _ in {1..30}; do
  [ "$(docker inspect -f '{{.State.Running}}' "$SUPERVISION_CONTAINER")" = "false" ] && break
  sleep 1
done
if [ "$(docker inspect -f '{{.State.Running}}' "$SUPERVISION_CONTAINER")" != "false" ] \
  || [ "$(docker inspect -f '{{.State.ExitCode}}' "$SUPERVISION_CONTAINER")" = "0" ]; then
  echo "runtime did not fail closed after memstore exited"
  exit 1
fi
pass "memstore death stopped the runtime with nonzero exit"
endsection

echo "Monika runtime smoke test passed."
