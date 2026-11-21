import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const extensionSource = path.join(root, "config", "extensions");
const piNodeModules = ["/opt/pi-cli/node_modules", "/opt/agentd/node_modules"].find((candidate) =>
  existsSync(path.join(candidate, "@earendil-works", "pi-coding-agent")),
);
const originalCwd = process.cwd();
const managedEnv = [
  "MONIKA_SSH_LOCK_DESCRIPTOR",
  "PI_SUBAGENT_EFFECTS_EVIDENCE_PATH",
  "PI_SUBAGENT_EXECUTION_TARGET_DIGEST",
  "PI_SUBAGENT_EXECUTION_TARGET_NAME",
  "PI_SUBAGENT_SSH_LOCK_CODE_DIGEST",
];

function createFixture() {
  assert.ok(piNodeModules, "installed Pi SDK is required in /opt/pi-cli or /opt/agentd");
  const fixture = mkdtempSync(path.join(tmpdir(), "ssh-tool-operations-"));
  const extensionDir = path.join(fixture, "extension");
  const binDir = path.join(fixture, "bin");
  const localCwd = path.join(fixture, "local");
  const remoteCwd = path.join(fixture, "remote");
  const secretRoot = path.join(fixture, "secrets", "ssh");
  mkdirSync(extensionDir);
  mkdirSync(binDir);
  mkdirSync(localCwd);
  mkdirSync(remoteCwd);
  mkdirSync(secretRoot, { recursive: true });
  for (const name of ["ssh.ts", "ssh-lock.mjs", "ssh-relocate.mjs"]) {
    copyFileSync(path.join(extensionSource, name), path.join(extensionDir, name));
  }
  // The runtime secrets mount is read-only. Relocate only the copied helper's
  // descriptor fixture root; ssh.ts and the installed Pi SDK remain unmodified.
  const lockHelper = path.join(extensionDir, "ssh-lock.mjs");
  writeFileSync(lockHelper, readFileSync(lockHelper, "utf8").replace('const SECRET_ROOT = "/runtime/secrets/ssh";', `const SECRET_ROOT = ${JSON.stringify(secretRoot)};`));
  symlinkSync(piNodeModules, path.join(extensionDir, "node_modules"), "dir");

  const callsPath = path.join(fixture, "ssh-calls.log");
  const fakeSsh = path.join(binDir, "ssh");
  writeFileSync(fakeSsh, `#!/usr/bin/env bash
set -eu
printf 'ssh\\n' >> "$SSH_OPERATIONS_CALLS"
remote_command="\${!#}"
exec bash -c "$remote_command"
`);
  chmodSync(fakeSsh, 0o755);

  writeFileSync(path.join(localCwd, "probe.txt"), "local sentinel\n");
  writeFileSync(path.join(remoteCwd, "probe.txt"), "remote original\n");
  return { fixture, extensionDir, binDir, localCwd, remoteCwd, secretRoot, callsPath };
}

function createApi(flags = {}) {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    api: {
      registerFlag() {},
      getFlag(name) { return flags[name]; },
      registerTool(tool) { tools.set(tool.name, tool); },
      on(name, handler) {
        const values = handlers.get(name) ?? [];
        values.push(handler);
        handlers.set(name, values);
      },
    },
  };
}

async function loadExtension(extensionDir) {
  assert.ok(piNodeModules);
  const sdkPackage = JSON.parse(readFileSync(path.join(piNodeModules, "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
  assert.equal(sdkPackage.version, "1.6.0", "regression must exercise the installed Pi 1.6.0 SDK");
  return (await import(`${pathToFileURL(path.join(extensionDir, "ssh.ts")).href}?test=${Date.now()}-${Math.random()}`)).default;
}

async function runSessionStart(harness) {
  const handlers = harness.handlers.get("session_start") ?? [];
  assert.equal(handlers.length, 1);
  await handlers[0]({}, { mode: "json", hasUI: false });
}

async function exerciseRemoteTools(harness, localCwd, remoteCwd) {
  const ctx = { cwd: localCwd };
  const readResult = await harness.tools.get("read").execute("read-1", { path: "probe.txt" }, undefined, undefined, ctx);
  assert.match(readResult.content[0].text, /remote original/);
  assert.doesNotMatch(readResult.content[0].text, /local sentinel/);

  await harness.tools.get("write").execute("write-1", { path: "written.txt", content: "remote write\n" }, undefined, undefined, ctx);
  assert.equal(readFileSync(path.join(remoteCwd, "written.txt"), "utf8"), "remote write\n");
  assert.equal(existsSync(path.join(localCwd, "written.txt")), false, "write must not use the local SDK backend");

  await harness.tools.get("edit").execute("edit-1", {
    path: "probe.txt",
    edits: [{ oldText: "remote original", newText: "remote edited" }],
  }, undefined, undefined, ctx);
  assert.equal(readFileSync(path.join(remoteCwd, "probe.txt"), "utf8"), "remote edited\n");
  assert.equal(readFileSync(path.join(localCwd, "probe.txt"), "utf8"), "local sentinel\n", "edit must not use the local SDK backend");

  const command = "printf 'remote shell\\n' > shell-marker.txt";
  const bashResult = await harness.tools.get("bash").execute("bash-1", { command }, undefined, undefined, ctx);
  assert.equal(bashResult.isError, undefined);
  assert.equal(readFileSync(path.join(remoteCwd, "shell-marker.txt"), "utf8"), "remote shell\n");
  assert.equal(existsSync(path.join(localCwd, "shell-marker.txt")), false, "bash must not use the local SDK backend");
}

async function withFixture(run) {
  const fixture = createFixture();
  const savedEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));
  const savedPath = process.env.PATH;
  try {
    for (const name of managedEnv) delete process.env[name];
    process.env.PATH = `${fixture.binDir}:${savedPath}`;
    process.env.SSH_OPERATIONS_CALLS = fixture.callsPath;
    process.chdir(fixture.localCwd);
    await run(fixture);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = savedPath;
    delete process.env.SSH_OPERATIONS_CALLS;
    for (const name of managedEnv) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

test("relocated SSH tools use Pi 1.6 operations instead of local file and shell backends", async () => {
  await withFixture(async (fixture) => {
    const harness = createApi({ ssh: `fixture:${fixture.remoteCwd}` });
    const extension = await loadExtension(fixture.extensionDir);
    extension(harness.api);
    await runSessionStart(harness);
    await exerciseRemoteTools(harness, fixture.localCwd, fixture.remoteCwd);
    assert.ok(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length >= 10, "mock SSH transport must be invoked");
  });
});

test("locked SSH tools use Pi 1.6 operations instead of local file and shell backends", async () => {
  await withFixture(async (fixture) => {
    const knownHosts = path.join(fixture.secretRoot, "known_hosts");
    const descriptorPath = path.join(fixture.fixture, "descriptor.json");
    const effectsPath = path.join(fixture.fixture, "effects.jsonl");
    try {
      writeFileSync(knownHosts, "fixture ssh-ed25519 AAAA\n", { mode: 0o444 });
      const descriptor = {
        version: 1,
        name: "fixture",
        target: "fixture",
        hostname: execFileSync("hostname", { encoding: "utf8" }).trim(),
        cwd: fixture.remoteCwd,
        allowedRoot: fixture.fixture,
        knownHosts,
      };
      writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o444 });
      process.env.MONIKA_SSH_LOCK_DESCRIPTOR = descriptorPath;
      process.env.PI_SUBAGENT_EFFECTS_EVIDENCE_PATH = effectsPath;

      const harness = createApi();
      const extension = await loadExtension(fixture.extensionDir);
      extension(harness.api);
      await runSessionStart(harness);
      await exerciseRemoteTools(harness, fixture.localCwd, fixture.remoteCwd);

      const operations = readFileSync(effectsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).operation).filter(Boolean);
      assert.deepEqual([...new Set(operations)].sort(), ["bash", "mkdir", "write"], "locked mutating operations must record remote effects");
      assert.ok(readFileSync(fixture.callsPath, "utf8").trim().split("\n").length >= 8, "mock locked SSH transport must be invoked");
    } finally {
      rmSync(knownHosts, { force: true });
    }
  });
});
