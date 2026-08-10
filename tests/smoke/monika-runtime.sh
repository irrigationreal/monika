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

# Deterministic SSH checks use pure state/fake transports; mandatory image
# smoke never contacts an external SSH host.
node --test \
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

CONTAINER_NAME="${MONIKA_SMOKE_CONTAINER:-monika-smoke-$$}"
AGENTD_CONTAINER_PORT="7724"
MEMSTORE_SOCKET="/tmp/memstore.sock"
MEMSTORE_DATA_DIR="/data/memstore"
SMOKE_TMP_DIR=""
MOCK_FORUM_PID=""
MOCK_MODEL_CONTAINER=""
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
  fi
  if [ -n "$MOCK_FORUM_PID" ]; then
    kill "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
    wait "$MOCK_FORUM_PID" >/dev/null 2>&1 || true
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ -n "$MOCK_MODEL_CONTAINER" ]; then
    docker rm -f "$MOCK_MODEL_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_NETWORK" ]; then
    docker network rm "$SMOKE_NETWORK" >/dev/null 2>&1 || true
  fi
  if [ -n "$SMOKE_TMP_DIR" ]; then
    rm -rf "$SMOKE_TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

SMOKE_TMP_DIR="$(mktemp -d)"
SMOKE_RUNTIME_SECRETS="$SMOKE_TMP_DIR/runtime-secrets"
SMOKE_NETWORK="monika-smoke-net-$$"
MOCK_MODEL_CONTAINER="monika-mock-model-$$"
mkdir -p "$SMOKE_RUNTIME_SECRETS/ssh/targets"
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
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
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
LICENSE_DIR=/usr/share/licenses/monika
for file in LICENSE THIRD_PARTY_NOTICES.md; do
  if ! docker exec "$CONTAINER_NAME" test -s "$LICENSE_DIR/$file"; then
    echo "$file missing or empty from $LICENSE_DIR"
    exit 1
  fi
done
docker exec "$CONTAINER_NAME" grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" "$LICENSE_DIR/LICENSE"
pass "project AGPL license and third-party notices present"
OCI_LICENSE=$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "$CONTAINER_NAME")
if [ "$OCI_LICENSE" != "AGPL-3.0-or-later" ]; then
  echo "Unexpected OCI license label: ${OCI_LICENSE:-<unset>}"
  exit 1
fi
pass "OCI license label is AGPL-3.0-or-later"

PI_VERSION="$(docker exec "$CONTAINER_NAME" pi --version 2>&1)"
if [ "$PI_VERSION" != "0.82.1" ]; then
  echo "Expected Pi 0.82.1, got: $PI_VERSION"
  exit 1
fi
pass "pi CLI pin active: ${PI_VERSION}"

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
const foregroundSource = fs.readFileSync('/opt/pi-subagents/src/runs/foreground/execution.ts', 'utf8');
const typesSource = fs.readFileSync('/opt/pi-subagents/src/shared/types.ts', 'utf8');
const preflightSource = fs.readFileSync('/opt/pi-subagents/src/api/preflight.ts', 'utf8');
if (!fs.existsSync('/opt/pi-subagents/src/runs/shared/execution-target.ts')) throw new Error('Execution-target runtime missing');
if (!fs.existsSync('/app/.pi/agent/extensions/ssh-lock.mjs')) throw new Error('Locked SSH helper missing');
if (!fs.existsSync('/app/.pi/agent/extensions/ssh-relocate.mjs')) throw new Error('Relocate state-machine helper missing');
if (!typesSource.includes('SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 4')) throw new Error('Lifecycle v4 missing');
if (!preflightSource.includes('SUBAGENT_LAUNCH_CONTRACT_VERSION = 3')) throw new Error('Launch contract v3 missing');
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

section "Redeploy backup smoke"
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
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME")"
if [ "$EXIT_CODE" != "0" ]; then
  echo "Expected clean container shutdown exit code 0, got $EXIT_CODE"
  exit 1
fi
pass "container stopped cleanly with exit code 0"
endsection

echo "Monika runtime smoke test passed."
