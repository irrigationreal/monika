import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVoiceServer } from "../src/server.mjs";

const ORIGIN = "https://voice.example:8443";

async function start(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const passphrase = path.join(root, "passphrase");
  const token = path.join(root, "token");
  await writeFile(passphrase, "correct horse\n", { mode: 0o600 });
  await writeFile(token, "agentd-token\n", { mode: 0o600 });
  const agentRequests = [];
  const fixture = await createVoiceServer({
    env: {
      VOICE_PUBLIC_ORIGIN: ORIGIN,
      VOICE_PASSPHRASE_FILE: passphrase,
      VOICE_AGENTD_TOKEN_FILE: token,
      VOICE_STATE_DIR: path.join(root, "records"),
      MONIKA_AGENTD_BASE_URL: "http://agentd.test:7724",
      ...overrides.env,
    },
    now: overrides.now,
    fetchImpl: overrides.fetchImpl ?? (async (url, options) => {
      agentRequests.push({ url, options });
      return Response.json({ ok: true }, { status: 200 });
    }),
  });
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const base = `http://127.0.0.1:${fixture.server.address().port}`;
  return { ...fixture, base, agentRequests };
}

async function call(base, route, { method = "GET", body, cookie, csrf, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  return { response, result };
}

async function login(base) {
  const { response, result } = await call(base, "/api/login", { method: "POST", origin: ORIGIN, body: { passphrase: "correct horse" } });
  return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: result.csrf };
}

test("startup fails closed without configured secret files or HTTPS origin", async () => {
  await assert.rejects(createVoiceServer({ env: {} }), /HTTPS origin/);
});

test("authentication, same-origin CSRF, logout, and exact agentd proxy boundaries", async (t) => {
  const { base, agentRequests } = await start(t);
  assert.equal((await call(base, "/api/records")).response.status, 401);
  assert.equal((await call(base, "/api/login", { method: "POST", origin: "https://evil.example", body: { passphrase: "correct horse" } })).response.status, 403);
  assert.equal((await call(base, "/api/login", { method: "POST", origin: ORIGIN, body: { passphrase: "wrong" } })).response.status, 401);

  const auth = await login(base);
  const cookieHeader = (await fetch(`${base}/api/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ passphrase: "correct horse" }) })).headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /Secure/);
  assert.match(cookieHeader, /SameSite=Strict/);

  assert.equal((await call(base, "/api/realtime/connect", { method: "POST", cookie: auth.cookie, origin: ORIGIN, body: { sdp: "v=0" } })).response.status, 403);
  assert.equal((await call(base, "/api/realtime/connect", { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: "https://evil.example", body: { sdp: "v=0" } })).response.status, 403);
  assert.equal((await call(base, "/api/realtime/connect", { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: { sdp: "v=0" } })).response.status, 200);
  assert.equal(agentRequests.length, 1);
  assert.equal(agentRequests[0].url, "http://agentd.test:7724/v1/voice/connect");
  assert.equal(agentRequests[0].options.headers["x-monika-voice-token"], "agentd-token");
  assert.equal((await call(base, "/api/v1/admin/quiescence", { cookie: auth.cookie })).response.status, 404);
  assert.equal(agentRequests.length, 1);

  assert.equal((await call(base, "/api/logout", { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: {} })).response.status, 200);
  assert.equal((await call(base, "/api/session", { cookie: auth.cookie })).response.status, 401);
});

test("server sessions expire and fail closed", async (t) => {
  let clock = 1_000;
  const { base } = await start(t, { now: () => clock, env: { VOICE_SESSION_TTL_MS: "10" } });
  const auth = await login(base);
  assert.equal((await call(base, "/api/session", { cookie: auth.cookie })).response.status, 200);
  clock += 11;
  assert.equal((await call(base, "/api/session", { cookie: auth.cookie })).response.status, 401);
});

test("experimental record create, bounded append, export, and delete lifecycle", async (t) => {
  const { base } = await start(t);
  const auth = await login(base);
  const created = await call(base, "/api/records", { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: {} });
  assert.equal(created.response.status, 201);
  const id = created.result.id;
  assert.equal((await call(base, `/api/records/${id}/events`, { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: { type: "transcript", role: "user", text: "hello" } })).response.status, 200);
  assert.equal((await call(base, `/api/records/${id}/events`, { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: { type: "tool_write", text: "no" } })).response.status, 400);
  const exported = await fetch(`${base}/api/records/${id}/export`, { headers: { cookie: auth.cookie } });
  const text = await exported.text();
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), new RegExp(id));
  assert.match(text, /"experimental":true/);
  assert.match(text, /"canonical":false/);
  assert.match(text, /"text":"hello"/);
  assert.equal((await call(base, `/api/records/${id}`, { method: "DELETE", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: {} })).response.status, 200);
  assert.equal((await fetch(`${base}/api/records/${id}/export`, { headers: { cookie: auth.cookie } })).status, 404);
});

test("closing the browser response aborts the in-flight agentd connect", async (t) => {
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  const { base } = await start(t, {
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      markStarted();
      options.signal.addEventListener("abort", () => {
        markAborted();
        reject(options.signal.reason);
      }, { once: true });
    }),
  });
  const auth = await login(base);
  const controller = new AbortController();
  const connecting = fetch(`${base}/api/realtime/connect`, {
    method: "POST",
    headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(connecting, /abort/i);
  await aborted;
});

test("a late agentd success after observed browser cancellation is explicitly closed", { timeout: 10_000 }, async (t) => {
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  let markStarted;
  let releaseConnect;
  let markAgentdAbort;
  let markCleaned;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  const agentdAbort = new Promise((resolve) => { markAgentdAbort = resolve; });
  const cleaned = new Promise((resolve) => { markCleaned = resolve; });
  const { base } = await start(t, {
    fetchImpl: async (url, options) => {
      if (url.endsWith("/v1/voice/connect")) {
        markStarted();
        options.signal.addEventListener("abort", markAgentdAbort, { once: true });
        if (options.signal.aborted) markAgentdAbort();
        await connectGate;
        return Response.json({ session_id: sessionId, sdp: "v=0" }, { status: 201 });
      }
      if (url.endsWith(`/v1/voice/sessions/${sessionId}`)) {
        markCleaned();
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected agentd request: ${url}`);
    },
  });
  const auth = await login(base);
  const controller = new AbortController();
  const connecting = fetch(`${base}/api/realtime/connect`, {
    method: "POST",
    headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(connecting, /abort/i);
  await agentdAbort;
  releaseConnect();
  await cleaned;
});

test("failed agentd responses are bounded and passed without credential leakage", async (t) => {
  const { base } = await start(t, { fetchImpl: async () => Response.json({ error: "provider_rejected", message: "safe message" }, { status: 502 }) });
  const auth = await login(base);
  const result = await call(base, "/api/realtime/connect", { method: "POST", cookie: auth.cookie, csrf: auth.csrf, origin: ORIGIN, body: { sdp: "v=0" } });
  assert.equal(result.response.status, 502);
  assert.deepEqual(result.result, { error: "provider_rejected", message: "safe message" });
});
