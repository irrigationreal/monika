import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadConfig,
  resolveGlobalConfigPath,
} from "../../config/extensions/stateful-memory/config.js";
import { shutdownStatefulMemory } from "../../config/extensions/stateful-memory/shutdown.js";

async function withConfigEnv(env, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("global config uses PI_CODING_AGENT_DIR instead of disposable HOME", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monika-stateful-config-"));
  const agentDir = path.join(root, "agent");
  const scratchHome = path.join(root, "scratch-home");
  const workspace = path.join(root, "workspace");
  const baseDir = path.join(root, "persona-state");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(scratchHome, ".pi", "agent"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "stateful-memory.json"),
    JSON.stringify({ baseDir, personaFile: "SOUL.md" }),
  );
  await fs.writeFile(
    path.join(scratchHome, ".pi", "agent", "stateful-memory.json"),
    JSON.stringify({ baseDir: path.join(root, "wrong-scratch-state") }),
  );

  await withConfigEnv({ HOME: scratchHome, PI_CODING_AGENT_DIR: agentDir }, async () => {
    assert.equal(resolveGlobalConfigPath(), path.join(agentDir, "stateful-memory.json"));
    const config = await loadConfig(workspace);
    assert.equal(config.baseDir, baseDir);
    assert.equal(config.personaFile, path.join(baseDir, "SOUL.md"));
  });
});

test("global config falls back to HOME/.pi/agent at load time", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monika-stateful-home-config-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(home, ".pi", "agent");
  const baseDir = path.join(root, "fallback-state");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "stateful-memory.json"),
    JSON.stringify({ baseDir, factsFile: "FACTS.md" }),
  );

  await withConfigEnv({ HOME: home, PI_CODING_AGENT_DIR: null }, async () => {
    assert.equal(resolveGlobalConfigPath(), path.join(agentDir, "stateful-memory.json"));
    const config = await loadConfig(workspace);
    assert.equal(config.baseDir, baseDir);
    assert.equal(config.factsFile, path.join(baseDir, "FACTS.md"));
  });
});

for (const summarizeFails of [false, true]) {
  test(`session shutdown closes and clears the memstore client${summarizeFails ? " when save submission fails" : " after save submission"}`, async () => {
    const calls = [];
    let client = null;

    const shutdown = shutdownStatefulMemory({
      summarize: async () => {
        client = { close() { calls.push("close"); } };
        calls.push("submitSave");
        if (summarizeFails) throw new Error("fixture save failure");
      },
      getClient: () => client,
      clearClient: () => {
        calls.push("clearClient");
        client = null;
      },
    });

    if (summarizeFails) await assert.rejects(shutdown, /fixture save failure/);
    else await shutdown;

    assert.deepEqual(calls, ["submitSave", "close", "clearClient"]);
    assert.equal(client, null);
  });
}

test("session shutdown clears the memstore client when close throws", async () => {
  let client = {
    close() { throw new Error("fixture close failure"); },
  };

  await assert.rejects(
    shutdownStatefulMemory({
      summarize: async () => {},
      getClient: () => client,
      clearClient: () => { client = null; },
    }),
    /fixture close failure/,
  );
  assert.equal(client, null);
});
