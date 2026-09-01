import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "scripts", "runtime-supervision.sh");

function runSupervisor(command, env = {}) {
  return spawn("bash", ["-c", `source "$1"; set +e; supervise_foreground_command bash -c "$2"; exit $?`, "fixture", HELPER, command], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function completed(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

test("supervisor preserves foreground command exit status", async () => {
  assert.deepEqual(await completed(runSupervisor("exit 23")), { code: 23, signal: null });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`supervisor forwards ${signal} and reports the child signal status`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "monika-supervision-"));
    const ready = path.join(root, "ready");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const child = runSupervisor(`touch ${ready}; exec sleep 30`);
    for (let i = 0; i < 100; i += 1) {
      try { await fs.access(ready); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    await fs.access(ready);
    child.kill(signal);
    assert.deepEqual(await completed(child), { code: signal === "SIGTERM" ? 143 : 130, signal: null });
  });
}

test("supervisor stops the command when an essential child exits", async () => {
  const child = spawn("bash", ["-c", `
    source "$1"
    (sleep 0.05) &
    SUPERVISED_ESSENTIAL_PIDS=$!
    export SUPERVISED_ESSENTIAL_PIDS
    set +e
    supervise_foreground_command sleep 30
    exit $?
  `, "fixture", HELPER], { stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(await completed(child), { code: 1, signal: null });
});
