#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: tests/smoke/monika-runtime.sh <image>

Smoke-test a Monika runtime image in standalone mode.

The test starts an isolated throwaway container, waits for memstore and agentd,
checks the Pi CLI, then creates and closes an agentd conversation without making
an LLM call.
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  usage >&2
  exit 2
fi

CONTAINER_NAME="${MONIKA_SMOKE_CONTAINER:-monika-smoke-$$}"
AGENTD_CONTAINER_PORT="7724"
MEMSTORE_SOCKET="/tmp/memstore.sock"
MEMSTORE_DATA_DIR="/data/memstore"
SMOKE_TMP_DIR=""
MOCK_FORUM_PID=""
CONTAINER_STOPPED=0

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
  fi
  if [ -n "$MOCK_FORUM_PID" ]; then
    kill "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
    wait "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_TMP_DIR" ]; then
    rm -rf "$SMOKE_TMP_DIR"
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

section "Start standalone runtime"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
CONTAINER_ID="$(docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1::${AGENTD_CONTAINER_PORT}" \
  -e HOME=/app \
  -e MEMSTORE_SOCKET="$MEMSTORE_SOCKET" \
  -e MEMSTORE_DATA_DIR="$MEMSTORE_DATA_DIR" \
  -e MONIKA_AGENTD_HOST=0.0.0.0 \
  -e MONIKA_AGENTD_PORT="$AGENTD_CONTAINER_PORT" \
  -e AGENTLOGS_HOME=/agentlogs-home \
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

section "Runtime checks"
PI_VERSION="$(docker exec "$CONTAINER_NAME" pi --version 2>&1)"
if [ "$PI_VERSION" != "0.80.7" ]; then
  echo "Expected Pi 0.80.7, got: $PI_VERSION"
  exit 1
fi
pass "pi CLI pin active: ${PI_VERSION}"

PI_TRUST_TARGET="$(docker exec "$CONTAINER_NAME" readlink /app/.pi/agent/trust.json)"
if [ "$PI_TRUST_TARGET" != "/data/pi-agent-trust/trust.json" ]; then
  echo "Expected persistent Pi trust state link, got: ${PI_TRUST_TARGET:-<not a symlink>}"
  exit 1
fi
docker exec "$CONTAINER_NAME" node -e "JSON.parse(require('fs').readFileSync('/data/pi-agent-trust/trust.json', 'utf8'))"
pass "Pi project-trust state persists under /data"

NPM_MIN_RELEASE_AGE="$(docker exec "$CONTAINER_NAME" npm config get min-release-age)"
if [ "$NPM_MIN_RELEASE_AGE" != "10" ]; then
  echo "Expected npm min-release-age=10, got: $NPM_MIN_RELEASE_AGE"
  exit 1
fi
pass "npm dependency cooldown active: ${NPM_MIN_RELEASE_AGE} days"

PNPM_VERSION="$(docker exec "$CONTAINER_NAME" pnpm --version)"
if [ "$PNPM_VERSION" != "10.26.2" ]; then
  echo "Expected pnpm 10.26.2, got: $PNPM_VERSION"
  exit 1
fi
pass "agentd package manager available: pnpm ${PNPM_VERSION}"

PNPM_MIN_RELEASE_AGE="$(docker exec "$CONTAINER_NAME" pnpm config get minimumReleaseAge)"
if [ "$PNPM_MIN_RELEASE_AGE" != "14400" ]; then
  echo "Expected pnpm minimumReleaseAge=14400, got: $PNPM_MIN_RELEASE_AGE"
  exit 1
fi
pass "pnpm dependency cooldown active: 10 days"

AGENT_BROWSER_VERSION="$(docker exec "$CONTAINER_NAME" agent-browser --version)"
if [ "$AGENT_BROWSER_VERSION" != "agent-browser 0.31.1" ]; then
  echo "Expected agent-browser 0.31.1, got: $AGENT_BROWSER_VERSION"
  exit 1
fi
pass "agent-browser pin active: ${AGENT_BROWSER_VERSION}"

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

const created = await request('POST', '/v1/conversations', { cwd: '/tmp' }, { attempts: 2, timeoutMs: 60_000 });
const conversation = created?.conversation ?? {};
const conversationId = conversation.id ?? conversation.conversation_id ?? conversation.session_id;
if (!conversationId) {
  throw new Error(`conversation creation did not return an id: ${JSON.stringify(created)}`);
}
console.log(`✓ conversation created: ${conversationId}`);
console.log(`  cwd: ${conversation.cwd ?? '/tmp'}`);
console.log(`  model: ${conversation.model ?? 'unknown'}`);
console.log(`  session: ${conversation.session_path ?? '(not reported)'}`);

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

section "Redeploy backup smoke"
SMOKE_TMP_DIR="$(mktemp -d)"
SMOKE_DEPLOY_ROOT="$SMOKE_TMP_DIR/deploy-root"
MOCK_FORUM_PORT_FILE="$SMOKE_TMP_DIR/mock-forum-port"
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

MOCK_FORUM_PORT_FILE="$MOCK_FORUM_PORT_FILE" node <<'NODE_FORUM' &
const fs = require('node:fs');
const http = require('node:http');

const portFile = process.env.MOCK_FORUM_PORT_FILE;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/deploy/quiescence') {
    if (req.headers.authorization !== 'Bearer smoke-deploy-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ safeToStop: true, blockers: [] }));
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
CONTAINER_STOPPED=1
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME")"
if [ "$EXIT_CODE" != "0" ]; then
  echo "Expected clean container shutdown exit code 0, got $EXIT_CODE"
  exit 1
fi
pass "container stopped cleanly with exit code 0"
endsection

echo "Monika runtime smoke test passed."
