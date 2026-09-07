import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import WebSocket from "ws";

const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "marin";
const MAX_KEY_BYTES = 16 * 1024;
const MAX_PERSONA_FILE_BYTES = 48 * 1024;
const MAX_RECALL_QUERY_CHARS = 240;
const MAX_RECALL_RESULTS = 5;
const MAX_RECALL_RESULT_CHARS = 1_200;
const MAX_RECALL_TOTAL_CHARS = 4_000;
const MAX_SDP_BYTES = 128 * 1024;
const SESSION_MAX_MS = 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 8;
const MAX_PROVIDER_JSON_BYTES = 256 * 1024;
const CONNECT_MAX_MS = 32_000;
const HANGUP_TIMEOUT_MS = 3_000;

export class VoiceAdapterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "VoiceAdapterError";
    this.code = code;
    this.status = status;
  }
}

function configuredUrl(value, name, { protocol, exactPath, originOnly = false }) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new VoiceAdapterError("invalid_configuration", `${name} is invalid`, 503);
  }
  if (
    parsed.protocol !== protocol || parsed.username || parsed.password || parsed.hash ||
    (originOnly && (parsed.search || (parsed.pathname !== "/" && parsed.pathname !== ""))) ||
    (!originOnly && (parsed.search || parsed.pathname !== exactPath))
  ) {
    throw new VoiceAdapterError("invalid_configuration", `${name} is invalid`, 503);
  }
  return originOnly ? parsed.origin : parsed.href;
}

function boundedText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

export function validateRecallRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VoiceAdapterError("invalid_request", "request body must be an object");
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > MAX_RECALL_QUERY_CHARS) {
    throw new VoiceAdapterError("invalid_request", `query must be 1-${MAX_RECALL_QUERY_CHARS} characters`);
  }
  const requested = input.limit === undefined ? 3 : Number(input.limit);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RECALL_RESULTS) {
    throw new VoiceAdapterError("invalid_request", `limit must be an integer from 1 to ${MAX_RECALL_RESULTS}`);
  }
  return { query, limit: requested };
}

export function boundRecallResult(raw, limit) {
  const candidates = Array.isArray(raw?.entries) ? raw.entries : [];
  const results = [];
  let remaining = MAX_RECALL_TOTAL_CHARS;
  for (const entry of candidates.slice(0, limit)) {
    if (!entry || typeof entry !== "object" || remaining <= 0) continue;
    const title = boundedText(entry.title, 160);
    const snippet = boundedText(entry.snippet, Math.min(MAX_RECALL_RESULT_CHARS, remaining));
    if (!title && !snippet) continue;
    remaining -= snippet.length;
    results.push({ title, snippet, created_at: boundedText(entry.created_at, 64) || null });
  }
  return results;
}

async function readSecretFile(file) {
  if (!file || typeof file !== "string" || !file.startsWith("/")) {
    throw new VoiceAdapterError("invalid_configuration", "MONIKA_VOICE_PROVIDER_API_KEY_FILE must be an absolute secret-file path", 503);
  }
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_KEY_BYTES) throw new Error("invalid");
    const key = (await handle.readFile("utf8")).trim();
    if (!key || key.includes("\n") || key.includes("\r")) throw new Error("invalid");
    return key;
  } catch {
    throw new VoiceAdapterError("invalid_configuration", "voice provider secret file is unavailable or invalid", 503);
  } finally {
    await handle?.close();
  }
}

async function readBoundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function assertConnectActive(signal) {
  if (!signal?.aborted) return;
  const timedOut = signal.reason?.name === "TimeoutError";
  throw new VoiceAdapterError(
    timedOut ? "connect_timeout" : "connect_cancelled",
    timedOut ? "Realtime voice connection timed out" : "Realtime voice connection was cancelled",
    timedOut ? 504 : 499,
  );
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readPersona(files, signal) {
  const sections = [];
  for (const file of files) {
    if (!file) continue;
    assertConnectActive(signal);
    try {
      const handle = await fs.open(file, "r");
      try {
        assertConnectActive(signal);
        const stat = await handle.stat();
        assertConnectActive(signal);
        if (!stat.isFile() || stat.size > MAX_PERSONA_FILE_BYTES) continue;
        const text = boundedText(await handle.readFile("utf8"), MAX_PERSONA_FILE_BYTES).trim();
        assertConnectActive(signal);
        if (text) sections.push(text);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return sections.join("\n\n").slice(0, MAX_PERSONA_FILE_BYTES);
}

function recallTool() {
  return {
    type: "function",
    name: "recall_past_context",
    description: "Search a bounded, read-only index of past context. It cannot write memory or execute actions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: `Search query, at most ${MAX_RECALL_QUERY_CHARS} characters.` },
        limit: { type: "integer", minimum: 1, maximum: MAX_RECALL_RESULTS },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  };
}

function sessionConfig({ model, voice, instructions }) {
  return {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    instructions,
    tools: [recallTool()],
    tool_choice: "auto",
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
      },
      output: { voice },
    },
  };
}

function waitForSidebandReady(ws, update, signal, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error("sideband readiness timed out")), timeoutMs);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("open", onOpen);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(signal.reason ?? new Error("connection cancelled"));
    const onError = () => finish(new Error("sideband connection failed"));
    const onClose = () => finish(new Error("sideband closed before ready"));
    const onOpen = () => {
      try { ws.send(JSON.stringify({ type: "session.update", session: update })); }
      catch { finish(new Error("sideband session update failed")); }
    };
    const onMessage = (wire) => {
      try {
        const event = JSON.parse(wire.toString());
        if (event.type === "session.updated") finish();
        else if (event.type === "error") finish(new Error("sideband session update rejected"));
      } catch {
        // Ignore unrelated/malformed provider events while waiting for the ack.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
    ws.once("open", onOpen);
  });
}

export function createVoiceAdapter({ env = process.env, fetchImpl = fetch, callMemstoreTool, WebSocketImpl = WebSocket } = {}) {
  const enabled = env.MONIKA_VOICE_ENABLED === "1";
  const sessions = new Map();
  const pendingConnections = new Map();
  let pendingConnects = 0;

  async function recall(input) {
    if (!enabled) throw new VoiceAdapterError("voice_disabled", "Realtime voice adapter is disabled", 404);
    if (typeof callMemstoreTool !== "function") throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    const { query, limit } = validateRecallRequest(input);
    const raw = await callMemstoreTool("memstore_search", { query, limit }, 2_000);
    if (!raw) throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    return { query, results: boundRecallResult(raw, limit), bounds: { max_results: MAX_RECALL_RESULTS } };
  }

  async function authorize(value) {
    if (!enabled) return false;
    const expected = await readSecretFile(env.MONIKA_VOICE_INTERNAL_TOKEN_FILE);
    const supplied = createHash("sha256").update(typeof value === "string" ? value : "").digest();
    const target = createHash("sha256").update(expected).digest();
    return timingSafeEqual(supplied, target);
  }

  async function providerConfiguration(signal) {
    assertConnectActive(signal);
    const apiOrigin = configuredUrl(env.MONIKA_VOICE_PROVIDER_API_BASE_URL ?? "", "MONIKA_VOICE_PROVIDER_API_BASE_URL", { protocol: "https:", originOnly: true });
    const mediaUrl = configuredUrl(env.MONIKA_VOICE_MEDIA_URL ?? "https://api.openai.com/v1/realtime/calls", "MONIKA_VOICE_MEDIA_URL", { protocol: "https:", exactPath: "/v1/realtime/calls" });
    const sidebandUrl = configuredUrl(env.MONIKA_VOICE_SIDEBAND_URL ?? "wss://api.openai.com/v1/realtime", "MONIKA_VOICE_SIDEBAND_URL", { protocol: "wss:", exactPath: "/v1/realtime" });
    if (new URL(mediaUrl).host !== new URL(sidebandUrl).host) {
      throw new VoiceAdapterError("invalid_configuration", "Realtime media and sideband hosts must match", 503);
    }
    const key = await readSecretFile(env.MONIKA_VOICE_PROVIDER_API_KEY_FILE);
    assertConnectActive(signal);
    const model = boundedText(env.MONIKA_VOICE_MODEL ?? DEFAULT_MODEL, 120);
    const voice = boundedText(env.MONIKA_VOICE_VOICE ?? DEFAULT_VOICE, 64);
    if (!/^[A-Za-z0-9._-]+$/.test(model) || !/^[A-Za-z0-9_-]+$/.test(voice)) {
      throw new VoiceAdapterError("invalid_configuration", "voice model or voice name is invalid", 503);
    }
    return { apiOrigin, mediaUrl, sidebandUrl, key, model, voice };
  }

  async function instructions(signal) {
    const personaFiles = (env.MONIKA_VOICE_PERSONA_FILES ?? "/app/.pi/stateful-memory/SOUL.md:/app/.pi/stateful-memory/STYLE.md:/app/.pi/stateful-memory/REGISTER.md").split(":").filter(Boolean);
    const contextFiles = (env.MONIKA_VOICE_CONTEXT_FILES ?? "").split(":").filter(Boolean);
    const persona = await readPersona(personaFiles, signal);
    assertConnectActive(signal);
    const selectedContext = await readPersona(contextFiles, signal);
    assertConnectActive(signal);
    return [
      "You are in the isolated Realtime Voice Lab. Keep the core identity supplied below; these delivery instructions only adapt it to speech.",
      "Use low reasoning effort. Speak naturally in a concise conversational register. Do not speak Markdown formatting, headings, bullet markers, or long structured lists.",
      "This Gate 1 session is experimental and is not canonical history. Never claim to save memory. Only the read-only recall_past_context tool is available; no Pi dispatch or write/action tools exist.",
      persona,
      selectedContext ? `Selected read-only POC context snapshot (not live state and not guaranteed complete):\n${selectedContext}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async function mintCredential(config, session, signal) {
    let upstream;
    try {
      upstream = await fetchImpl(`${config.apiOrigin}/v1/realtime/client_secrets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.key}`,
          "content-type": "application/json",
          "user-agent": env.MONIKA_VOICE_PROVIDER_USER_AGENT ?? "Mozilla/5.0",
        },
        body: JSON.stringify({ session }),
        signal: withTimeout(signal, 10_000),
      });
    } catch {
      assertConnectActive(signal);
      throw new VoiceAdapterError("provider_unavailable", "Realtime credential provider is unavailable", 502);
    }
    assertConnectActive(signal);
    if (!upstream.ok) throw new VoiceAdapterError("provider_rejected", "Realtime credential provider rejected the request", 502);
    let payload;
    try {
      payload = JSON.parse(await readBoundedText(upstream, MAX_PROVIDER_JSON_BYTES));
      assertConnectActive(signal);
    } catch (error) {
      assertConnectActive(signal);
      // Invalid provider content is redacted below.
    }
    if (!payload || typeof payload.value !== "string" || !payload.value || !Number.isFinite(Number(payload.expires_at))) {
      throw new VoiceAdapterError("provider_invalid_response", "Realtime credential provider returned an invalid response", 502);
    }
    return { value: payload.value, expiresAt: Number(payload.expires_at) };
  }

  async function hangup(config) {
    if (!config?.callId || !config?.mediaUrl || !config?.key) return;
    try {
      const response = await fetchImpl(`${config.mediaUrl}/${encodeURIComponent(config.callId)}/hangup`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.key}` },
        signal: AbortSignal.timeout(HANGUP_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
    } catch {
      // Cleanup is bounded and best effort. Never surface provider details.
    }
  }

  function installSidebandHandlers(record) {
    record.ws.on("error", () => {
      record.errors += 1;
      record.lastEvent = "sideband.error";
      void close(record.id);
    });
    record.ws.on("message", async (wire) => {
      let event;
      try { event = JSON.parse(wire.toString()); } catch { return; }
      record.events += 1;
      record.lastEvent = boundedText(event.type, 100);
      if (event.type === "error") record.errors += 1;
      if (event.type !== "response.function_call_arguments.done" || event.name !== "recall_past_context") return;
      record.toolCalls += 1;
      let output;
      try {
        const args = JSON.parse(event.arguments ?? "{}");
        output = JSON.stringify(await recall(args));
      } catch (error) {
        record.errors += 1;
        output = JSON.stringify({ error: error instanceof VoiceAdapterError ? error.code : "recall_failed" });
      }
      if (record.ws.readyState !== WebSocketImpl.OPEN) return;
      record.ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: event.call_id, output },
      }));
      record.ws.send(JSON.stringify({ type: "response.create" }));
    });
  }

  async function connect(input = {}, { signal } = {}) {
    if (!enabled) throw new VoiceAdapterError("voice_disabled", "Realtime voice adapter is disabled", 404);
    const shutdownController = new AbortController();
    const connectSignal = AbortSignal.any([withTimeout(signal, CONNECT_MAX_MS), shutdownController.signal]);
    assertConnectActive(connectSignal);
    if (sessions.size + pendingConnects >= MAX_ACTIVE_SESSIONS) throw new VoiceAdapterError("voice_capacity", "Realtime voice session capacity has been reached", 503);
    let finishPending;
    const pendingDone = new Promise((resolve) => { finishPending = resolve; });
    pendingConnections.set(shutdownController, pendingDone);
    pendingConnects += 1;
    let ws;
    let hangupConfig;
    try {
      const sdp = typeof input.sdp === "string" ? input.sdp : "";
      if (!sdp.startsWith("v=0") || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
        throw new VoiceAdapterError("invalid_request", "sdp must be a valid bounded WebRTC offer");
      }
      assertConnectActive(connectSignal);
      const config = await providerConfiguration(connectSignal);
      assertConnectActive(connectSignal);
      const configuredInstructions = await instructions(connectSignal);
      assertConnectActive(connectSignal);
      const configuredSession = sessionConfig({ model: config.model, voice: config.voice, instructions: configuredInstructions });
      const ephemeral = await mintCredential(config, configuredSession, connectSignal);
      assertConnectActive(connectSignal);
      let media;
      try {
        media = await fetchImpl(config.mediaUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${ephemeral.value}`, "content-type": "application/sdp" },
          body: sdp,
          signal: withTimeout(connectSignal, 12_000),
        });
      } catch {
        assertConnectActive(connectSignal);
        throw new VoiceAdapterError("media_unavailable", "Realtime media service is unavailable", 502);
      }
      const location = media.headers.get("location") ?? "";
      const callId = location.split("/").pop();
      if (/^rtc_[A-Za-z0-9_-]+$/.test(callId ?? "")) {
        hangupConfig = { mediaUrl: config.mediaUrl, callId, key: ephemeral.value };
      }
      assertConnectActive(connectSignal);
      if (!media.ok || !hangupConfig) {
        throw new VoiceAdapterError("media_rejected", "Realtime media service rejected the connection", 502);
      }
      let answer;
      try {
        answer = await readBoundedText(media, MAX_SDP_BYTES);
        assertConnectActive(connectSignal);
      } catch {
        assertConnectActive(connectSignal);
        throw new VoiceAdapterError("media_rejected", "Realtime media service rejected the connection", 502);
      }
      if (!answer.startsWith("v=0")) {
        throw new VoiceAdapterError("media_rejected", "Realtime media service rejected the connection", 502);
      }

      try {
        ws = new WebSocketImpl(`${config.sidebandUrl}?call_id=${encodeURIComponent(callId)}`, {
          headers: { authorization: `Bearer ${ephemeral.value}` },
        });
      } catch {
        throw new VoiceAdapterError("sideband_unavailable", "Realtime control channel could not be established", 502);
      }
      // Keep an error listener installed across the readiness-to-lifecycle handoff;
      // an EventEmitter "error" without a listener would terminate agentd.
      ws.on("error", () => {});
      try {
        await waitForSidebandReady(ws, configuredSession, connectSignal);
        assertConnectActive(connectSignal);
      } catch {
        assertConnectActive(connectSignal);
        throw new VoiceAdapterError("sideband_unavailable", "Realtime control channel could not be established", 502);
      }
      const id = randomUUID();
      const record = { id, callId, ws, hangupConfig, createdAt: Date.now(), events: 0, errors: 0, toolCalls: 0, lastEvent: "session.updated", timer: null };
      record.timer = setTimeout(() => { void close(id); }, SESSION_MAX_MS);
      record.timer.unref?.();
      sessions.set(id, record);
      installSidebandHandlers(record);
      ws.once("close", () => { void close(id, { closeSocket: false }); });
      return {
        session_id: id,
        sdp: answer,
        model: config.model,
        expires_at: ephemeral.expiresAt,
        capabilities: { sideband: true, tools: ["recall_past_context"], canonical_archival: false },
      };
    } catch (error) {
      try { ws?.close(); } catch { /* already closed */ }
      await hangup(hangupConfig);
      throw error;
    } finally {
      pendingConnects -= 1;
      pendingConnections.delete(shutdownController);
      finishPending();
    }
  }

  function diagnostics(id) {
    const record = sessions.get(id);
    if (!record) throw new VoiceAdapterError("session_not_found", "Voice session was not found", 404);
    return {
      session_id: record.id,
      connected: record.ws.readyState === WebSocketImpl.OPEN,
      age_ms: Date.now() - record.createdAt,
      provider_events: record.events,
      provider_errors: record.errors,
      tool_calls: record.toolCalls,
      last_event: record.lastEvent,
    };
  }

  async function close(id, { closeSocket = true } = {}) {
    const record = sessions.get(id);
    if (!record) return false;
    sessions.delete(id);
    clearTimeout(record.timer);
    if (closeSocket) {
      try { record.ws.close(); } catch { /* already closed */ }
    }
    await hangup(record.hangupConfig);
    return true;
  }

  async function closeAll() {
    const pending = [...pendingConnections.entries()];
    for (const [controller] of pending) controller.abort();
    await Promise.all([
      ...pending.map(([, done]) => done),
      ...[...sessions.keys()].map((id) => close(id)),
    ]);
  }

  function activeCount() {
    return sessions.size + pendingConnects;
  }

  return { enabled, authorize, recall, connect, diagnostics, close, closeAll, activeCount };
}
