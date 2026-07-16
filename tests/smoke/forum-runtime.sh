#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: tests/smoke/forum-runtime.sh <image>

Smoke-test a forum runtime image in standalone mode.

The test starts an isolated throwaway container, waits for /healthz, verifies
static frontend serving, checks that representative dev-only packages (vitest,
vite, typescript, eslint, playwright) are absent from node_modules, and confirms
runtime-critical packages (tsx, fastify, better-sqlite3, sharp) are present.
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

CONTAINER_NAME="${FORUM_SMOKE_CONTAINER:-forum-smoke-$$}"
CONTAINER_PORT="4310"
HOST_PORT=""

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
fail() { printf '✗ %s\n' "$1"; }
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

# ── Start container ──────────────────────────────────────────────────────────

section "Start forum container"
info "Image: $IMAGE"
info "Container: $CONTAINER_NAME"

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
CONTAINER_ID="$(docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1::${CONTAINER_PORT}" \
  -e MONIKA_AGENTD_BASE_URL=http://localhost:9999 \
  -e CODEX_WORK_DIR=/var/lib/codex-forum \
  "$IMAGE")"
HOST_PORT="$(docker port "$CONTAINER_NAME" "${CONTAINER_PORT}/tcp" | sed 's/.*://')"
if [ -z "$HOST_PORT" ]; then
  fail "Could not determine published forum port"
  exit 1
fi

pass "Container started (${CONTAINER_ID:0:12})"
endsection

# ── Wait for healthz ────────────────────────────────────────────────────────

section "Wait for /healthz"
ATTEMPTS=0
MAX_ATTEMPTS=30
while [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; do
  if curl -sf "http://localhost:${HOST_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 1
done

if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
  fail "/healthz did not respond within ${MAX_ATTEMPTS}s"
  exit 1
fi

HEALTH_BODY=$(curl -sf "http://localhost:${HOST_PORT}/healthz")
if echo "$HEALTH_BODY" | grep -q '"ok":true'; then
  pass "/healthz returns {\"ok\":true} (${ATTEMPTS}s)"
else
  fail "/healthz returned unexpected body: $HEALTH_BODY"
  exit 1
fi
endsection

# ── Verify static frontend ─────────────────────────────────────────────────

section "Verify static frontend"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:${HOST_PORT}/")
if [ "$HTTP_CODE" = "200" ]; then
  pass "GET / returns 200"
else
  fail "GET / returned $HTTP_CODE (expected 200)"
  exit 1
fi

INDEX_HTML=$(curl -sf "http://localhost:${HOST_PORT}/")
if echo "$INDEX_HTML" | grep -q '<!doctype html>'; then
  pass "GET / serves HTML document"
else
  fail "GET / did not return HTML"
  exit 1
fi
endsection

# ── Verify dev packages absent ──────────────────────────────────────────────

section "Verify dev packages absent"
ERRORS=0
for pkg in vitest vite typescript eslint prettier vue-tsc playwright husky lint-staged; do
  if docker exec "$CONTAINER_NAME" sh -c \
    "find node_modules/.pnpm -mindepth 1 -maxdepth 1 -name '${pkg}@*' -print -quit | grep -q ."; then
    fail "$pkg found in the pnpm store (should be absent)"
    ERRORS=$((ERRORS + 1))
  else
    pass "$pkg absent"
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  fail "$ERRORS dev package(s) leaked into production image"
  exit 1
fi
endsection

# ── Verify runtime packages present ────────────────────────────────────────

section "Verify runtime packages present"
ERRORS=0
for pkg in tsx fastify better-sqlite3 sharp; do
  if docker exec "$CONTAINER_NAME" test -d "node_modules/$pkg" 2>/dev/null; then
    pass "$pkg present"
  else
    fail "$pkg NOT found in node_modules (required at runtime)"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  fail "$ERRORS runtime package(s) missing from production image"
  exit 1
fi
endsection

# ── Verify workspace packages present ──────────────────────────────────────

section "Verify workspace packages present"
ERRORS=0
for pkg in codex-forum-core codex-forum-contracts codex-forum-adapters; do
  if docker exec "$CONTAINER_NAME" test -f "node_modules/@irrigationreal/$pkg/src/index.ts" 2>/dev/null; then
    pass "@irrigationreal/$pkg present with source"
  else
    fail "@irrigationreal/$pkg missing or has no source files"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  fail "$ERRORS workspace package(s) missing from production image"
  exit 1
fi
endsection

# ── Verify build toolchain absent ───────────────────────────────────────────

section "Verify build toolchain absent from runtime"
# In a pruned image, python3/make/g++ should not be installed
ERRORS=0
for tool in python3 make g++; do
  if docker exec "$CONTAINER_NAME" which "$tool" >/dev/null 2>&1; then
    fail "$tool found in runtime image (should be absent)"
    ERRORS=$((ERRORS + 1))
  else
    pass "$tool absent from runtime"
  fi
done

# pnpm should not be needed in the runtime
if docker exec "$CONTAINER_NAME" sh -c "command -v pnpm" >/dev/null 2>&1; then
  fail "pnpm found in runtime image (not needed)"
  ERRORS=$((ERRORS + 1))
else
  pass "pnpm absent from runtime"
fi

if [ "$ERRORS" -gt 0 ]; then
  fail "$ERRORS build tool(s) leaked into the runtime image"
  exit 1
fi
endsection

# ── Verify native modules work ──────────────────────────────────────────────

section "Verify native modules"
SQLITE_CHECK=$(docker exec "$CONTAINER_NAME" node -e "
  try {
    require('better-sqlite3');
    console.log('ok');
  } catch(e) {
    console.log('fail: ' + e.message);
  }
" 2>&1)
if [ "$SQLITE_CHECK" = "ok" ]; then
  pass "better-sqlite3 loads successfully"
else
  fail "better-sqlite3 failed to load: $SQLITE_CHECK"
  exit 1
fi

SHARP_CHECK=$(docker exec "$CONTAINER_NAME" node -e "
  try {
    require('sharp');
    console.log('ok');
  } catch(e) {
    console.log('fail: ' + e.message);
  }
" 2>&1)
if [ "$SHARP_CHECK" = "ok" ]; then
  pass "sharp loads successfully"
else
  fail "sharp failed to load: $SHARP_CHECK"
  exit 1
fi
endsection

# ── Summary ─────────────────────────────────────────────────────────────────

section "Summary"
IMAGE_SIZE=$(docker images "$IMAGE" --format '{{.Size}}' 2>/dev/null | head -1)
info "Image size: ${IMAGE_SIZE:-unknown}"
pass "All forum runtime smoke checks passed"
endsection
