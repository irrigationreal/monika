#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORUM_DIR="$ROOT_DIR/services/forum"
APP_DIR="$FORUM_DIR/apps/codex-forum"
UPLOADS_DIR="${CODEX_FORUM_UPLOADS_DIR:-${RUNNER_TEMP:-/tmp}/codex-forum-test-uploads}"

mkdir -p "$UPLOADS_DIR"
cd "$FORUM_DIR"

pnpm() {
  corepack pnpm@11.21.0 "$@"
}
pnpm install --frozen-lockfile

cd "$APP_DIR"
if [[ "${CI:-}" == "true" ]]; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

CODEX_FORUM_UPLOADS_DIR="$UPLOADS_DIR" pnpm exec playwright test --reporter=line
