import assert from "node:assert/strict";
import test from "node:test";

import {
  RelocateError,
  createAsyncReadWriteLock,
  executeRelocateRequest,
  parseRelocateTarget,
  updateSshUiBestEffort,
} from "../config/extensions/ssh-relocate.mjs";

const localState = () => ({
  resolvedSsh: null,
  sshRequired: false,
  sshError: null,
  remoteHost: null,
  remoteAgentsContent: null,
});

function harness(overrides = {}) {
  let state = overrides.state ?? localState();
  return {
    get state() { return state; },
    execute(request, values = {}) {
      return executeRelocateRequest({
        request,
        getState: () => state,
        commitState: (next) => { state = next; },
        validateTarget: values.validateTarget ?? (async () => ({ success: true, remoteCwd: "/srv/repo", hostname: "stanza" })),
        loadRemoteAgents: values.loadRemoteAgents ?? (async () => "# Remote instructions\n"),
        updateUi: values.updateUi ?? (() => ({ warnings: 0 })),
      });
    },
  };
}

test("target parsing distinguishes status, local, aliases, paths, and bracketed IPv6", () => {
  assert.deepEqual(parseRelocateTarget(undefined), { kind: "status" });
  assert.deepEqual(parseRelocateTarget(" local "), { kind: "local" });
  assert.deepEqual(parseRelocateTarget("stanza"), { kind: "remote", remote: "stanza", remoteCwd: undefined });
  assert.deepEqual(parseRelocateTarget("monika@stanza:/srv/repo"), { kind: "remote", remote: "monika@stanza", remoteCwd: "/srv/repo" });
  assert.deepEqual(parseRelocateTarget("user@[2001:db8::1]:~/repo"), { kind: "remote", remote: "user@[2001:db8::1]", remoteCwd: "~/repo" });
  assert.throws(() => parseRelocateTarget(""), RelocateError);
  assert.throws(() => parseRelocateTarget("stanza:2222"), /ports in ~\/\.ssh\/config/);
  assert.throws(() => parseRelocateTarget("2001:db8::1"), /IPv6.*brackets/);
  assert.throws(() => parseRelocateTarget("bad host:/tmp"), /Invalid SSH target/);
});

test("successful relocation remains successful when every presentation operation throws", async () => {
  const h = harness();
  const result = await h.execute(parseRelocateTarget("stanza:/srv/repo"), {
    updateUi: () => { throw new Error("Theme not initialized"); },
  });
  assert.equal(h.state.resolvedSsh.remote, "stanza");
  assert.equal(h.state.resolvedSsh.remoteCwd, "/srv/repo");
  assert.equal(result.details.operation, "remote");
  assert.equal(result.details.state, "remote");
  assert.match(result.content[0].text, /Relocated: local/);
});

test("best-effort UI avoids theme access outside TUI and contains TUI failures", () => {
  let status = null;
  const rpc = {
    mode: "rpc", hasUI: true,
    ui: {
      get theme() { throw new Error("Theme not initialized"); },
      setStatus: (_key, value) => { status = value; },
      notify: () => {},
    },
  };
  assert.deepEqual(updateSshUiBestEffort(rpc, { statusText: "SSH: stanza" }), { warnings: 0 });
  assert.equal(status, "SSH: stanza");

  const tui = {
    mode: "tui", hasUI: true,
    ui: {
      theme: { fg: () => { throw new Error("broken theme"); } },
      setStatus: () => { throw new Error("broken footer"); },
      notify: () => { throw new Error("broken notification"); },
    },
  };
  assert.deepEqual(updateSshUiBestEffort(tui, { statusText: "x", notification: "y" }), { warnings: 3 });
});

test("validation failure preserves context and is a real thrown tool error", async () => {
  const initial = { ...localState(), resolvedSsh: { remote: "old", remoteCwd: "/old" }, sshRequired: true };
  const h = harness({ state: initial });
  await assert.rejects(() => h.execute(parseRelocateTarget("new:/new"), {
    validateTarget: async () => ({ success: false, remoteCwd: "/new", error: "Remote path does not exist", errorKind: "path" }),
  }), (error) => error instanceof RelocateError && error.kind === "path" && /staying on current context/.test(error.message));
  assert.deepEqual(h.state, initial);
});

test("cancellation while loading remote instructions preserves the prior context", async () => {
  const initial = localState();
  let state = initial;
  await assert.rejects(
    executeRelocateRequest({
      request: parseRelocateTarget("stanza:/srv/work"),
      getState: () => state,
      commitState: (next) => { state = next; },
      validateTarget: async () => ({ success: true, remoteCwd: "/srv/work", hostname: "stanza" }),
      loadRemoteAgents: async () => { throw new Error("SSH command aborted"); },
      updateUi: () => ({ warnings: 0 }),
    }),
    /aborted before the routing state was committed/,
  );
  assert.equal(state, initial);
});

test("status reports unavailable required SSH instead of claiming local fallback", async () => {
  const h = harness({ state: { ...localState(), sshRequired: true, sshError: new Error("connection refused") } });
  const result = await h.execute({ kind: "status" });
  assert.equal(result.details.state, "ssh_unavailable");
  assert.match(result.content[0].text, /remain blocked rather than falling back/);
});

test("local transition clears remote state and reports structured details", async () => {
  const h = harness({ state: { ...localState(), resolvedSsh: { remote: "stanza", remoteCwd: "/repo" }, sshRequired: true } });
  const result = await h.execute({ kind: "local" });
  assert.equal(h.state.resolvedSsh, null);
  assert.equal(h.state.sshRequired, false);
  assert.deepEqual(result.details, { version: 1, operation: "local", state: "local", stateChanged: true, uiWarnings: 0 });
});

test("routing lock allows concurrent readers and fences an exclusive transition", async () => {
  const lock = createAsyncReadWriteLock();
  const events = [];
  let releaseReaders;
  const readersDone = new Promise((resolve) => { releaseReaders = resolve; });
  const reader = (id) => lock.withRead(async () => {
    events.push(`read-${id}-start`);
    await readersDone;
    events.push(`read-${id}-end`);
  });
  const first = reader(1);
  const second = reader(2);
  await new Promise((resolve) => setImmediate(resolve));
  const writer = lock.withWrite(async () => { events.push("write"); });
  const lateReader = lock.withRead(async () => { events.push("late-read"); });
  releaseReaders();
  await Promise.all([first, second, writer, lateReader]);
  assert.deepEqual(events.slice(0, 2).sort(), ["read-1-start", "read-2-start"]);
  assert.ok(events.indexOf("write") > events.indexOf("read-1-end"));
  assert.ok(events.indexOf("write") < events.indexOf("late-read"));
});
