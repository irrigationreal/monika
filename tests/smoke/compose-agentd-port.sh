#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT_DIR/compose.yaml.example"

# Compose has one fixed service port. The legacy variable remains solely on the
# host side of the published-port mapping.
grep -Fq '127.0.0.1:${MONIKA_AGENTD_PORT:-7724}:7724' "$COMPOSE"
grep -Fq 'MONIKA_AGENTD_PORT: "7724"' "$COMPOSE"
grep -Fq 'http://127.0.0.1:7724/healthz' "$COMPOSE"
grep -Fq 'MONIKA_AGENTD_BASE_URL: http://monika:7724' "$COMPOSE"
grep -Fq 'http://127.0.0.1:${MONIKA_AGENTD_PORT:-7724}' "$ROOT_DIR/scripts/deploy-if-safe"

if grep -F 'healthcheck:' -A2 "$COMPOSE" | grep -Fq '$${MONIKA_AGENTD_PORT'; then
  echo 'Compose healthcheck must not use the host published-port override internally' >&2
  exit 1
fi

echo 'compose agentd port smoke passed'
