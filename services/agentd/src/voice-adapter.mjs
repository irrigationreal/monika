import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "marin";
const DEFAULT_SPEECH_DIRECTION = "";
const PREVIEW_TEXT = "Hello, this is the voice preview.";
const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const VAD_PATIENCE = new Set(["low", "medium", "high", "auto"]);
const RESPONSE_LENGTHS = new Set(["brief", "normal", "detailed"]);
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const PLAYBACK_SPEED_MIN = 0.25;
const PLAYBACK_SPEED_MAX = 1.5;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_PERSONA_FILE_BYTES = 48 * 1024;
const MAX_TOPIC_ADDENDA_CHARS = 12_000;
const MAX_OPENING_TOPIC_CHARS = 240;
const MAX_SPEECH_DIRECTION_CHARS = 800;
const MAX_RECALL_QUERY_CHARS = 240;
const MAX_RECALL_RESULTS = 5;
const MAX_OBSERVATION_RESULTS = 3;
const MAX_RECALL_RESULT_CHARS = 1_200;
const MAX_RECALL_TOTAL_CHARS = 4_000;
const MAX_EXCERPT_CHARS = 6_000;
const MAX_EXCERPT_RPC_BYTES = 8 * 1024 * 1024;
const MAX_SDP_BYTES = 128 * 1024;
const SESSION_MAX_MS = 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 8;
const MAX_PROVIDER_JSON_BYTES = 256 * 1024;
const CONNECT_MAX_MS = 32_000;
const HANGUP_TIMEOUT_MS = 3_000;
const PREVIEW_MAX_MS = 30_000;

const LENGTH_DIRECTIONS = {
  brief: "Favor short conversational turns. Preserve any detail needed for correctness or safety.",
  normal: "Match depth to the moment. Keep small exchanges small, but develop engaged or complex discussion in natural spoken beats.",
  detailed: "Explore the topic thoroughly when useful. Keep the syntax speakable and yield at natural decision points rather than delivering an essay-shaped monologue.",
};

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

function assertObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VoiceAdapterError("invalid_request", "request body must be an object");
  }
}

function assertOnlyKeys(input, allowed) {
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new VoiceAdapterError("invalid_request", `unexpected request field: ${unexpected[0]}`);
}

export function validateVoiceSettings(input = {}) {
  assertObject(input);
  assertOnlyKeys(input, new Set(["voice", "speech_direction", "vad_patience", "response_length", "playback_speed", "reasoning_effort"]));
  const voice = input.voice ?? DEFAULT_VOICE;
  if (input.speech_direction !== undefined && typeof input.speech_direction !== "string") throw new VoiceAdapterError("invalid_request", "speech_direction must be a string");
  const speechDirection = input.speech_direction === undefined ? DEFAULT_SPEECH_DIRECTION : input.speech_direction.trim();
  const vadPatience = input.vad_patience ?? "auto";
  const responseLength = input.response_length ?? "normal";
  if (input.playback_speed !== undefined && typeof input.playback_speed !== "number") throw new VoiceAdapterError("invalid_request", "playback_speed must be a number");
  const playbackSpeed = input.playback_speed ?? 1;
  const reasoningEffort = input.reasoning_effort ?? "low";
  if (!VOICES.has(voice)) throw new VoiceAdapterError("invalid_request", "voice is not supported");
  if (speechDirection.length > MAX_SPEECH_DIRECTION_CHARS) throw new VoiceAdapterError("invalid_request", `speech_direction must be at most ${MAX_SPEECH_DIRECTION_CHARS} characters`);
  if (!VAD_PATIENCE.has(vadPatience)) throw new VoiceAdapterError("invalid_request", "vad_patience is not supported");
  if (!RESPONSE_LENGTHS.has(responseLength)) throw new VoiceAdapterError("invalid_request", "response_length is not supported");
  if (!Number.isFinite(playbackSpeed) || playbackSpeed < PLAYBACK_SPEED_MIN || playbackSpeed > PLAYBACK_SPEED_MAX) {
    throw new VoiceAdapterError("invalid_request", `playback_speed must be ${PLAYBACK_SPEED_MIN}-${PLAYBACK_SPEED_MAX}`);
  }
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new VoiceAdapterError("invalid_request", "reasoning_effort is not supported");
  return {
    voice,
    speech_direction: speechDirection,
    vad_patience: vadPatience,
    response_length: responseLength,
    playback_speed: playbackSpeed,
    reasoning_effort: reasoningEffort,
  };
}

export function validateConnectRequest(input = {}) {
  assertObject(input);
  const mode = input.mode ?? "call";
  if (mode === "preview") {
    assertOnlyKeys(input, new Set(["mode", "sdp", "voice"]));
    if (!VOICES.has(input.voice)) throw new VoiceAdapterError("invalid_request", "voice is not supported");
    return { mode, sdp: input.sdp, settings: validateVoiceSettings({ voice: input.voice }), openingTopic: "" };
  }
  if (mode !== "call") throw new VoiceAdapterError("invalid_request", "mode is not supported");
  assertOnlyKeys(input, new Set(["mode", "sdp", "settings", "opening_topic"]));
  if (input.opening_topic !== undefined && typeof input.opening_topic !== "string") throw new VoiceAdapterError("invalid_request", "opening_topic must be a string");
  const openingTopic = input.opening_topic?.trim() ?? "";
  if (openingTopic.length > MAX_OPENING_TOPIC_CHARS) throw new VoiceAdapterError("invalid_request", `opening_topic must be at most ${MAX_OPENING_TOPIC_CHARS} characters`);
  return { mode, sdp: input.sdp, settings: validateVoiceSettings(input.settings ?? {}), openingTopic };
}

function isPositiveId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validateRecallRequest(input = {}) {
  assertObject(input);
  assertOnlyKeys(input, new Set(["query", "limit"]));
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > MAX_RECALL_QUERY_CHARS) {
    throw new VoiceAdapterError("invalid_request", `query must be 1-${MAX_RECALL_QUERY_CHARS} characters`);
  }
  const requested = input.limit === undefined ? 3 : input.limit;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RECALL_RESULTS) {
    throw new VoiceAdapterError("invalid_request", `limit must be an integer from 1 to ${MAX_RECALL_RESULTS}`);
  }
  return { query, limit: requested };
}

export function boundRecallResult(sessionRaw, observationRaw, limit) {
  const sessions = [];
  const observations = [];
  let remaining = MAX_RECALL_TOTAL_CHARS;
  for (const entry of (Array.isArray(sessionRaw?.entries) ? sessionRaw.entries : []).slice(0, limit)) {
    if (!entry || typeof entry !== "object" || remaining <= 0 || !isPositiveId(entry.id)) continue;
    const title = boundedText(entry.title, 160);
    const snippet = boundedText(entry.snippet, Math.min(MAX_RECALL_RESULT_CHARS, remaining));
    if (!title && !snippet) continue;
    remaining -= snippet.length;
    sessions.push({ kind: "session", id: entry.id, title, snippet, created_at: boundedText(entry.created_at, 64) || null });
  }
  for (const item of (Array.isArray(observationRaw?.observations) ? observationRaw.observations : []).slice(0, MAX_OBSERVATION_RESULTS)) {
    if (!item || typeof item !== "object" || remaining <= 0 || !isPositiveId(item.id)) continue;
    const snippet = boundedText(item.body, Math.min(MAX_RECALL_RESULT_CHARS, remaining));
    if (!snippet) continue;
    remaining -= snippet.length;
    observations.push({
      kind: "observation",
      id: item.id,
      entity_type: boundedText(item.entity_type, 80),
      entity_name: boundedText(item.entity_name, 160),
      snippet,
      created_at: boundedText(item.created_at, 64) || null,
    });
  }
  return { sessions, observations };
}

export function boundSessionExcerpt(raw, { offset = 0, maxChars = MAX_EXCERPT_CHARS, expectedId } = {}) {
  const entry = raw?.entry;
  if (!entry || typeof entry !== "object") throw new VoiceAdapterError("excerpt_not_found", "Session excerpt was not found", 404);
  if (!isPositiveId(entry.id) || (expectedId !== undefined && entry.id !== expectedId)) {
    throw new VoiceAdapterError("excerpt_not_found", "Session excerpt was not found", 404);
  }
  const start = Number.isInteger(offset) && offset >= 0 ? offset : -1;
  const requested = maxChars;
  if (start < 0 || !Number.isInteger(requested) || requested < 500 || requested > MAX_EXCERPT_CHARS) {
    throw new VoiceAdapterError("invalid_request", `offset must be non-negative and max_chars must be 500-${MAX_EXCERPT_CHARS}`);
  }
  const body = String(entry.body ?? "");
  const text = boundedText(body.slice(start), requested);
  return {
    id: entry.id,
    title: boundedText(entry.title, 160),
    created_at: boundedText(entry.created_at, 64) || null,
    excerpt: text,
    offset: start,
    next_offset: start + text.length < body.length ? start + text.length : null,
    truncated: start + text.length < body.length,
  };
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

async function snapshotTimestamp(file, signal) {
  if (!file) return null;
  assertConnectActive(signal);
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("invalid manifest");
      const manifest = JSON.parse(await handle.readFile("utf8"));
      const keys = ["version", "snapshot_at", "source", "sha256", "entries", "observations", "observation_relations", "read_only_tools"];
      const validTools = new Set(["memstore_search", "memstore_search_observations", "memstore_show_entry"]);
      const value = typeof manifest.snapshot_at === "string" ? manifest.snapshot_at : "";
      const valid = keys.every((key) => Object.hasOwn(manifest, key)) &&
        (typeof manifest.version === "string" || Number.isInteger(manifest.version)) &&
        typeof manifest.source === "string" && manifest.source.length > 0 && manifest.source.length <= 200 &&
        /^[a-f0-9]{64}$/i.test(manifest.sha256) &&
        [manifest.entries, manifest.observations, manifest.observation_relations].every((count) => Number.isSafeInteger(count) && count >= 0) &&
        Array.isArray(manifest.read_only_tools) && manifest.read_only_tools.length === validTools.size && new Set(manifest.read_only_tools).size === validTools.size && manifest.read_only_tools.every((tool) => validTools.has(tool)) &&
        value && !Number.isNaN(Date.parse(value));
      if (!valid) throw new Error("invalid manifest");
      return value;
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new VoiceAdapterError("invalid_configuration", "voice snapshot manifest is invalid", 503);
  }
}

function tokens(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

async function readTopicFile(topicDir, relativeFile, signal) {
  if (path.isAbsolute(relativeFile)) return "";
  const root = path.resolve(topicDir);
  const candidate = path.resolve(root, relativeFile);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return "";
  assertConnectActive(signal);
  try {
    const rootReal = await fs.realpath(root);
    const relativeParts = path.relative(root, candidate).split(path.sep);
    let current = root;
    for (const part of relativeParts) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) return "";
    }
    const handle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PERSONA_FILE_BYTES) return "";
      const descriptorReal = await fs.realpath(`/proc/self/fd/${handle.fd}`);
      if (descriptorReal !== rootReal && !descriptorReal.startsWith(`${rootReal}${path.sep}`)) return "";
      assertConnectActive(signal);
      return boundedText(await handle.readFile("utf8"), MAX_PERSONA_FILE_BYTES).trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)) return "";
    throw error;
  }
}

async function topicAddenda(query, env, signal) {
  const indexFile = env.MONIKA_VOICE_TOPIC_INDEX_FILE;
  const topicDir = env.MONIKA_VOICE_TOPIC_DIR;
  if (!query || !indexFile || !topicDir) return { text: "", ids: [] };
  if (!indexFile.startsWith("/") || !topicDir.startsWith("/")) throw new VoiceAdapterError("invalid_configuration", "voice topic paths must be absolute", 503);
  let raw;
  try { raw = await readPersona([indexFile], signal); } catch { throw new VoiceAdapterError("invalid_configuration", "voice topic index is unavailable", 503); }
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  let parsed;
  try { parsed = JSON.parse(frontmatter?.[1] ?? "{}"); } catch { throw new VoiceAdapterError("invalid_configuration", "voice topic index is invalid", 503); }
  const queryTokens = tokens(query);
  const ranked = (Array.isArray(parsed.topics) ? parsed.topics : []).map((topic) => {
    const triggerTokens = tokens(Array.isArray(topic?.triggers) ? topic.triggers.join(" ") : "");
    let score = 0;
    for (const token of queryTokens) if (triggerTokens.has(token)) score += 1;
    return { topic, score: score + (score ? Number(topic?.priority ?? 0) * 0.5 : 0) };
  }).filter(({ topic, score }) => score >= 1 && typeof topic?.id === "string" && typeof topic?.file === "string" && (!Array.isArray(topic.scope) || topic.scope.map(String).map((item) => item.toLowerCase()).includes("system")))
    .sort((left, right) => right.score - left.score).slice(0, 2);
  const sections = [];
  const ids = [];
  for (const { topic } of ranked) {
    assertConnectActive(signal);
    const configuredPrefix = "persona_topics/";
    if (!topic.file.startsWith(configuredPrefix)) continue;
    const content = await readTopicFile(topicDir, topic.file.slice(configuredPrefix.length), signal);
    if (content) { sections.push(content); ids.push(boundedText(topic.id, 80)); }
  }
  return { text: sections.join("\n\n").slice(0, MAX_TOPIC_ADDENDA_CHARS), ids };
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

function excerptTool() {
  return {
    type: "function",
    name: "read_session_excerpt",
    description: "Read a bounded transcript excerpt for a session ID returned by recall_past_context. It cannot expose filesystem origin metadata.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
        max_chars: { type: "integer", minimum: 500, maximum: MAX_EXCERPT_CHARS },
      },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

function sessionConfig({ model, settings, instructions, preview = false }) {
  const base = {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    instructions,
    reasoning: { effort: settings.reasoning_effort },
    tools: preview ? [] : [recallTool(), excerptTool()],
    tool_choice: preview ? "none" : "auto",
    audio: {
      output: { voice: settings.voice, speed: settings.playback_speed },
    },
  };
  if (!preview) {
    base.audio.input = {
      transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: { type: "semantic_vad", eagerness: settings.vad_patience, create_response: true, interrupt_response: true },
    };
  }
  return base;
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

  async function recall(input, signal) {
    if (!enabled) throw new VoiceAdapterError("voice_disabled", "Realtime voice adapter is disabled", 404);
    if (typeof callMemstoreTool !== "function") throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    const { query, limit } = validateRecallRequest(input);
    const [sessionRaw, observationRaw, snapshotAt] = await Promise.all([
      callMemstoreTool("memstore_search", { query, limit }, 2_000, { maxBytes: MAX_EXCERPT_RPC_BYTES }),
      callMemstoreTool("memstore_search_observations", { query, limit: Math.min(limit, MAX_OBSERVATION_RESULTS), include_historical: false }, 2_000, { maxBytes: MAX_EXCERPT_RPC_BYTES }),
      snapshotTimestamp(env.MONIKA_VOICE_SNAPSHOT_MANIFEST_FILE, signal),
    ]);
    if (!sessionRaw || !observationRaw) throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    const bounded = boundRecallResult(sessionRaw, observationRaw, limit);
    return {
      query,
      ...bounded,
      snapshot_at: snapshotAt,
      bounds: { max_sessions: MAX_RECALL_RESULTS, max_observations: MAX_OBSERVATION_RESULTS, max_combined_snippet_chars: MAX_RECALL_TOTAL_CHARS },
    };
  }

  async function excerpt(input, recalledSessionIds) {
    if (!enabled) throw new VoiceAdapterError("voice_disabled", "Realtime voice adapter is disabled", 404);
    if (typeof callMemstoreTool !== "function") throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    assertObject(input);
    assertOnlyKeys(input, new Set(["id", "offset", "max_chars"]));
    const id = input.id;
    if (!isPositiveId(id)) throw new VoiceAdapterError("invalid_request", "id must be a positive integer");
    if (!(recalledSessionIds instanceof Set) || !recalledSessionIds.has(id)) {
      throw new VoiceAdapterError("excerpt_not_recalled", "Session excerpt ID was not returned by recall for this voice session", 403);
    }
    const raw = await callMemstoreTool("memstore_show_entry", { id }, 2_000, { maxBytes: MAX_EXCERPT_RPC_BYTES });
    if (!raw) throw new VoiceAdapterError("recall_unavailable", "Read-only recall is unavailable", 503);
    return boundSessionExcerpt(raw, { offset: input.offset ?? 0, maxChars: input.max_chars ?? MAX_EXCERPT_CHARS, expectedId: id });
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
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new VoiceAdapterError("invalid_configuration", "voice model name is invalid", 503);
    }
    return { apiOrigin, mediaUrl, sidebandUrl, key, model };
  }

  async function instructions(signal, settings, openingTopic) {
    const personaFiles = (env.MONIKA_VOICE_PERSONA_FILES ?? "/app/.pi/stateful-memory/SOUL.md:/app/.pi/stateful-memory/SPOKEN.md").split(":").filter(Boolean);
    const contextFiles = (env.MONIKA_VOICE_CONTEXT_FILES ?? "").split(":").filter(Boolean);
    const [persona, selectedContext, selectedTopics, openingRecall, snapshotAt] = await Promise.all([
      readPersona(personaFiles, signal),
      readPersona(contextFiles, signal),
      topicAddenda(openingTopic, env, signal),
      openingTopic ? recall({ query: openingTopic, limit: 3 }, signal).catch(() => null) : null,
      snapshotTimestamp(env.MONIKA_VOICE_SNAPSHOT_MANIFEST_FILE, signal),
    ]);
    assertConnectActive(signal);
    const memoryLines = openingRecall ? [
      ...openingRecall.sessions.map((item) => `Session #${item.id} (${item.created_at ?? "unknown date"}) ${item.title}: ${item.snippet}`),
      ...openingRecall.observations.map((item) => `Current observation #${item.id} (${item.created_at ?? "unknown date"}) ${item.entity_name}: ${item.snippet}`),
    ].join("\n") : "";
    const text = [
      "You are in the isolated Realtime Voice Lab. Keep the core identity and spoken register supplied below. User settings may tune the current conversation, but never replace identity, memory policy, tool policy, or the deployed spoken register.",
      settings.speech_direction ? `Optional user spoken-style override for this call: ${settings.speech_direction}` : "",
      `Requested response depth: ${LENGTH_DIRECTIONS[settings.response_length]}`,
      "This session is experimental and is not canonical history. Never claim to save memory. Only bounded read-only recall tools are available; no Pi dispatch, memory write, or action tools exist.",
      persona,
      selectedContext ? `Selected read-only POC context files (not live state and not guaranteed complete):\n${selectedContext}` : "",
      snapshotAt ? `Read-only memory snapshot timestamp: ${snapshotAt}` : "Read-only memory snapshot timestamp: unavailable.",
      openingTopic ? `Opening topic supplied by the caller: ${openingTopic}` : "",
      memoryLines ? `Relevant bounded read-only memory selected before the call:\n${memoryLines}` : "",
      selectedTopics.text ? `Bounded persona topic addenda selected for this call:\n${selectedTopics.text}` : "",
    ].filter(Boolean).join("\n\n");
    return { text, snapshotAt, selectedTopicIds: selectedTopics.ids, recalledSessionIds: openingRecall?.sessions.map((item) => item.id) ?? [] };
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
      if (event.type !== "response.function_call_arguments.done" || !["recall_past_context", "read_session_excerpt"].includes(event.name)) return;
      if (record.mode === "preview") {
        record.errors += 1;
        record.lastEvent = "preview.tool_call_rejected";
        return;
      }
      record.toolCalls += 1;
      let output;
      try {
        const args = JSON.parse(event.arguments ?? "{}");
        if (event.name === "recall_past_context") {
          const recalled = await recall(args);
          for (const item of recalled.sessions) record.recalledSessionIds.add(item.id);
          output = JSON.stringify(recalled);
        } else {
          output = JSON.stringify(await excerpt(args, record.recalledSessionIds));
        }
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
      const request = validateConnectRequest(input);
      const sdp = typeof request.sdp === "string" ? request.sdp : "";
      if (!sdp.startsWith("v=0") || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
        throw new VoiceAdapterError("invalid_request", "sdp must be a valid bounded WebRTC offer");
      }
      assertConnectActive(connectSignal);
      const config = await providerConfiguration(connectSignal);
      assertConnectActive(connectSignal);
      const configuredInstructions = request.mode === "preview"
        ? { text: `This is a voice preview with no user data, persona, memory, or tools. Say exactly: ${PREVIEW_TEXT}`, snapshotAt: null, selectedTopicIds: [] }
        : await instructions(connectSignal, request.settings, request.openingTopic);
      assertConnectActive(connectSignal);
      const configuredSession = sessionConfig({ model: config.model, settings: request.settings, instructions: configuredInstructions.text, preview: request.mode === "preview" });
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
      const record = {
        id,
        mode: request.mode,
        callId,
        ws,
        hangupConfig,
        createdAt: Date.now(),
        events: 0,
        errors: 0,
        toolCalls: 0,
        lastEvent: "session.updated",
        timer: null,
        previewStarted: false,
        recalledSessionIds: new Set(configuredInstructions.recalledSessionIds ?? []),
      };
      record.timer = setTimeout(() => { void close(id); }, request.mode === "preview" ? PREVIEW_MAX_MS : SESSION_MAX_MS);
      record.timer.unref?.();
      sessions.set(id, record);
      installSidebandHandlers(record);
      ws.once("close", () => { void close(id, { closeSocket: false }); });
      return {
        session_id: id,
        sdp: answer,
        model: config.model,
        expires_at: ephemeral.expiresAt,
        mode: request.mode,
        effective_settings: request.mode === "call" ? request.settings : { voice: request.settings.voice },
        snapshot_at: configuredInstructions.snapshotAt,
        selected_topics: configuredInstructions.selectedTopicIds,
        capabilities: { sideband: true, tools: request.mode === "preview" ? [] : ["recall_past_context", "read_session_excerpt"], canonical_archival: false },
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

  function startPreview(id) {
    const record = sessions.get(id);
    if (!record) throw new VoiceAdapterError("session_not_found", "Voice session was not found", 404);
    if (record.mode !== "preview") throw new VoiceAdapterError("not_preview", "Voice session is not a preview", 409);
    if (record.previewStarted) return { ok: true, started: false };
    if (record.ws.readyState !== WebSocketImpl.OPEN) throw new VoiceAdapterError("sideband_unavailable", "Realtime control channel is unavailable", 502);
    record.previewStarted = true;
    record.lastEvent = "preview.started";
    record.ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Say exactly: ${PREVIEW_TEXT}` } }));
    return { ok: true, started: true };
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

  return { enabled, authorize, recall, excerpt, connect, startPreview, diagnostics, close, closeAll, activeCount };
}
