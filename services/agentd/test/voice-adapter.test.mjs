import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceAdapter, validateRecallRequest, boundRecallResult, VoiceAdapterError } from "../src/voice-adapter.mjs";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }
  send(value) {
    this.sent.push(JSON.parse(value));
    if (this.sent.at(-1).type === "session.update") {
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" }))));
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

class PendingWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = PendingWebSocket.OPEN;
    PendingWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "provider");
  const tokenFile = path.join(root, "internal");
  await writeFile(keyFile, "pool-secret\n", { mode: 0o600 });
  await writeFile(tokenFile, "internal-secret\n", { mode: 0o600 });
  return {
    env: {
      MONIKA_VOICE_ENABLED: "1",
      MONIKA_VOICE_PROVIDER_API_BASE_URL: "https://pool.example",
      MONIKA_VOICE_PROVIDER_API_KEY_FILE: keyFile,
      MONIKA_VOICE_INTERNAL_TOKEN_FILE: tokenFile,
      MONIKA_VOICE_MEDIA_URL: "https://api.openai.com/v1/realtime/calls",
      MONIKA_VOICE_SIDEBAND_URL: "wss://api.openai.com/v1/realtime",
      MONIKA_VOICE_PERSONA_FILES: "",
    },
  };
}

test("voice adapter is disabled by default and rejects before provider access", async () => {
  let fetched = false;
  const adapter = createVoiceAdapter({ env: {}, fetchImpl: async () => { fetched = true; } });
  await assert.rejects(adapter.connect({ sdp: "v=0\r\n" }), (error) => error instanceof VoiceAdapterError && error.code === "voice_disabled");
  assert.equal(fetched, false);
});

test("recall validation and output are strictly bounded", () => {
  assert.throws(() => validateRecallRequest({ query: "x".repeat(241), limit: 1 }), /1-240/);
  assert.throws(() => validateRecallRequest({ query: "okay", limit: 6 }), /1 to 5/);
  const result = boundRecallResult({ entries: Array.from({ length: 9 }, (_, index) => ({ title: `t${index}`, snippet: "x".repeat(2000), origin: "/secret/path" })) }, 5);
  assert.equal(result.length <= 4, true);
  assert.equal(result.every((entry) => entry.snippet.length <= 1200 && !("origin" in entry)), true);
  assert.equal(result.reduce((sum, entry) => sum + entry.snippet.length, 0) <= 4000, true);
});

test("provider failures are redacted and never expose credentials", async (t) => {
  const { env } = await fixture(t);
  const adapter = createVoiceAdapter({
    env,
    fetchImpl: async () => new Response("upstream says pool-secret account detail", { status: 403 }),
    callMemstoreTool: async () => ({ entries: [] }),
  });
  await assert.rejects(adapter.connect({ sdp: "v=0\r\n" }), (error) => {
    assert.equal(error.code, "provider_rejected");
    assert.equal(error.message.includes("pool-secret"), false);
    return true;
  });
});

test("connect keeps ephemeral key server-side, attaches sideband, executes only bounded recall, and closes", async (t) => {
  FakeWebSocket.instances.length = 0;
  const { env } = await fixture(t);
  const requests = [];
  const memoryCalls = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: FakeWebSocket,
    callMemstoreTool: async (name, args) => {
      memoryCalls.push({ name, args });
      return { entries: [{ title: "Prior", snippet: "bounded context", origin: "/not-returned" }] };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_private", expires_at: 9999999999 });
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_test123" } });
    },
  });
  assert.equal(await adapter.authorize("internal-secret"), true);
  assert.equal(await adapter.authorize("wrong"), false);
  const result = await adapter.connect({ sdp: "v=0\r\noffer" });
  assert.equal(result.sdp, "v=0\r\nanswer");
  assert.equal("value" in result, false);
  assert.deepEqual(result.capabilities.tools, ["recall_past_context"]);
  assert.equal(FakeWebSocket.instances[0].url, "wss://api.openai.com/v1/realtime?call_id=rtc_test123");
  assert.equal(FakeWebSocket.instances[0].options.headers.authorization, "Bearer ek_private");
  assert.equal(JSON.stringify(result).includes("ek_private"), false);
  const mintedSession = JSON.parse(requests[0].options.body).session;
  assert.deepEqual(mintedSession.tools.map((tool) => tool.name), ["recall_past_context"]);
  assert.match(mintedSession.instructions, /low reasoning effort/i);
  assert.match(mintedSession.instructions, /Do not speak Markdown/i);
  assert.match(mintedSession.instructions, /core identity/i);
  assert.deepEqual(mintedSession.tools[0].parameters.required.sort(), ["limit", "query"]);
  assert.equal(mintedSession.tools[0].parameters.additionalProperties, false);

  FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "recall_past_context",
    call_id: "call_1",
    arguments: JSON.stringify({ query: "prior promise", limit: 1 }),
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(memoryCalls, [{ name: "memstore_search", args: { query: "prior promise", limit: 1 } }]);
  const output = FakeWebSocket.instances[0].sent.find((event) => event.type === "conversation.item.create");
  assert.equal(output.item.type, "function_call_output");
  assert.equal(output.item.output.includes("bounded context"), true);
  assert.equal(output.item.output.includes("not-returned"), false);
  assert.equal(adapter.diagnostics(result.session_id).tool_calls, 1);
  assert.equal(await adapter.close(result.session_id), true);
  assert.throws(() => adapter.diagnostics(result.session_id), /not found/);
  const hangup = requests.find((request) => request.url.endsWith("/v1/realtime/calls/rtc_test123/hangup"));
  assert.ok(hangup);
  assert.equal(hangup.options.method, "POST");
  assert.equal(hangup.options.headers.authorization, "Bearer ek_private");
});

test("connect cancellation after media allocation closes sideband and affirmatively hangs up", async (t) => {
  PendingWebSocket.instances.length = 0;
  const { env } = await fixture(t);
  const requests = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: PendingWebSocket,
    callMemstoreTool: async () => ({ entries: [] }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_cancel", expires_at: 9999999999 });
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_cancel" } });
    },
  });
  const controller = new AbortController();
  const connecting = adapter.connect({ sdp: "v=0\r\noffer" }, { signal: controller.signal });
  while (PendingWebSocket.instances.length === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(connecting, (error) => error instanceof VoiceAdapterError && error.code === "connect_cancelled");
  assert.equal(PendingWebSocket.instances[0].readyState, 3);
  assert.equal(adapter.activeCount(), 0);
  const hangups = requests.filter((request) => request.url.endsWith("/v1/realtime/calls/rtc_cancel/hangup"));
  assert.equal(hangups.length, 1);
  assert.equal(hangups[0].options.headers.authorization, "Bearer ek_cancel");
});

test("provider sideband loss removes the session and hangs up media", async (t) => {
  FakeWebSocket.instances.length = 0;
  const { env } = await fixture(t);
  const requests = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: FakeWebSocket,
    callMemstoreTool: async () => ({ entries: [] }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_loss", expires_at: 9999999999 });
      if (url.endsWith("/hangup")) throw new Error("cleanup provider unavailable");
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_loss" } });
    },
  });
  const result = await adapter.connect({ sdp: "v=0\r\noffer" });
  FakeWebSocket.instances[0].close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => adapter.diagnostics(result.session_id), /not found/);
  assert.equal(requests.filter((request) => request.url.endsWith("/v1/realtime/calls/rtc_loss/hangup")).length, 1);
});
