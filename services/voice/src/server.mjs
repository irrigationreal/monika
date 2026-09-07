import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VoiceRecords } from "./records.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(HERE, "../public");
const COOKIE = "monika_voice_session";
const MAX_JSON_BYTES = 160 * 1024;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;
const MAX_SERVER_SESSIONS = 128;
const AGENTD_TIMEOUT_MS = 15_000;
const AGENTD_CONNECT_TIMEOUT_MS = 40_000;

function parsePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

function cookieValue(req) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return "";
}

async function readSecret(file, label) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${label} file path must be absolute`);
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024) throw new Error(`${label} file is invalid`);
    const value = (await handle.readFile("utf8")).trim();
    if (!value || value.includes("\n") || value.includes("\r")) throw new Error(`${label} file is invalid`);
    return value;
  } finally { await handle.close(); }
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left ?? "")).digest();
  const b = createHash("sha256").update(String(right ?? "")).digest();
  return timingSafeEqual(a, b);
}

function validOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("VOICE_PUBLIC_ORIGIN must be an HTTPS origin"); }
  if (!/^https:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("VOICE_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  return parsed.origin;
}

export async function createVoiceServer({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const publicOrigin = validOrigin(env.VOICE_PUBLIC_ORIGIN ?? "");
  const passphrase = await readSecret(env.VOICE_PASSPHRASE_FILE, "voice passphrase");
  const internalToken = await readSecret(env.VOICE_AGENTD_TOKEN_FILE, "agentd token");
  const agentdBase = new URL(env.MONIKA_AGENTD_BASE_URL ?? "http://monika-voice:7724");
  if (agentdBase.protocol !== "http:" || agentdBase.username || agentdBase.password || agentdBase.search || agentdBase.hash || (agentdBase.pathname !== "/" && agentdBase.pathname !== "")) {
    throw new Error("MONIKA_AGENTD_BASE_URL must be an HTTP service origin");
  }
  const sessionTtlMs = parsePositive(env.VOICE_SESSION_TTL_MS, 8 * 60 * 60 * 1000);
  const records = new VoiceRecords({
    dir: env.VOICE_STATE_DIR ?? "/data/voice",
    maxAgeMs: parsePositive(env.VOICE_RECORD_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000),
    maxFiles: parsePositive(env.VOICE_RECORD_MAX_FILES, 50),
    maxTotalBytes: parsePositive(env.VOICE_RECORD_MAX_TOTAL_BYTES, 20 * 1024 * 1024),
  });
  await records.initialize();
  const sessions = new Map();
  const loginAttempts = new Map();

  function session(req) {
    const token = cookieValue(req);
    const value = sessions.get(token);
    if (!value) return null;
    if (value.expiresAt <= now()) { sessions.delete(token); return null; }
    return { token, ...value };
  }

  function requireOrigin(req, res) {
    if (req.headers.origin !== publicOrigin) {
      json(res, 403, { error: "origin_rejected" });
      return false;
    }
    return true;
  }

  function requireAuth(req, res, { csrf = false } = {}) {
    const active = session(req);
    if (!active) { json(res, 401, { error: "authentication_required" }); return null; }
    if (csrf) {
      if (!requireOrigin(req, res)) return null;
      if (!safeEqual(req.headers["x-csrf-token"], active.csrf)) {
        json(res, 403, { error: "csrf_rejected" });
        return null;
      }
    }
    return active;
  }

  async function agentd(route, options = {}, timeoutMs = AGENTD_TIMEOUT_MS) {
    let response;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await fetchImpl(`${agentdBase.origin}${route}`, {
        ...options,
        headers: { ...options.headers, "x-monika-voice-token": internalToken },
        signal,
      });
    } catch {
      return { status: 502, body: { error: "agentd_unavailable" } };
    }
    let body;
    try { body = await response.json(); } catch { body = { error: "invalid_agentd_response" }; }
    return { status: response.status, body };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "microphone=(self)");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? "/", "http://voice.invalid");
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

      if (method === "POST" && url.pathname === "/api/login") {
        if (!requireOrigin(req, res)) return;
        const ip = req.socket.remoteAddress ?? "unknown";
        const recent = (loginAttempts.get(ip) ?? []).filter((time) => now() - time < LOGIN_WINDOW_MS);
        if (recent.length >= LOGIN_ATTEMPTS) return json(res, 429, { error: "login_rate_limited" }, { "retry-after": "300" });
        const body = await readJson(req);
        if (!safeEqual(body.passphrase, passphrase)) {
          recent.push(now()); loginAttempts.set(ip, recent);
          return json(res, 401, { error: "invalid_credentials" });
        }
        loginAttempts.delete(ip);
        for (const [token, active] of sessions) if (active.expiresAt <= now()) sessions.delete(token);
        if (sessions.size >= MAX_SERVER_SESSIONS) {
          const oldest = [...sessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
          if (oldest) sessions.delete(oldest[0]);
        }
        const token = randomBytes(32).toString("base64url");
        const csrf = randomBytes(24).toString("base64url");
        sessions.set(token, { csrf, createdAt: now(), expiresAt: now() + sessionTtlMs });
        return json(res, 200, { ok: true, csrf, expires_at: now() + sessionTtlMs }, {
          "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`,
        });
      }

      if (method === "GET" && url.pathname === "/api/session") {
        const active = requireAuth(req, res);
        if (!active) return;
        return json(res, 200, { authenticated: true, csrf: active.csrf, expires_at: active.expiresAt });
      }
      if (method === "POST" && url.pathname === "/api/logout") {
        const active = requireAuth(req, res, { csrf: true });
        if (!active) return;
        sessions.delete(active.token);
        return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      }
      if (method === "POST" && ["/api/realtime/connect", "/api/realtime/preview"].includes(url.pathname)) {
        if (!requireAuth(req, res, { csrf: true })) return;
        const preview = url.pathname === "/api/realtime/preview";
        const controller = new AbortController();
        let connectedSessionId = null;
        let cleanupPromise = null;
        const cleanupConnected = () => {
          if (!connectedSessionId) return Promise.resolve();
          cleanupPromise ??= agentd(`/v1/voice/sessions/${connectedSessionId}`, { method: "DELETE" });
          return cleanupPromise;
        };
        const abortAgentd = () => {
          controller.abort();
          void cleanupConnected();
        };
        const abortOnResponseClose = () => { if (!res.writableEnded) abortAgentd(); };
        req.once("aborted", abortAgentd);
        res.once("close", abortOnResponseClose);
        if (req.aborted || res.destroyed) abortAgentd();
        try {
          const body = await readJson(req);
          const keys = Object.keys(body);
          let agentdBody;
          if (preview) {
            if (keys.some((key) => !["sdp", "voice"].includes(key))) return json(res, 400, { error: "bad_request", message: "preview accepts only sdp and voice" });
            agentdBody = { mode: "preview", sdp: body.sdp, voice: body.voice };
          } else {
            if (keys.some((key) => !["sdp", "settings", "opening_topic"].includes(key))) return json(res, 400, { error: "bad_request", message: "connect contains an unsupported field" });
            agentdBody = { mode: "call", sdp: body.sdp, settings: body.settings, opening_topic: body.opening_topic };
          }
          if (controller.signal.aborted) return;
          const result = await agentd("/v1/voice/connect", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(agentdBody),
            signal: controller.signal,
          }, AGENTD_CONNECT_TIMEOUT_MS);
          if (result.status === 201 && /^[0-9a-f-]{36}$/.test(result.body?.session_id ?? "")) connectedSessionId = result.body.session_id;
          if (controller.signal.aborted || res.destroyed) {
            await cleanupConnected();
            return;
          }
          return json(res, result.status, result.body);
        } finally {
          req.off("aborted", abortAgentd);
          res.off("close", abortOnResponseClose);
        }
      }
      if (method === "POST" && url.pathname === "/api/recall") {
        if (!requireAuth(req, res, { csrf: true })) return;
        const result = await agentd("/v1/voice/recall", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await readJson(req)) });
        return json(res, result.status, result.body);
      }
      const previewStartMatch = url.pathname.match(/^\/api\/realtime\/sessions\/([0-9a-f-]{36})\/preview-start$/);
      if (previewStartMatch && method === "POST") {
        if (!requireAuth(req, res, { csrf: true })) return;
        const result = await agentd(`/v1/voice/sessions/${previewStartMatch[1]}/preview-start`, { method: "POST" });
        return json(res, result.status, result.body);
      }
      const realtimeMatch = url.pathname.match(/^\/api\/realtime\/sessions\/([0-9a-f-]{36})(?:\/diagnostics)?$/);
      if (realtimeMatch && method === "GET" && url.pathname.endsWith("/diagnostics")) {
        if (!requireAuth(req, res)) return;
        const result = await agentd(`/v1/voice/sessions/${realtimeMatch[1]}/diagnostics`);
        return json(res, result.status, result.body);
      }
      if (realtimeMatch && method === "DELETE" && !url.pathname.endsWith("/diagnostics")) {
        if (!requireAuth(req, res, { csrf: true })) return;
        const result = await agentd(`/v1/voice/sessions/${realtimeMatch[1]}`, { method: "DELETE" });
        return json(res, result.status, result.body);
      }
      if (method === "POST" && url.pathname === "/api/records") {
        if (!requireAuth(req, res, { csrf: true })) return;
        return json(res, 201, await records.create());
      }
      if (method === "GET" && url.pathname === "/api/records") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, { records: await records.list() });
      }
      const recordMatch = url.pathname.match(/^\/api\/records\/([0-9a-f-]{36})(?:\/events|\/export)?$/);
      if (recordMatch && method === "POST" && url.pathname.endsWith("/events")) {
        if (!requireAuth(req, res, { csrf: true })) return;
        const exists = await records.append(recordMatch[1], await readJson(req));
        return json(res, exists ? 200 : 404, exists ? { ok: true } : { error: "record_not_found" });
      }
      if (recordMatch && method === "GET" && url.pathname.endsWith("/export")) {
        if (!requireAuth(req, res)) return;
        const data = await records.read(recordMatch[1]);
        if (!data) return json(res, 404, { error: "record_not_found" });
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-length": data.length, "content-disposition": `attachment; filename="voice-${recordMatch[1]}.jsonl"` });
        return res.end(data);
      }
      if (recordMatch && method === "DELETE" && !url.pathname.endsWith("/events") && !url.pathname.endsWith("/export")) {
        if (!requireAuth(req, res, { csrf: true })) return;
        const deleted = await records.delete(recordMatch[1]);
        return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "record_not_found" });
      }

      const staticFiles = new Map([["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/style.css", ["style.css", "text/css; charset=utf-8"]]]);
      if (method === "GET" && staticFiles.has(url.pathname)) {
        const [name, type] = staticFiles.get(url.pathname);
        const data = await fs.readFile(path.join(STATIC_DIR, name));
        res.writeHead(200, { "content-type": type, "content-length": data.length });
        return res.end(data);
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof SyntaxError ? "invalid JSON" : error?.message;
      if (["invalid JSON", "request body is too large", "request body must be an object", "unsupported record event type", "record event is too large", "record has reached the retention byte limit"].includes(message)) {
        return json(res, 400, { error: "bad_request", message });
      }
      console.error("[voice] request failed", error instanceof Error ? error.message : String(error));
      return json(res, 500, { error: "internal_error" });
    }
  });

  const close = async () => {
    sessions.clear();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, close, records };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = await createVoiceServer();
  const port = Number(process.env.VOICE_PORT ?? 4320);
  const host = process.env.VOICE_HOST ?? "0.0.0.0";
  server.listen(port, host, () => console.log(`[voice] listening on http://${host}:${port}`));
}
