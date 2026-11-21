#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: tests/smoke/subagents-ssh.sh <candidate-image>

Run a real locked-SSH/effects probe against a candidate Monika runtime image.
The probe builds a disposable sshd image FROM the candidate, creates a private
Docker network, and never uses host SSH credentials or live deployment state.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
IMAGE=${1:-}
if [[ -z "$IMAGE" ]]; then
  usage >&2
  exit 2
fi

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is required" >&2; exit 2; }

ROOT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/monika-subagents-ssh.XXXXXX")
NETWORK="monika-subagents-ssh-${BASHPID}"
TARGET_CONTAINER="monika-subagents-ssh-target-${BASHPID}"
TARGET_IMAGE="monika-subagents-ssh-target:${BASHPID}"
LOCAL_DIR="$ROOT_DIR/local"
SECRETS_DIR="$ROOT_DIR/secrets"
TARGETS_DIR="$SECRETS_DIR/targets"
EVIDENCE_DIR="$ROOT_DIR/evidence"
mkdir -p "$LOCAL_DIR" "$TARGETS_DIR" "$EVIDENCE_DIR"
printf '%s\n' 'local sentinel must remain unchanged' > "$LOCAL_DIR/sentinel.txt"
chmod 600 "$LOCAL_DIR/sentinel.txt"

cleanup() {
  local status=$?
  docker rm -f "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$TARGET_IMAGE" >/dev/null 2>&1 || true
  docker run --rm --entrypoint chown -v "$ROOT_DIR:/cleanup" "$IMAGE" -R "$(id -u):$(id -g)" /cleanup >/dev/null 2>&1 || true
  rm -rf "$ROOT_DIR"
  exit "$status"
}
trap cleanup EXIT

# This key is generated for this invocation and is not copied from the host's
# SSH configuration. Only the public half enters the throwaway sshd container.
ssh-keygen -q -t ed25519 -N '' -f "$ROOT_DIR/client_key"
chmod 600 "$ROOT_DIR/client_key"
chmod 644 "$ROOT_DIR/client_key.pub"

# Build sshd from the exact candidate image so the client and target exercise
# the same libc/OpenSSH generation without modifying the candidate image.
docker build --pull=false --build-arg BASE_IMAGE="$IMAGE" -t "$TARGET_IMAGE" -f - . <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /root/.ssh /probe \
    && chmod 700 /root/.ssh
DOCKERFILE

docker network create --internal "$NETWORK" >/dev/null

docker run -d --rm --name "$TARGET_CONTAINER" --hostname ssh-target \
  --network "$NETWORK" \
  --entrypoint sh \
  -v "$ROOT_DIR/client_key.pub:/run/monika-authorized-key:ro" \
  "$TARGET_IMAGE" -eu -c '
    install -m 700 -d /root/.ssh /run/sshd /probe
    install -m 600 /run/monika-authorized-key /root/.ssh/authorized_keys
    ssh-keygen -A >/dev/null
    exec /usr/sbin/sshd -D -e -p 22
  ' >/dev/null

# Obtain only the target container's ephemeral host key. The key is registered
# read-only below the locked descriptor's administrator-only secret root.
for _ in {1..40}; do
  if docker exec "$TARGET_CONTAINER" ssh-keyscan -T 1 -H -t ed25519 ssh-target 2>/dev/null > "$SECRETS_DIR/known_hosts" \
    && [[ -s "$SECRETS_DIR/known_hosts" ]]; then
    break
  fi
  sleep 0.1
done
[[ -s "$SECRETS_DIR/known_hosts" ]] || { echo 'timed out waiting for disposable sshd host key' >&2; exit 1; }
chmod 444 "$SECRETS_DIR/known_hosts"

cat > "$TARGETS_DIR/target.json" <<'JSON'
{"version":1,"name":"target","target":"root@ssh-target","hostname":"ssh-target","cwd":"/probe","allowedRoot":"/probe","knownHosts":"/runtime/secrets/ssh/known_hosts"}
JSON
chmod 444 "$TARGETS_DIR/target.json"

# The candidate client runs the real locked extension and the installed
# execution-target resolver. A tiny in-container registration shim is used
# only to capture and invoke the extension's real registered tools; no fake SSH
# or fake effects implementation is involved.
docker run --rm -i --name "monika-subagents-ssh-client-${BASHPID}" \
  --network "$NETWORK" \
  --entrypoint node \
  -w /local \
  -e MONIKA_SSH_LOCK_DESCRIPTOR=/runtime/secrets/ssh/targets/target.json \
  -e PI_SUBAGENT_EXECUTION_TARGET_NAME=target \
  -e PI_SUBAGENT_EXECUTION_TARGET_ROOT=/runtime/secrets/ssh/targets \
  -e PI_SUBAGENT_SSH_LOCK_EXTENSION=/app/.pi/agent/extensions/ssh.ts \
  -e PI_SUBAGENT_EFFECTS_EVIDENCE_PATH=/run/probe/effects.jsonl \
  -v "$SECRETS_DIR:/runtime/secrets/ssh:ro" \
  -v "$ROOT_DIR/client_key:/root/.ssh/id_ed25519:ro" \
  -v "$LOCAL_DIR:/local:rw" \
  -v "$EVIDENCE_DIR:/run/probe:rw" \
  "$IMAGE" --experimental-strip-types --input-type=module - <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
// Native ESM bypasses Pi’s extension loader dependency aliases.
fs.symlinkSync("/opt/pi-cli/node_modules", "/app/node_modules", "dir");

const extensionPath = "/app/.pi/agent/extensions/ssh.ts";
const targetModule = "/opt/pi-subagents/src/runs/shared/execution-target.ts";
const {
  assertExecutionTargetAsyncCompatible,
  aggregateEffectsStates,
  executionTargetChildLaunch,
  resolveEffectsEvidenceState,
  resolveExecutionTarget,
} = await import(targetModule);
const { lockCodeDigest } = await import("/app/.pi/agent/extensions/ssh-lock.mjs");
process.env.PI_SUBAGENT_SSH_LOCK_CODE_DIGEST = lockCodeDigest(extensionPath);

const env = { ...process.env };
delete env.MONIKA_SSH_LOCK_DESCRIPTOR;
const resolved = resolveExecutionTarget({ kind: "ssh", name: "target" }, env);
assert.equal(resolved.kind, "ssh");
assert.deepEqual(resolved.public, { kind: "ssh", name: "target" });
assert.equal(resolved.descriptor.cwd, "/probe");
assert.equal(resolved.descriptor.allowedRoot, "/probe");
assert.match(resolved.descriptorDigest, /^[a-f0-9]{64}$/);

const evidencePath = process.env.PI_SUBAGENT_EFFECTS_EVIDENCE_PATH;
const launch = executionTargetChildLaunch(resolved, evidencePath);
assert.deepEqual(launch.extensions, [extensionPath]);
assert.equal(launch.env.MONIKA_SSH_LOCK_DESCRIPTOR, resolved.descriptorPath);
assert.equal(launch.env.PI_SUBAGENT_EXECUTION_TARGET_NAME, "target");
assert.equal(launch.env.PI_SUBAGENT_EXECUTION_TARGET_DIGEST, resolved.descriptorDigest);
assert.match(launch.env.PI_SUBAGENT_SSH_LOCK_CODE_DIGEST, /^[a-f0-9]{64}$/);
for (const [key, value] of Object.entries(launch.env)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

class ProbePi {
  constructor() { this.tools = []; this.handlers = new Map(); }
  registerTool(tool) { this.tools.push(tool); }
  on(event, handler) { this.handlers.set(event, handler); }
}
const pi = new ProbePi();
const { default: sshExtension } = await import(`file://${extensionPath}`);
sshExtension(pi);
assert.ok(!pi.tools.some((tool) => tool.name === "relocate"), "locked mode must not register relocate");
const names = new Set(pi.tools.map((tool) => tool.name));
for (const required of ["read", "write", "bash"]) assert.ok(names.has(required), `missing registered ${required} tool`);
const sessionStart = pi.handlers.get("session_start");
assert.ok(sessionStart, "locked extension must register session_start verification");
await sessionStart({}, { cwd: "/local", ui: {} });

function tool(name) {
  const found = pi.tools.find((item) => item.name === name);
  assert.ok(found, `registered tool ${name} is required`);
  return found;
}
function text(result) {
  return (result?.content ?? []).map((item) => item?.text ?? "").join("\n");
}

const write = tool("write");
const read = tool("read");
const bash = tool("bash");
const writeResult = await write.execute("write-remote", { path: "/probe/remote.txt", content: "written through locked ssh\n" });
assert.equal(writeResult.isError, undefined, text(writeResult));
assert.equal(writeResult.details.backend, "locked_ssh");
const readResult = await read.execute("read-remote", { path: "/probe/remote.txt" });
assert.equal(readResult.isError, undefined, text(readResult));
assert.match(text(readResult), /written through locked ssh/);

// Abort a real remote mutation after its command has started. The extension
// must record unknown effects rather than claiming failure is proof of no-op.
const abort = new AbortController();
const interrupted = bash.execute(
  "bash-uncertain",
  { command: "printf 'uncertain remote mutation\\n' > /probe/uncertain.txt; sleep 30", timeout: 10 },
  abort.signal,
  () => {},
);
setTimeout(() => abort.abort(), 1000);
const interruptedResult = await interrupted;
assert.equal(interruptedResult.isError, true, text(interruptedResult));
assert.match(text(interruptedResult), /ssh_transport_ambiguous|Command aborted/);
const evidence = fs.readFileSync(evidencePath, "utf8");
assert.match(evidence, /"effects_state":"unknown"/);
assert.equal(resolveEffectsEvidenceState(resolved, evidencePath), "unknown");
assert.equal(aggregateEffectsStates(["unknown"]), "unknown", "quiescence must remain blocked by unknown remote effects");

// A missing registry entry is a hard rejection, not permission to route local.
assert.throws(
  () => resolveExecutionTarget({ kind: "ssh", name: "missing" }, env),
  /ENOENT|missing|target|registry/i,
);
assert.throws(
  () => assertExecutionTargetAsyncCompatible([{ kind: "ssh", name: "target" }], false),
  /require async:true/,
);
assert.doesNotThrow(() => assertExecutionTargetAsyncCompatible([{ kind: "ssh", name: "target" }], true));

// Ensure the mounted local workspace was not used as a fallback backend.
assert.equal(fs.readFileSync("/local/sentinel.txt", "utf8"), "local sentinel must remain unchanged\n");
assert.equal(fs.existsSync("/local/remote.txt"), false);
console.log(JSON.stringify({
  target: resolved.public,
  backend: writeResult.details.backend,
  effectsState: resolveEffectsEvidenceState(resolved, evidencePath),
  registeredTools: [...names].sort(),
  localFallback: "unchanged",
}));
NODE

[[ ! -e "$LOCAL_DIR/remote.txt" ]] || { echo 'local fallback file was created' >&2; exit 1; }
[[ "$(cat "$LOCAL_DIR/sentinel.txt")" == 'local sentinel must remain unchanged' ]] || { echo 'local sentinel changed' >&2; exit 1; }
[[ "$(docker exec "$TARGET_CONTAINER" cat /probe/remote.txt)" == 'written through locked ssh' ]] || { echo 'remote write/read did not reach the target' >&2; exit 1; }
docker exec "$TARGET_CONTAINER" test -f /probe/uncertain.txt || {
  echo 'interrupted probe did not reach the remote mutation' >&2
  exit 1
}
printf '✓ locked SSH tools, target binding, and effects ambiguity probe\n'
