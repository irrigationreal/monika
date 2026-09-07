#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if [[ ! -d "$ROOT/services/agentd/node_modules" || ! -d "$ROOT/services/forum/node_modules" ]]; then
  echo "fork-boundary integration test requires frozen installs for services/agentd and services/forum" >&2
  exit 1
fi

cd "$ROOT/services/forum"
pnpm exec tsx --test "$ROOT/tests/integration/fork-boundary-contract.test.ts"
