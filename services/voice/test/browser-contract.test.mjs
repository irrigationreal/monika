import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const indexUrl = new URL("../public/index.html", import.meta.url);
const appUrl = new URL("../public/app.js", import.meta.url);
const bffUrl = new URL("../src/server.mjs", import.meta.url);
const adapterUrl = new URL("../../agentd/src/voice-adapter.mjs", import.meta.url);

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
  const disconnect = app.indexOf("async function disconnect");
  const stop = app.indexOf("stopLocalMedia(pc, dc, stream);", disconnect);
  const record = app.indexOf("await recordFor(recordId", disconnect);
  assert.ok(stop >= 0 && record > stop, "disconnect must stop local media before record I/O");
});

test("BFF connect deadline covers the adapter deadline and bounded hangup", async () => {
  const [bff, adapter] = await Promise.all([readFile(bffUrl, "utf8"), readFile(adapterUrl, "utf8")]);
  const bffDeadline = numericConstant(bff, "AGENTD_CONNECT_TIMEOUT_MS");
  const backendDeadline = numericConstant(adapter, "CONNECT_MAX_MS");
  const hangupDeadline = numericConstant(adapter, "HANGUP_TIMEOUT_MS");
  assert.equal(bffDeadline >= backendDeadline + hangupDeadline, true);
});
