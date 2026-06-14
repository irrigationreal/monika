import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';

const PORT = Number(process.env.MONIKA_AGENTD_PORT ?? 7724);
const HOST = process.env.MONIKA_AGENTD_HOST ?? '127.0.0.1';
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? '/home/monika', '.pi/agent');
const DEFAULT_CWD = process.env.MONIKA_AGENTD_DEFAULT_CWD ?? process.env.HOME ?? '/home/monika';

const conversations = new Map();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function notFound(res) { json(res, 404, { error: 'not_found' }); }
function badRequest(res, message) { json(res, 400, { error: 'bad_request', message }); }
function serverError(res, err) { json(res, 500, { error: 'internal_error', message: err instanceof Error ? err.message : String(err) }); }

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text ?? part.content ?? JSON.stringify(part);
      return String(part);
    }).join('\n');
  }
  return String(content ?? '');
}

function conversationRecord(conv) {
  return {
    conversation_id: conv.id,
    active_thread_id: conv.id,
    model: conv.session.model ? `${conv.session.model.provider}/${conv.session.model.id}` : null,
    reasoning: conv.session.thinkingLevel ?? null,
    cwd: conv.cwd,
    session_id: conv.piSessionId ?? conv.id,
    session_path: conv.sessionPath ?? conv.session?.sessionManager?.getSessionFile?.() ?? null,
    instructions: null,
    coordination_mode: 'pi',
    created_at_ms: conv.createdAt,
    last_activity_at_ms: conv.lastActivityAt,
  };
}

async function createRuntime(cwd, sessionManager) {
  const factory = async ({ cwd: runtimeCwd, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: runtimeCwd, agentDir: AGENT_DIR });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(factory, {
    cwd,
    agentDir: AGENT_DIR,
    sessionManager,
  });
}

async function bindConversation(conv) {
  conv.unsubscribe?.();
  const session = conv.runtime.session;
  await session.bindExtensions({});
  conv.session = session;
  conv.unsubscribe = session.subscribe((event) => handlePiEvent(conv, event));
}

async function conversationFromRuntime(runtime, cwd) {
  const sessionManager = runtime.session.sessionManager;
  const conv = {
    id: runtime.session.sessionId,
    piSessionId: sessionManager?.getSessionId?.() ?? runtime.session.sessionId,
    sessionPath: sessionManager?.getSessionFile?.() ?? null,
    cwd,
    runtime,
    session: runtime.session,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    subscribers: new Set(),
    history: [],
    eventSeq: 0,
    current: null,
    unsubscribe: null,
  };
  await bindConversation(conv);
  conversations.set(conv.id, conv);
  return conv;
}

async function createConversation(opts = {}) {
  const cwd = path.resolve(opts.cwd ?? opts.workdir ?? DEFAULT_CWD);
  const runtime = await createRuntime(cwd, SessionManager.create(cwd));
  return conversationFromRuntime(runtime, cwd);
}

async function openConversation(opts = {}) {
  const sessionRef = opts.pi_session_id ?? opts.session_id ?? opts.id ?? opts.pi_session_path ?? opts.path;
  if (!sessionRef) throw new Error('pi_session_id or pi_session_path is required');
  const sessionInfo = await findSession(sessionRef);
  if (!sessionInfo) return null;

  for (const conv of conversations.values()) {
    if (conv.piSessionId === sessionInfo.id || conv.sessionPath === sessionInfo.path) return conv;
  }

  const cwd = path.resolve(opts.cwd ?? sessionInfo.cwd ?? DEFAULT_CWD);
  const runtime = await createRuntime(cwd, SessionManager.open(sessionInfo.path, undefined, cwd));
  return conversationFromRuntime(runtime, cwd);
}

function emit(conv, event, data) {
  conv.lastActivityAt = Date.now();
  const packet = { id: `${++conv.eventSeq}`, event, data };
  conv.history.push(packet);
  if (conv.history.length > 1000) conv.history.shift();
  const wire = `id: ${packet.id}\nevent: ${packet.event}\ndata: ${JSON.stringify(packet.data)}\n\n`;
  for (const res of conv.subscribers) res.write(wire);
}

function handlePiEvent(conv, event) {
  switch (event.type) {
    case 'agent_start': {
      const messageId = randomUUID();
      conv.current = { messageId, text: '', toolCalls: new Map(), startedAt: Date.now() };
      emit(conv, 'turn_started', { message_id: messageId, thread_id: conv.id });
      break;
    }
    case 'message_update': {
      const assistantEvent = event.assistantMessageEvent ?? event;
      if (assistantEvent.type === 'text_delta' && assistantEvent.delta) {
        if (conv.current) conv.current.text += assistantEvent.delta;
        emit(conv, 'turn_delta', { content: assistantEvent.delta });
      } else if (assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
        emit(conv, 'reasoning_delta', { delta: assistantEvent.delta });
      }
      break;
    }
    case 'tool_execution_start': {
      const callId = event.toolCallId ?? event.id ?? randomUUID();
      if (conv.current) conv.current.toolCalls.set(callId, event.toolName ?? 'tool');
      emit(conv, 'item_started', {
        item: {
          type: 'function_call',
          id: callId,
          call_id: callId,
          name: event.toolName ?? 'tool',
          arguments: event.input ?? event.arguments ?? null,
        },
      });
      break;
    }
    case 'tool_execution_end': {
      const callId = event.toolCallId ?? event.id ?? randomUUID();
      emit(conv, 'tool_completed', {
        call_id: callId,
        result: event.result ?? event.output ?? event.error ?? null,
      });
      break;
    }
    case 'agent_end': {
      const text = conv.current?.text ?? extractLastAssistantText(event.messages);
      if (text && text.trim()) {
        emit(conv, 'item_completed', {
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        });
      }
      const usage = extractUsage(event.messages);
      if (usage) emit(conv, 'turn_usage', { usage });
      emit(conv, 'turn_completed', { message_id: conv.current?.messageId ?? null, thread_id: conv.id });
      conv.current = null;
      break;
    }
    case 'agent_error':
      emit(conv, 'turn_error', { message: event.error?.message ?? String(event.error ?? 'agent error') });
      break;
  }
}

function extractTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return extractTextFromMessage(messages[i]);
  }
  return '';
}

function extractUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.usage;
    if (usage && typeof usage === 'object') {
      return {
        input_tokens: usage.input ?? usage.input_tokens,
        output_tokens: usage.output ?? usage.output_tokens,
        total_tokens: usage.totalTokens ?? usage.total_tokens ?? usage.total,
      };
    }
  }
  return null;
}

async function listModels() {
  try {
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const available = await registry.getAvailable();
    return { models: available.map((entry) => {
      const model = entry.model ?? entry;
      return { id: `${model.provider}/${model.id}`, name: model.name ?? model.id };
    }) };
  } catch (err) {
    try {
      const modelsPath = path.join(AGENT_DIR, 'models.json');
      const raw = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
      const models = [];
      for (const [provider, config] of Object.entries(raw.providers ?? {})) {
        for (const model of config.models ?? []) models.push({ id: `${provider}/${model.id}`, name: model.name ?? model.id });
      }
      return { models };
    } catch {
      return { models: [] };
    }
  }
}

async function readFirstLine(p) {
  const handle = await fs.open(p, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    return chunk.split('\n')[0] ?? '';
  } finally {
    await handle.close();
  }
}

async function sessionSummaryFromPath(p) {
  const [firstLine, stat] = await Promise.all([readFirstLine(p), fs.stat(p)]);
  const header = JSON.parse(firstLine || '{}');
  if (header.type !== 'session') return null;
  return {
    id: header.id,
    path: p,
    cwd: header.cwd,
    timestamp: header.timestamp,
    kind: p.includes('/forks/') ? 'fork' : 'normal',
    mtime_ms: stat.mtimeMs,
    size_bytes: stat.size,
  };
}

async function scanSessions() {
  const root = path.join(AGENT_DIR, 'sessions');
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const summary = await sessionSummaryFromPath(p);
          if (summary) out.push(summary);
        } catch {}
      }
    }
  }
  await walk(root);
  out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return out;
}

async function findSession(sessionRef) {
  const decoded = String(sessionRef);
  const sessions = await scanSessions();
  return sessions.find((candidate) => candidate.id === decoded || candidate.path === decoded) ?? null;
}

function visibleTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function contentTypes(content) {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [];
  return [...new Set(content.map((part) => part?.type ?? typeof part))];
}

function parseSessionLine(line) {
  const entry = JSON.parse(line);
  if (entry.type === 'session') {
    return {
      type: 'session',
      id: entry.id,
      timestamp: entry.timestamp,
      cwd: entry.cwd,
      version: entry.version ?? null,
    };
  }
  if (entry.type === 'message') {
    const msg = entry.message ?? {};
    const text = visibleTextFromContent(msg.content);
    return {
      type: 'message',
      id: entry.id,
      parentId: entry.parentId ?? null,
      timestamp: entry.timestamp ?? msg.timestamp ?? null,
      role: msg.role ?? null,
      text,
      hasVisibleText: text.trim().length > 0,
      contentTypes: contentTypes(msg.content),
      api: msg.api ?? null,
      provider: msg.provider ?? null,
      model: msg.model ?? null,
      stopReason: msg.stopReason ?? null,
      errorMessage: msg.errorMessage ?? null,
      usage: msg.usage ?? null,
    };
  }
  if (entry.type === 'model_change') {
    return {
      type: 'model_change',
      id: entry.id,
      parentId: entry.parentId ?? null,
      timestamp: entry.timestamp ?? null,
      provider: entry.provider ?? null,
      modelId: entry.modelId ?? null,
    };
  }
  if (entry.type === 'thinking_level_change') {
    return {
      type: 'thinking_level_change',
      id: entry.id,
      parentId: entry.parentId ?? null,
      timestamp: entry.timestamp ?? null,
      thinkingLevel: entry.thinkingLevel ?? null,
    };
  }
  if (entry.type === 'custom') {
    return {
      type: 'custom',
      id: entry.id,
      parentId: entry.parentId ?? null,
      timestamp: entry.timestamp ?? null,
      customType: entry.customType ?? null,
      data: entry.data ?? null,
    };
  }
  return {
    type: entry.type ?? 'unknown',
    id: entry.id ?? null,
    parentId: entry.parentId ?? null,
    timestamp: entry.timestamp ?? null,
  };
}

async function exportSession(sessionId) {
  const session = await findSession(sessionId);
  if (!session) return null;

  const raw = await fs.readFile(session.path, 'utf8');
  const entries = [];
  const parseErrors = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      entries.push(parseSessionLine(line));
    } catch (err) {
      parseErrors.push({ line: lineNo, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    session,
    entries,
    parse_errors: parseErrors,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, status: 'healthy', active_threads: [...conversations.values()].filter((c) => c.current).length, queue_depth: 0 });
    }
    if (method === 'GET' && url.pathname === '/v1/models') return json(res, 200, await listModels());
    if (method === 'GET' && url.pathname === '/v1/pi/sessions') return json(res, 200, { sessions: await scanSessions() });

    const piExportMatch = url.pathname.match(/^\/v1\/pi\/sessions\/([^/]+)\/export$/);
    if (method === 'GET' && piExportMatch) {
      const exported = await exportSession(decodeURIComponent(piExportMatch[1]));
      if (!exported) return notFound(res);
      return json(res, 200, exported);
    }

    if (method === 'POST' && url.pathname === '/v1/conversations') {
      const body = await readBody(req);
      const conv = await createConversation(body);
      return json(res, 200, { conversation: conversationRecord(conv) });
    }

    if (method === 'POST' && url.pathname === '/v1/conversations/open') {
      const body = await readBody(req);
      const conv = await openConversation(body);
      if (!conv) return notFound(res);
      return json(res, 200, { conversation: conversationRecord(conv) });
    }

    const convMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)(?:\/(.*))?$/);
    if (convMatch) {
      const conv = conversations.get(decodeURIComponent(convMatch[1]));
      const tail = convMatch[2] ?? '';
      if (!conv) return notFound(res);

      if (method === 'GET' && tail === '') return json(res, 200, { conversation: conversationRecord(conv) });
      if (method === 'GET' && tail === 'history') return json(res, 200, { conversation_id: conv.id, items: conv.history, total: conv.history.length });
      if (method === 'GET' && tail === 'events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        conv.subscribers.add(res);
        req.on('close', () => conv.subscribers.delete(res));
        return;
      }
      if (method === 'POST' && tail === 'messages') {
        const body = await readBody(req);
        const messageId = body.message_id ?? randomUUID();
        const text = textFromContent(body.content);
        const mode = body.mode ?? 'queue';
        void (async () => {
          try {
            if (mode === 'steer') await conv.session.prompt(text, { streamingBehavior: 'steer', source: 'api' });
            else await conv.session.prompt(text, { source: 'api' });
          } catch (err) {
            emit(conv, 'turn_error', { message: err instanceof Error ? err.message : String(err) });
            emit(conv, 'turn_completed', { message_id: messageId, thread_id: conv.id });
          }
        })();
        return json(res, 200, { message_id: messageId, thread_id: conv.id, compacted: false });
      }
      if (method === 'POST' && tail === 'interrupt') {
        await conv.session.abort();
        emit(conv, 'turn_interrupted', { thread_id: conv.id });
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && tail === 'close') {
        conv.unsubscribe?.();
        await conv.runtime.dispose();
        conversations.delete(conv.id);
        emit(conv, 'turn_completed', { thread_id: conv.id, closed: true });
        return json(res, 200, { ok: true, memory_saved: true });
      }
      if (method === 'POST' && tail === 'memory/save') {
        return json(res, 501, {
          error: 'not_implemented',
          message: 'Explicit save without closing is not exposed safely yet. Use /close to trigger Pi session_shutdown memory save.',
        });
      }
      if (method === 'POST' && (tail === 'pause' || tail === 'resume')) return json(res, 200, { ok: true });
    }

    return notFound(res);
  } catch (err) {
    if (err instanceof SyntaxError) return badRequest(res, err.message);
    console.error('[agentd]', err);
    return serverError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agentd] listening on http://${HOST}:${PORT} (agentDir=${AGENT_DIR})`);
});

process.on('SIGTERM', async () => {
  for (const conv of conversations.values()) {
    try { conv.unsubscribe?.(); await conv.runtime.dispose(); } catch {}
  }
  server.close(() => process.exit(0));
});
