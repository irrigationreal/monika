import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceAdapter, validateConnectRequest, validateRecallRequest, boundRecallResult, boundSessionExcerpt, VoiceAdapterError } from "../src/voice-adapter.mjs";

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
    root,
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

test("settings, recall, and excerpt outputs are strictly validated and bounded", () => {
  assert.throws(() => validateRecallRequest({ query: "x".repeat(241), limit: 1 }), /1-240/);
  assert.throws(() => validateRecallRequest({ query: "okay", limit: 6 }), /1 to 5/);
  assert.throws(() => validateRecallRequest({ query: "okay", limit: "1" }), /integer/);
  assert.throws(() => validateConnectRequest({ sdp: "v=0", endpoint: "https://evil.test" }), /unexpected request field/);
  assert.throws(() => validateConnectRequest({ sdp: "v=0", settings: { voice: "custom" } }), /not supported/);
  assert.throws(() => validateConnectRequest({ sdp: "v=0", settings: { playback_speed: 1.51 } }), /0.25-1.5/);
  assert.throws(() => validateConnectRequest({ sdp: "v=0", settings: { playback_speed: "1" } }), /must be a number/);
  assert.throws(() => validateConnectRequest({ sdp: "v=0", opening_topic: 42 }), /must be a string/);
  const request = validateConnectRequest({ sdp: "v=0", settings: { voice: "cedar", vad_patience: "low", response_length: "brief", playback_speed: 0.25, reasoning_effort: "minimal" } });
  assert.equal(request.settings.voice, "cedar");
  assert.equal(request.settings.reasoning_effort, "minimal");
  const result = boundRecallResult(
    { entries: Array.from({ length: 9 }, (_, index) => ({ id: index + 1, title: `t${index}`, snippet: "x".repeat(2000), origin: "/secret/path", created_at: "2026-01-01T00:00:00Z" })) },
    { observations: [{ id: 12, entity_type: "person", entity_name: "User", body: "current observation", origin: "/secret" }] },
    5,
  );
  assert.equal(result.sessions.length <= 4, true);
  assert.equal(result.sessions.every((entry) => entry.snippet.length <= 1200 && !("origin" in entry)), true);
  const invalidIds = boundRecallResult(
    { entries: [{ id: 0, title: "zero" }, { id: -2, title: "negative" }, { id: "3", title: "coerced" }] },
    { observations: [{ id: null, body: "null" }, { id: 0, body: "zero" }] },
    5,
  );
  assert.deepEqual(invalidIds, { sessions: [], observations: [] });
  assert.equal([...result.sessions, ...result.observations].reduce((sum, entry) => sum + entry.snippet.length, 0) <= 4000, true);
  const excerpt = boundSessionExcerpt({ entry: { id: 7, title: "Session", body: "a".repeat(7000), origin: "/private/session.jsonl", created_at: "2026-01-01" } });
  assert.equal(excerpt.excerpt.length, 6000);
  assert.equal(excerpt.next_offset, 6000);
  assert.equal("origin" in excerpt, false);
  assert.throws(() => boundSessionExcerpt({ entry: { id: null, body: "bad" } }), /not found/);
  assert.throws(() => boundSessionExcerpt({ entry: { id: 8, body: "wrong" } }, { expectedId: 7 }), /not found/);
  assert.throws(() => boundSessionExcerpt({ entry: { id: 7, body: "bad offset" } }, { offset: "0" }), /offset/);
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
    callMemstoreTool: async (name, args, timeoutMs, options) => {
      memoryCalls.push({ name, args, timeoutMs, options });
      if (name === "memstore_show_entry") return { entry: { id: args.id, title: "Prior", body: "full bounded transcript" } };
      return { entries: [{ id: 1, title: "Prior", snippet: "bounded context", origin: "/not-returned" }] };
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
  assert.deepEqual(result.capabilities.tools, ["recall_past_context", "read_session_excerpt"]);
  assert.equal(FakeWebSocket.instances[0].url, "wss://api.openai.com/v1/realtime?call_id=rtc_test123");
  assert.equal(FakeWebSocket.instances[0].options.headers.authorization, "Bearer ek_private");
  assert.equal(JSON.stringify(result).includes("ek_private"), false);
  assert.throws(() => adapter.startPreview(result.session_id), (error) => error instanceof VoiceAdapterError && error.code === "not_preview");
  const mintedSession = JSON.parse(requests[0].options.body).session;
  assert.deepEqual(mintedSession.tools.map((tool) => tool.name), ["recall_past_context", "read_session_excerpt"]);
  assert.deepEqual(mintedSession.reasoning, { effort: "low" });
  assert.equal(mintedSession.audio.output.speed, 1);
  assert.equal(mintedSession.audio.input.turn_detection.eagerness, "auto");
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
  assert.deepEqual(memoryCalls, [
    { name: "memstore_search", args: { query: "prior promise", limit: 1 }, timeoutMs: 2_000, options: { maxBytes: 8 * 1024 * 1024 } },
    { name: "memstore_search_observations", args: { query: "prior promise", limit: 1, include_historical: false }, timeoutMs: 2_000, options: { maxBytes: 8 * 1024 * 1024 } },
  ]);
  const output = FakeWebSocket.instances[0].sent.find((event) => event.type === "conversation.item.create");
  assert.equal(output.item.type, "function_call_output");
  assert.equal(output.item.output.includes("bounded context"), true);
  assert.equal(output.item.output.includes("not-returned"), false);
  FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "read_session_excerpt",
    call_id: "call_allowed",
    arguments: JSON.stringify({ id: 1, max_chars: 500 }),
  })));
  FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "read_session_excerpt",
    call_id: "call_guessed",
    arguments: JSON.stringify({ id: 2, max_chars: 500 }),
  })));
  await new Promise((resolve) => setImmediate(resolve));
  const allowed = FakeWebSocket.instances[0].sent.find((event) => event.item?.call_id === "call_allowed");
  const guessed = FakeWebSocket.instances[0].sent.find((event) => event.item?.call_id === "call_guessed");
  assert.match(allowed.item.output, /full bounded transcript/);
  assert.match(guessed.item.output, /excerpt_not_recalled/);
  const showCall = memoryCalls.find((call) => call.name === "memstore_show_entry");
  assert.deepEqual(showCall.options, { maxBytes: 8 * 1024 * 1024 });
  assert.equal(memoryCalls.some((call) => call.name === "memstore_show_entry" && call.args.id === 2), false);
  assert.equal(adapter.diagnostics(result.session_id).tool_calls, 3);
  assert.equal(await adapter.close(result.session_id), true);
  assert.throws(() => adapter.diagnostics(result.session_id), /not found/);
  const hangup = requests.find((request) => request.url.endsWith("/v1/realtime/calls/rtc_test123/hangup"));
  assert.ok(hangup);
  assert.equal(hangup.options.method, "POST");
  assert.equal(hangup.options.headers.authorization, "Bearer ek_private");
});

test("preview uses the same model but excludes microphone context, persona, memories, and tools", async (t) => {
  FakeWebSocket.instances.length = 0;
  const { env, root } = await fixture(t);
  const persona = path.join(root, "persona.md");
  await writeFile(persona, "PRIVATE PERSONA MARKER");
  env.MONIKA_VOICE_PERSONA_FILES = persona;
  let memoryCalled = false;
  const requests = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: FakeWebSocket,
    callMemstoreTool: async () => { memoryCalled = true; return {}; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_preview", expires_at: 9999999999 });
      if (url.endsWith("/hangup")) return new Response(null);
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_preview" } });
    },
  });
  const result = await adapter.connect({ mode: "preview", sdp: "v=0\r\noffer", voice: "alloy" });
  const session = JSON.parse(requests[0].options.body).session;
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.deepEqual(session.tools, []);
  assert.equal("input" in session.audio, false);
  assert.equal(session.instructions.includes("PRIVATE PERSONA MARKER"), false);
  assert.equal(memoryCalled, false);
  assert.deepEqual(result.capabilities.tools, []);
  assert.deepEqual(result.effective_settings, { voice: "alloy" });
  assert.doesNotMatch(JSON.stringify(FakeWebSocket.instances[0].sent), /response.create/);
  FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({
    type: "response.function_call_arguments.done",
    name: "recall_past_context",
    call_id: "unexpected_preview_tool",
    arguments: JSON.stringify({ query: "private", limit: 1 }),
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(memoryCalled, false);
  assert.equal(adapter.diagnostics(result.session_id).last_event, "preview.tool_call_rejected");
  assert.deepEqual(adapter.startPreview(result.session_id), { ok: true, started: true });
  assert.deepEqual(adapter.startPreview(result.session_id), { ok: true, started: false });
  assert.match(JSON.stringify(FakeWebSocket.instances[0].sent), /Hello, this is the voice preview/);
  assert.equal(FakeWebSocket.instances[0].sent.filter((event) => event.type === "response.create").length, 1);
  await adapter.close(result.session_id);
  assert.equal(requests.some((request) => request.url.endsWith("rtc_preview/hangup")), true);
});

test("opening topic enriches from current observations, sessions, bounded topics, and snapshot timestamp", async (t) => {
  FakeWebSocket.instances.length = 0;
  const { env, root } = await fixture(t);
  const topicDir = path.join(root, "topics");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(topicDir));
  const index = path.join(root, "matrix.md");
  const manifest = path.join(root, "snapshot.json");
  await writeFile(index, `---\n{"topics":[{"id":"music","file":"persona_topics/music.md","triggers":["piano","song"],"scope":["system"]}]}\n---\n# Matrix`);
  await writeFile(path.join(topicDir, "music.md"), "# Music addendum\nPiano-specific persona guidance.");
  await writeFile(manifest, JSON.stringify({ version: 1, snapshot_at: "2026-03-01T12:00:00Z", source: "offline-safe-backup", sha256: "a".repeat(64), entries: 1, observations: 1, observation_relations: 0, read_only_tools: ["memstore_search", "memstore_search_observations", "memstore_show_entry"] }));
  Object.assign(env, { MONIKA_VOICE_TOPIC_INDEX_FILE: index, MONIKA_VOICE_TOPIC_DIR: topicDir, MONIKA_VOICE_SNAPSHOT_MANIFEST_FILE: manifest });
  const memoryCalls = [];
  const requests = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: FakeWebSocket,
    callMemstoreTool: async (name, args) => {
      memoryCalls.push({ name, args });
      if (name === "memstore_search") return { entries: [{ id: 41, title: "Prior piano chat", snippet: "A bounded session snippet", created_at: "2026-02-01", origin: "/private" }] };
      if (name === "memstore_search_observations") return { observations: [{ id: 91, entity_type: "preference", entity_name: "Music", body: "Likes piano", created_at: "2026-02-02", lifecycle: "current" }] };
      if (name === "memstore_show_entry") return { entry: { id: 41, title: "Prior", body: "transcript body", origin: "/private", created_at: "2026-02-01" } };
      throw new Error("unexpected tool");
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_topic", expires_at: 9999999999 });
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_topic" } });
    },
  });
  const requestedSettings = { voice: "coral", speech_direction: "Use an even spoken cadence.", vad_patience: "low", response_length: "detailed", playback_speed: 1.5, reasoning_effort: "high" };
  const result = await adapter.connect({ sdp: "v=0\r\noffer", opening_topic: "play a piano song", settings: requestedSettings });
  const session = JSON.parse(requests[0].options.body).session;
  assert.equal(session.audio.output.voice, "coral");
  assert.equal(session.audio.output.speed, 1.5);
  assert.equal(session.audio.input.turn_detection.eagerness, "low");
  assert.deepEqual(session.reasoning, { effort: "high" });
  assert.match(session.instructions, /Use an even spoken cadence/);
  assert.match(session.instructions, /thorough spoken answer/);
  assert.match(session.instructions, /Session #41/);
  assert.match(session.instructions, /Current observation #91/);
  assert.match(session.instructions, /Piano-specific persona guidance/);
  assert.match(session.instructions, /2026-03-01T12:00:00Z/);
  assert.equal(session.instructions.includes("/private"), false);
  assert.equal(memoryCalls.find((call) => call.name === "memstore_search_observations").args.include_historical, false);
  assert.equal(result.snapshot_at, "2026-03-01T12:00:00Z");
  assert.deepEqual(result.selected_topics, ["music"]);
  assert.deepEqual(result.effective_settings, requestedSettings);

  FakeWebSocket.instances[0].emit("message", Buffer.from(JSON.stringify({ type: "response.function_call_arguments.done", name: "read_session_excerpt", call_id: "call_excerpt", arguments: JSON.stringify({ id: 41, max_chars: 500 }) })));
  await new Promise((resolve) => setImmediate(resolve));
  const output = FakeWebSocket.instances[0].sent.find((event) => event.item?.call_id === "call_excerpt");
  assert.match(output.item.output, /transcript body/);
  assert.equal(output.item.output.includes("/private"), false);
  await adapter.close(result.session_id);
});

test("topic addenda reject external file links and symlinked subdirectories", async (t) => {
  FakeWebSocket.instances.length = 0;
  const { env, root } = await fixture(t);
  const topicDir = path.join(root, "topics");
  const externalDir = path.join(root, "external");
  await mkdir(topicDir);
  await mkdir(externalDir);
  await writeFile(path.join(externalDir, "outside.md"), "EXTERNAL TOPIC MARKER");
  await symlink(path.join(externalDir, "outside.md"), path.join(topicDir, "file-link.md"));
  await symlink(externalDir, path.join(topicDir, "dir-link"));
  const index = path.join(root, "matrix.md");
  await writeFile(index, `---\n{"topics":[{"id":"file-link","file":"persona_topics/file-link.md","triggers":["unsafe"],"scope":["system"]},{"id":"dir-link","file":"persona_topics/dir-link/outside.md","triggers":["unsafe"],"scope":["system"]}]}\n---`);
  Object.assign(env, { MONIKA_VOICE_TOPIC_INDEX_FILE: index, MONIKA_VOICE_TOPIC_DIR: topicDir });
  const requests = [];
  const adapter = createVoiceAdapter({
    env,
    WebSocketImpl: FakeWebSocket,
    callMemstoreTool: async (name) => name === "memstore_search_observations" ? { observations: [] } : { entries: [] },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("client_secrets")) return Response.json({ value: "ek_links", expires_at: 9999999999 });
      return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_links" } });
    },
  });
  const result = await adapter.connect({ sdp: "v=0\r\noffer", opening_topic: "unsafe" });
  const session = JSON.parse(requests[0].options.body).session;
  assert.equal(session.instructions.includes("EXTERNAL TOPIC MARKER"), false);
  assert.deepEqual(result.selected_topics, []);
  await adapter.close(result.session_id);
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
