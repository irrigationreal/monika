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
pass "pi CLI available: ${PI_VERSION}"

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

const closed = await request('POST', `/v1/conversations/${conversationId}/close`, {});
if (closed.ok !== true) {
  throw new Error(`conversation close failed: ${JSON.stringify(closed)}`);
}
console.log('✓ conversation closed cleanly');
NODE_SMOKE
endsection

echo "Monika runtime smoke test passed."
