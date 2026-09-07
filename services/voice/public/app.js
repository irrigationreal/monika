const $ = (id) => document.getElementById(id);
const DEFAULT_SPEECH_DIRECTION = "";
// v2 intentionally drops the old baked-in written-style override from existing browsers.
const PREFERENCE_KEY = "monika.voice.preferences.v2";
const PREFERENCE_IDS = ["voice", "speech-direction", "vad-patience", "response-length", "playback-speed", "reasoning-effort"];
const PREVIEW_MAX_MS = 30_000;
const state = {
  csrf: "", pc: null, dc: null, stream: null, sessionId: null, recordId: null,
  muted: false, diagnosticsTimer: null, assistantCaption: null,
  connectController: null, previewController: null, generation: 0, disconnectPromise: null,
};
const closedSessions = new Set();

function readPreferences() {
  try { return JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? "{}"); } catch { return {}; }
}
function savePreferences() {
  const values = Object.fromEntries(PREFERENCE_IDS.map((id) => [id, $(id).value]));
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(values)); } catch { /* preferences remain usable in this page */ }
}
function loadPreferences() {
  const saved = readPreferences();
  $("speech-direction").value = DEFAULT_SPEECH_DIRECTION;
  $("voice").value = "marin";
  $("vad-patience").value = "auto";
  $("response-length").value = "normal";
  $("playback-speed").value = "1";
  $("reasoning-effort").value = "low";
  for (const id of PREFERENCE_IDS) {
    const element = $(id);
    if (typeof saved[id] === "string" && (!element.options || [...element.options].some((option) => option.value === saved[id]))) element.value = saved[id];
  }
}
function effectiveSettings() {
  const speed = Number($("playback-speed").value);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 1.5) throw new Error("Playback speed must be from 0.25 to 1.5");
  const direction = $("speech-direction").value.trim();
  return {
    voice: $("voice").value,
    speech_direction: direction,
    vad_patience: $("vad-patience").value,
    response_length: $("response-length").value,
    playback_speed: speed,
    reasoning_effort: $("reasoning-effort").value,
  };
}
function lockSettings(locked) { $("pre-call-settings").disabled = locked; }

function setStatus(text, live = false) {
  $("status").textContent = text;
  $("status-dot").classList.toggle("live", live);
}
function setError(value) { $("errors").textContent = value ? String(value) : ""; }

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== "GET") headers.set("x-csrf-token", state.csrf);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
  return body;
}

async function recordFor(recordId, event, { signal } = {}) {
  if (!recordId) return;
  try { await api(`/api/records/${recordId}/events`, { method: "POST", body: JSON.stringify(event), signal }); } catch { /* recording must not interrupt media */ }
}

function record(event) { return recordFor(state.recordId, event); }

async function closeProviderSession(sessionId) {
  if (!sessionId || closedSessions.has(sessionId)) return;
  closedSessions.add(sessionId);
  try { await api(`/api/realtime/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* provider session may already be closed */ }
}

function caption(role, text, append = false) {
  let item = append && role === "assistant" ? state.assistantCaption : null;
  if (!item) {
    item = document.createElement("div");
    item.className = `caption ${role}`;
    const label = document.createElement("span");
    label.className = "role";
    label.textContent = role;
    const content = document.createElement("span");
    item.append(label, content);
    $("captions").append(item);
    if (role === "assistant") state.assistantCaption = item;
  }
  const content = item.lastElementChild;
  content.textContent = append ? content.textContent + text : text;
  $("captions").scrollTop = $("captions").scrollHeight;
}

function showDiagnostics(values) {
  const target = $("diagnostics");
  target.replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key.replaceAll("_", " ");
    dd.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
    target.append(dt, dd);
  }
}

function handleEvent(event) {
  if (!event || typeof event.type !== "string") return;
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const text = event.transcript ?? "";
    caption("user", text);
    void record({ type: "transcript", role: "user", text });
  } else if (event.type === "response.output_audio_transcript.delta") {
    caption("assistant", event.delta ?? "", true);
  } else if (event.type === "response.output_audio_transcript.done") {
    const text = event.transcript ?? state.assistantCaption?.lastElementChild?.textContent ?? "";
    if (!state.assistantCaption && text) caption("assistant", text);
    state.assistantCaption = null;
    void record({ type: "transcript", role: "assistant", text });
  } else if (event.type === "input_audio_buffer.speech_started") {
    setStatus("Listening · interruption enabled", true);
    void record({ type: "interruption", event: "speech_started" });
  } else if (event.type === "response.created") {
    setStatus("Monika is responding", true);
  } else if (event.type === "response.done") {
    setStatus("Connected", true);
    if (event.response?.usage) void record({ type: "usage", usage: event.response.usage });
    showDiagnostics({ connection: "connected", usage: event.response?.usage ?? "not reported", sideband_tools: "server-owned" });
  } else if (event.type === "error") {
    const message = event.error?.message ?? "Realtime provider error";
    setError(message);
    void record({ type: "error", message });
  }
}

function waitForIce(pc, signal, timeoutMs = 5_000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === "complete") finish(); };
    const onAbort = () => finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(), timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function ensureCurrent(generation, signal) {
  if (generation !== state.generation || signal.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
}

function waitForPeerConnected(pc, signal) {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      pc.removeEventListener("connectionstatechange", onChange);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onChange = () => {
      if (pc.connectionState === "connected") finish();
      else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) finish(new Error("Preview media connection failed"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    pc.addEventListener("connectionstatechange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForDataChannelOpen(dc, signal) {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(new Error("Preview event channel closed"));
    const onAbort = () => finish(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    dc.addEventListener("open", onOpen, { once: true });
    dc.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function stopLocalMedia(pc, dc, stream) {
  if (pc) pc.onconnectionstatechange = null;
  if (dc) dc.onclose = null;
  try { dc?.close(); } catch { /* already closed */ }
  try { pc?.close(); } catch { /* already closed */ }
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

async function previewVoice() {
  if (state.pc || state.connectController || state.previewController) return;
  const controller = new AbortController();
  state.previewController = controller;
  let pc;
  let dc;
  let sessionId;
  let finishPreview;
  const previewDone = new Promise((resolve) => { finishPreview = resolve; });
  const cleanupTimer = setTimeout(() => controller.abort(), PREVIEW_MAX_MS);
  $("preview").disabled = true;
  setError("");
  setStatus("Preparing voice preview…");
  try {
    pc = new RTCPeerConnection();
    pc.addTransceiver("audio", { direction: "recvonly" });
    let markTrackReady;
    const trackReady = new Promise((resolve) => { markTrackReady = resolve; });
    pc.ontrack = (event) => {
      $("remote-audio").srcObject = event.streams[0];
      markTrackReady();
    };
    dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event.type === "output_audio_buffer.stopped") finishPreview();
      } catch { /* preview provider diagnostics are non-authoritative */ }
    };
    dc.onclose = finishPreview;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, controller.signal);
    const result = await api("/api/realtime/preview", {
      method: "POST",
      body: JSON.stringify({ sdp: pc.localDescription.sdp, voice: $("voice").value }),
      signal: controller.signal,
    });
    sessionId = result.session_id;
    await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
    await Promise.all([waitForPeerConnected(pc, controller.signal), waitForDataChannelOpen(dc, controller.signal), trackReady]);
    await $("remote-audio").play();
    await api(`/api/realtime/sessions/${sessionId}/preview-start`, { method: "POST", body: "{}", signal: controller.signal });
    setStatus("Playing preview", true);
    await Promise.race([
      previewDone,
      new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true })),
    ]);
  } catch (error) {
    if (!controller.signal.aborted) setError(error.message);
  } finally {
    clearTimeout(cleanupTimer);
    controller.abort();
    stopLocalMedia(pc, dc, null);
    $("remote-audio").pause();
    $("remote-audio").srcObject = null;
    await closeProviderSession(sessionId);
    if (state.previewController === controller) state.previewController = null;
    $("preview").disabled = false;
    if (!state.pc && !state.connectController) setStatus("Disconnected");
  }
}

async function connect() {
  if (state.pc || state.connectController || state.previewController) return;
  const controller = new AbortController();
  const generation = ++state.generation;
  state.connectController = controller;
  let stream;
  let pc;
  let dc;
  let sessionId;
  let recordId;
  setError("");
  let requestedSettings;
  try { requestedSettings = effectiveSettings(); } catch (error) { state.connectController = null; setError(error.message); return; }
  savePreferences();
  lockSettings(true);
  setStatus("Requesting microphone…");
  $("captions").replaceChildren();
  state.assistantCaption = null;
  $("connect").disabled = true;
  $("disconnect").disabled = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $("device").value ? { exact: $("device").value } : undefined } });
    ensureCurrent(generation, controller.signal);
    state.stream = stream;
    pc = new RTCPeerConnection();
    state.pc = pc;
    pc.ontrack = (event) => { if (generation === state.generation) $("remote-audio").srcObject = event.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (generation !== state.generation) return;
      setStatus(pc.connectionState === "connected" ? "Connected" : pc.connectionState, pc.connectionState === "connected");
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) void disconnect();
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    dc = pc.createDataChannel("oai-events");
    state.dc = dc;
    dc.onmessage = ({ data }) => {
      if (generation !== state.generation) return;
      try { handleEvent(JSON.parse(data)); } catch { setError("Malformed provider event"); }
    };
    dc.onerror = () => { if (generation === state.generation) setError("Realtime event channel error"); };
    dc.onclose = () => { if (generation === state.generation) void disconnect(); };
    const offer = await pc.createOffer();
    ensureCurrent(generation, controller.signal);
    await pc.setLocalDescription(offer);
    ensureCurrent(generation, controller.signal);
    await waitForIce(pc, controller.signal);
    ensureCurrent(generation, controller.signal);
    setStatus("Establishing protected control channel…");
    const result = await api("/api/realtime/connect", {
      method: "POST",
      body: JSON.stringify({ sdp: pc.localDescription.sdp, settings: requestedSettings, opening_topic: $("opening-topic").value.trim() }),
      signal: controller.signal,
    });
    sessionId = result.session_id;
    ensureCurrent(generation, controller.signal);
    state.sessionId = sessionId;
    await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
    ensureCurrent(generation, controller.signal);
    const created = await api("/api/records", { method: "POST", body: "{}", signal: controller.signal });
    recordId = created.id;
    ensureCurrent(generation, controller.signal);
    state.recordId = recordId;
    await recordFor(recordId, { type: "status", status: "connected", model: result.model, capabilities: result.capabilities, effective_settings: result.effective_settings, snapshot_at: result.snapshot_at, selected_topics: result.selected_topics }, { signal: controller.signal });
    ensureCurrent(generation, controller.signal);
    $("mute").disabled = false;
    setStatus("Connected", true);
    $("snapshot-time").textContent = `Memory snapshot timestamp: ${result.snapshot_at ? new Date(result.snapshot_at).toLocaleString() : "unavailable"}`;
    showDiagnostics({ model: result.model, voice: result.effective_settings.voice, vad_patience: result.effective_settings.vad_patience, response_length: result.effective_settings.response_length, playback_speed: result.effective_settings.playback_speed, reasoning_effort: result.effective_settings.reasoning_effort, snapshot_at: result.snapshot_at ?? "unavailable", selected_topics: result.selected_topics.join(", ") || "none", sideband: result.capabilities.sideband, tools: result.capabilities.tools.join(", "), archival: "experimental local JSONL only" });
    state.diagnosticsTimer = setInterval(async () => {
      if (generation !== state.generation || !state.sessionId) return;
      try { showDiagnostics(await api(`/api/realtime/sessions/${state.sessionId}/diagnostics`)); }
      catch { if (generation === state.generation) void disconnect(); }
    }, 5000);
  } catch (error) {
    const cancelled = controller.signal.aborted || generation !== state.generation;
    stopLocalMedia(pc, dc, stream);
    if (cancelled) {
      await state.disconnectPromise;
      await closeProviderSession(sessionId);
    } else {
      setError(error.message);
      await disconnect({ finalStatus: "Connection failed" });
    }
  } finally {
    if (state.connectController === controller) state.connectController = null;
    if (!state.pc) {
      lockSettings(false);
      $("connect").disabled = false;
      $("disconnect").disabled = true;
    }
  }
}

async function disconnect({ finalStatus = "Disconnected" } = {}) {
  if (state.disconnectPromise) return state.disconnectPromise;
  ++state.generation;
  state.connectController?.abort();
  state.previewController?.abort();
  clearInterval(state.diagnosticsTimer);
  state.diagnosticsTimer = null;
  const sessionId = state.sessionId;
  const recordId = state.recordId;
  const pc = state.pc;
  const dc = state.dc;
  const stream = state.stream;
  state.sessionId = null;
  state.recordId = null;
  state.dc = null;
  state.pc = null;
  state.stream = null;
  state.assistantCaption = null;
  state.muted = false;

  // Local media must stop before any record or provider network cleanup is awaited.
  stopLocalMedia(pc, dc, stream);
  $("connect").disabled = Boolean(state.connectController);
  $("disconnect").disabled = true;
  $("mute").disabled = true;
  $("mute").textContent = "Mute";
  lockSettings(false);
  setStatus(finalStatus);

  const completion = (async () => {
    await recordFor(recordId, { type: "status", status: "disconnected" });
    await closeProviderSession(sessionId);
    await loadRecords();
  })();
  state.disconnectPromise = completion;
  try { await completion; }
  finally { if (state.disconnectPromise === completion) state.disconnectPromise = null; }
}

async function loadDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
  $("device").replaceChildren();
  for (const [index, device] of devices.entries()) {
    const option = document.createElement("option"); option.value = device.deviceId; option.textContent = device.label || `Microphone ${index + 1}`; $("device").append(option);
  }
}

async function loadRecords() {
  const list = $("records"); list.replaceChildren();
  try {
    const { records } = await api("/api/records");
    for (const item of records) {
      const li = document.createElement("li");
      const label = document.createElement("span"); label.textContent = `${new Date(item.created_at).toLocaleString()} · ${item.size} bytes`;
      const download = document.createElement("a"); download.href = `/api/records/${item.id}/export`; download.textContent = "Export";
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete";
      remove.addEventListener("click", async () => { await api(`/api/records/${item.id}`, { method: "DELETE" }); await loadRecords(); });
      li.append(label, download, remove); list.append(li);
    }
    if (!records.length) { const li = document.createElement("li"); li.textContent = "No retained records."; list.append(li); }
  } catch (error) { setError(error.message); }
}

async function authenticated() {
  try {
    const result = await api("/api/session"); state.csrf = result.csrf; return true;
  } catch { return false; }
}
async function enterLab() {
  $("login-panel").hidden = true; $("lab").hidden = false;
  await loadDevices().catch(() => {}); await loadRecords();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-error").textContent = "";
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: $("passphrase").value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Login failed");
    state.csrf = result.csrf; $("passphrase").value = ""; await enterLab();
  } catch (error) { $("login-error").textContent = error.message; }
});
loadPreferences();
for (const id of PREFERENCE_IDS) $(id).addEventListener("change", savePreferences);
$("speech-direction").addEventListener("input", savePreferences);
$("reset-speech-direction").addEventListener("click", () => { $("speech-direction").value = DEFAULT_SPEECH_DIRECTION; savePreferences(); });
$("preview").addEventListener("click", previewVoice);
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", disconnect);
$("mute").addEventListener("click", () => {
  state.muted = !state.muted;
  for (const track of state.stream?.getAudioTracks?.() ?? []) track.enabled = !state.muted;
  $("mute").textContent = state.muted ? "Unmute" : "Mute";
  setStatus(state.muted ? "Muted" : "Connected", true);
});
$("refresh-records").addEventListener("click", loadRecords);
$("logout").addEventListener("click", async () => { await disconnect(); await api("/api/logout", { method: "POST", body: "{}" }); location.reload(); });
navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (!state.pc && !state.connectController) void loadDevices(); });

if (await authenticated()) await enterLab();
