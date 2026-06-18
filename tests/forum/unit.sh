#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORUM_DIR="$ROOT_DIR/services/forum"
UPLOADS_DIR="${CODEX_FORUM_UPLOADS_DIR:-${RUNNER_TEMP:-/tmp}/codex-forum-test-uploads}"

mkdir -p "$UPLOADS_DIR"
cd "$FORUM_DIR"

corepack enable
corepack prepare pnpm@10.26.2 --activate >/dev/null
pnpm install --frozen-lockfile

CODEX_FORUM_UPLOADS_DIR="$UPLOADS_DIR" pnpm -r test
