import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["allowedRoot", "cwd", "hostname", "knownHosts", "name", "target", "version"].sort();
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_ROOT = "/runtime/secrets/ssh";

export function isContained(root, candidate) {
  const r = path.posix.normalize(root);
  const c = path.posix.normalize(candidate);
  const relative = path.posix.relative(r, c);
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative));
}

export function parseLockedDescriptor(raw, expectedName) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw); } catch { throw new Error("locked_descriptor_malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS)) throw new Error("locked_descriptor_shape");
  if (value.version !== 1 || typeof value.name !== "string" || !SAFE_NAME.test(value.name) || (expectedName && value.name !== expectedName)) throw new Error("locked_descriptor_identity");
  if (typeof value.target !== "string" || !SAFE_TARGET.test(value.target) || typeof value.hostname !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.hostname)) throw new Error("locked_descriptor_target");
  for (const key of ["cwd", "allowedRoot", "knownHosts"]) {
    const item = value[key];
    if (typeof item !== "string" || !path.posix.isAbsolute(item) || path.posix.normalize(item) !== item || /[\0-\x1f\x7f\\]/.test(item)) throw new Error(`locked_descriptor_${key}`);
  }
  if (!isContained(value.allowedRoot, value.cwd) || !isContained(SECRET_ROOT, value.knownHosts)) throw new Error("locked_descriptor_containment");
  return Object.freeze({ ...value });
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function lockCodeDigest(extensionPath, helperPath = fileURLToPath(import.meta.url), relocateHelperPath = path.join(path.dirname(helperPath), "ssh-relocate.mjs")) {
  const paths = [extensionPath, helperPath, ...(fs.existsSync(relocateHelperPath) ? [relocateHelperPath] : [])];
  return sha256(`${paths.map((item) => sha256(fs.readFileSync(item))).join("\n")}\n`);
}

export function executionTargetBindingDigest(descriptorBytes, knownHostsBytes, codeDigest) {
  return sha256(JSON.stringify({ descriptor: sha256(descriptorBytes), knownHosts: sha256(knownHostsBytes), lockCode: codeDigest }));
}

export function loadLockedDescriptor(descriptorPath, options = {}) {
  const stat = fs.lstatSync(descriptorPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) throw new Error("locked_descriptor_not_readonly");
  const raw = fs.readFileSync(descriptorPath);
  const descriptor = parseLockedDescriptor(raw);
  const knownHostsStat = fs.lstatSync(descriptor.knownHosts);
  if (!knownHostsStat.isFile() || knownHostsStat.isSymbolicLink() || (knownHostsStat.mode & 0o222) !== 0) throw new Error("locked_known_hosts_not_readonly");
  const codeDigest = options.extensionPath ? lockCodeDigest(options.extensionPath) : options.codeDigest;
  if (!codeDigest || !/^[a-f0-9]{64}$/.test(codeDigest) || (options.expectedCodeDigest && codeDigest !== options.expectedCodeDigest)) throw new Error("locked_code_digest_mismatch");
  return { descriptor, digest: executionTargetBindingDigest(raw, fs.readFileSync(descriptor.knownHosts), codeDigest), codeDigest };
}

export function assertLockedDescriptorBinding(loaded, expectedName, expectedDigest) {
  if (expectedName !== undefined && (!expectedName || loaded?.descriptor?.name !== expectedName)) throw new Error("locked_descriptor_name_mismatch");
  if (expectedDigest !== undefined && (!/^[a-f0-9]{64}$/.test(expectedDigest) || loaded?.digest !== expectedDigest)) throw new Error("locked_descriptor_digest_mismatch");
  return loaded.descriptor;
}

export function buildLockedSshArgv(descriptor, remoteProgram = "bash -s --", remoteArgs = []) {
  return [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${descriptor.knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "--", descriptor.target,
    remoteProgram, ...remoteArgs.map((value) => Buffer.from(String(value), "utf8").toString("base64")),
  ];
}

export function classifyTransientTransport(error) {
  const text = String(error?.stderr || error?.message || error || "").toLowerCase();
  return /connection (?:reset|closed|timed out)|broken pipe|temporary failure|network is unreachable|no route to host/.test(text);
}

export async function withBoundedReadRetry(operation, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await operation(attempt); } catch (error) {
      last = error;
      if (attempt === 1 || !classifyTransientTransport(error)) throw error;
      await sleep(Math.min(100, 25 * (attempt + 1)));
    }
  }
  throw last;
}

export function redactLockedError(error) {
  const message = String(error?.message || error || "ssh_error").replace(/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*/g, (value) => ["ssh_error", "ssh_transport_ambiguous", "unknown", "timeout", "aborted"].includes(value) ? value : "[redacted]");
  return { error: message.slice(0, 300) || "ssh_error" };
}

export function lockedInputDecision(state) {
  return state === "locked-verified" ? { action: "continue" } : { action: "handled" };
}

export function effectsRecord(phase, operation, id, effectsState, extra = {}) {
  return { version: 1, ts: Date.now(), phase, operation, id, ...(effectsState ? { effects_state: effectsState } : {}), ...extra };
}

export function appendEffectsRecord(filePath, record) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function parseCompletionTrailer(output, token) {
  const marker = `__MONIKA_SSH_COMPLETE_${token}__:`;
  const lines = output.split("\n");
  const trailer = lines.pop() || lines.pop();
  const match = trailer?.match(new RegExp(`^${marker}([0-9]{1,3})$`));
  if (!match) return { completion: "unknown", effects_state: "unknown", error: "ssh_transport_ambiguous" };
  return { completion: "known", effects_state: "confirmed", exitCode: Number(match[1]), output: lines.join("\n") };
}

export const STARTUP_PROBE_SCRIPT = `set -eu\ncommand -v rg >/dev/null\nrg --version >/dev/null\ncd -- "$1"\nprintf '%s\\n' "$(hostname)" "$(pwd -P)" "$(readlink -f -- "$2")"\n`;
export const PATH_PROBE_SCRIPT = `set -eu\np="$1"; root="$2"\ncase "$p" in /*) ;; *) exit 64;; esac\nparent=$(dirname -- "$p"); cp=$(readlink -f -- "$parent"); cr=$(readlink -f -- "$root")\ncase "$cp/" in "$cr/"*) ;; *) exit 65;; esac\nprintf '%s\\n' "$cp/$(basename -- "$p")"\n`;
export const LOCKED_MKDIR_SCRIPT = `set -eu
p="$1"; root="$2"
cr=$(readlink -f -- "$root"); planned=$(realpath -ms -- "$p")
case "$planned" in "$cr") exit 0 ;; "$cr/"*) ;; *) exit 65;; esac
exec {currentfd}<"$cr"; current="/proc/$$/fd/$currentfd"; relative=\${planned#"$cr/"}
IFS=/ read -r -a parts <<< "$relative"
for part in "\${parts[@]}"; do
  [ -n "$part" ] && [ "$part" != . ] && [ "$part" != .. ] || exit 65
  entry="$current/$part"
  if [ ! -e "$entry" ]; then mkdir -- "$entry" || [ -d "$entry" ] || exit 66; fi
  [ -d "$entry" ] && [ ! -L "$entry" ] || exit 66
  exec {nextfd}<"$entry" || exit 66; next="/proc/$$/fd/$nextfd"; resolved=$(readlink -f -- "$next")
  case "$resolved" in "$cr"|"$cr/"*) ;; *) exit 67;; esac
  exec {currentfd}<&-; currentfd=$nextfd; current="$next"
done
`;

export const ATOMIC_WRITE_SCRIPT = `set -eu\np="$1"; root="$2"; expected="$3"\nparent=$(dirname -- "$p"); cr=$(readlink -f -- "$root"); cp=$(readlink -f -- "$parent")\nexec {rootfd}<"$cr"; rootcap="/proc/$$/fd/$rootfd"; cr=$(readlink -f -- "$rootcap")\nexec {parentfd}<"$cp"; parentcap="/proc/$$/fd/$parentfd"; cp=$(readlink -f -- "$parentcap")\ncase "$cp/" in "$cr/"*) ;; *) exit 65;; esac\ndest="$parentcap/$(basename -- "$p")"; [ ! -L "$dest" ] || exit 66\ntmp=$(mktemp "$parentcap/.monika-write.XXXXXX"); trap 'rm -f -- "$tmp"' EXIT HUP INT TERM\nbase64 -d > "$tmp"\nactual=$(sha256sum "$tmp" | awk '{print $1}'); [ "$actual" = "$expected" ] || exit 67\nmv -f -- "$tmp" "$dest"; trap - EXIT HUP INT TERM\nheld=$(readlink -f -- "$parentcap"); current=$(readlink -f -- "$parent" || true); rootnow=$(readlink -f -- "$rootcap")\ncase "$held/" in "$rootnow/"*) ;; *) rm -f -- "$dest"; exit 68;; esac\n[ "$current" = "$held" ] || { rm -f -- "$dest"; exit 68; }\n[ "$(sha256sum "$dest" | awk '{print $1}')" = "$expected" ] || exit 69\n`;

// OpenSSH reconstructs remote argv as shell text, so even encoded arguments can
// disappear when empty or hit ARG_MAX when large. Send the entire positional
// vector as newline-delimited base64 on stdin instead; the dot line terminates
// the header and leaves any caller payload available to the executed script.
export const POSITIONAL_REMOTE_WRAPPER = `bash -c 'args=(); while IFS= read -r encoded; do [ "$encoded" != . ] || break; value=$(printf "%s" "$encoded" | base64 -d; code=$?; printf .; exit "$code") || exit 125; value="\${value%.}"; args+=("$value"); done; [ "\${#args[@]}" -gt 0 ] || exit 125; script="\${args[0]}"; set -- "\${args[@]:1}"; eval "$script"'`;

export function buildPositionalSshArgv(sshOptions, target) {
  return [...sshOptions, "--", target, POSITIONAL_REMOTE_WRAPPER];
}

export function buildPositionalSshInput(script, args = [], payload) {
  const header = [script, ...args]
    .map((value) => Buffer.from(String(value), "utf8").toString("base64"))
    .join("\n");
  const prefix = `${header}\n.\n`;
  if (payload === undefined) return Buffer.from(prefix, "utf8");
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
}

/** Shared SSH process runner. Callers must construct argv so model values are data, never shell source. */
export function runSshArgv(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess("ssh", argv, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    let spawnError;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs) : undefined;
    const abort = () => child.kill();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      options.onData?.(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, outputLimitExceeded, aborted: Boolean(options.signal?.aborted), spawnError };
      if (spawnError || timedOut || outputLimitExceeded || options.signal?.aborted || signal || code !== 0) {
        const error = new Error(spawnError ? "ssh_spawn_error" : timedOut ? "ssh_timeout" : outputLimitExceeded ? "ssh_output_limit" : options.signal?.aborted ? "ssh_aborted" : `ssh_exit_${code}`);
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? undefined);
  });
}

export function runLockedSsh(descriptor, script, args = [], options = {}) {
  return runSshArgv(buildLockedSshArgv(descriptor, POSITIONAL_REMOTE_WRAPPER), {
    ...options,
    stdin: buildPositionalSshInput(script, args, options.stdin),
  });
}

export function mutationId() { return randomUUID(); }
