#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORUM_DIR="$ROOT_DIR/services/forum"
UPLOADS_DIR="${CODEX_FORUM_UPLOADS_DIR:-${RUNNER_TEMP:-/tmp}/codex-forum-test-uploads}"

mkdir -p "$UPLOADS_DIR"
cd "$FORUM_DIR"

pnpm() {
  corepack pnpm@11.21.0 "$@"
}
pnpm install --frozen-lockfile
pnpm exec node --test "$ROOT_DIR/tests/forum/dependency-compatibility.mjs"

CODEX_FORUM_UPLOADS_DIR="$UPLOADS_DIR" pnpm -r test
