import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const indexUrl = new URL("../public/index.html", import.meta.url);
const appUrl = new URL("../public/app.js", import.meta.url);
const bffUrl = new URL("../src/server.mjs", import.meta.url);
const adapterUrl = new URL("../../agentd/src/voice-adapter.mjs", import.meta.url);
const composeUrl = new URL("../../../tests/compose.voice-poc.yaml", import.meta.url);
const containerfileUrl = new URL("../../../Containerfile", import.meta.url);
const spokenUrl = new URL("../../../config/persona/SPOKEN.md", import.meta.url);

function numericConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `${name} must remain explicit`);
  return Number(match[1].replaceAll("_", ""));
}

test("browser entrypoint remains an executable module with cancellable bounded setup", async () => {
  const [html, app] = await Promise.all([readFile(indexUrl, "utf8"), readFile(appUrl, "utf8")]);
  assert.match(html, /<script\s+src="\/app\.js"\s+type="module"><\/script>/);
  const checked = spawnSync(process.execPath, ["--check", appUrl.pathname], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /function waitForIce\([^)]*timeoutMs = 5_000\)/);
  assert.match(app, /\["disconnected", "failed", "closed"\]/);
  assert.match(app, /\$\("captions"\)\.replaceChildren\(\)/);
  assert.match(app, /generation !== state\.generation/);
  assert.match(app, /localStorage\.setItem\(PREFERENCE_KEY/);
  assert.match(app, /lockSettings\(true\)/);
  assert.match(app, /lockSettings\(false\)/);
  assert.match(app, /addTransceiver\("audio", \{ direction: "recvonly" \}\)/);
  assert.match(app, /\/api\/realtime\/preview/);
  const preview = app.slice(app.indexOf("async function previewVoice"), app.indexOf("async function connect"));
  assert.doesNotMatch(preview, /getUserMedia/);
  assert.doesNotMatch(preview, /opening-topic|speech-direction|recall/);
  assert.match(preview, /createDataChannel\("oai-events"\)/);
  assert.match(preview, /output_audio_buffer\.stopped/);
  assert.match(preview, /PREVIEW_MAX_MS/);
  const applied = preview.indexOf("setRemoteDescription");
  const connected = preview.indexOf("waitForPeerConnected", applied);
  const eventsReady = preview.indexOf("waitForDataChannelOpen", connected);
  const played = preview.indexOf('.play()', eventsReady);
  const started = preview.indexOf("/preview-start", played);
  assert.ok(applied >= 0 && connected > applied && eventsReady > connected && played > eventsReady && started > played, "preview must start only after SDP, media/event readiness, and explicit audio playback");
  assert.match(html, /Uses the selected Realtime model and API credits\. No microphone, persona, memories, or tools are used/);
  assert.equal((html.match(/<option value="(?:alloy|ash|ballad|coral|echo|sage|shimmer|verse|marin|cedar)">/g) ?? []).length, 10);
  const disconnect = app.indexOf("async function disconnect");
  const stop = app.indexOf("stopLocalMedia(pc, dc, stream);", disconnect);
  const record = app.indexOf("await recordFor(recordId", disconnect);
  assert.ok(stop >= 0 && record > stop, "disconnect must stop local media before record I/O");
});

test("voice context uses a first-class spoken register instead of written style files", async () => {
  const [adapter, compose, containerfile, spoken] = await Promise.all([
    readFile(adapterUrl, "utf8"),
    readFile(composeUrl, "utf8"),
    readFile(containerfileUrl, "utf8"),
    readFile(spokenUrl, "utf8"),
  ]);
  assert.match(adapter, /SOUL\.md:\/app\/\.pi\/stateful-memory\/SPOKEN\.md/);
  const adapterDefault = adapter.match(/MONIKA_VOICE_PERSONA_FILES \?\? "([^"]+)"/)?.[1] ?? "";
  assert.doesNotMatch(adapterDefault, /STYLE\.md|REGISTER\.md|PERSONALITY_MATRIX\.md/);
  const voicePersona = compose.match(/MONIKA_VOICE_PERSONA_FILES: ([^\n]+)/)?.[1] ?? "";
  assert.match(voicePersona, /SOUL\.md:.*SPOKEN\.md/);
  assert.doesNotMatch(voicePersona, /STYLE\.md|REGISTER\.md|PERSONALITY_MATRIX\.md/);
  assert.match(containerfile, /COPY config\/persona\/SPOKEN\.md\s+\/app\/\.pi\/stateful-memory\/SPOKEN\.md/);
  assert.match(spoken, /Brevity is a conversational default, not a ceiling/);
  assert.match(spoken, /Do not pronounce written laughter tokens/);
});

test("BFF connect deadline covers the adapter deadline and bounded hangup", async () => {
  const [bff, adapter] = await Promise.all([readFile(bffUrl, "utf8"), readFile(adapterUrl, "utf8")]);
  const bffDeadline = numericConstant(bff, "AGENTD_CONNECT_TIMEOUT_MS");
  const backendDeadline = numericConstant(adapter, "CONNECT_MAX_MS");
  const hangupDeadline = numericConstant(adapter, "HANGUP_TIMEOUT_MS");
  assert.equal(bffDeadline >= backendDeadline + hangupDeadline, true);
});
