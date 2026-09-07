import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const repositoryExtensionRoot = new URL('../../../config/extensions/', import.meta.url);
const bundledExtensionRoot = existsSync(repositoryExtensionRoot)
  ? repositoryExtensionRoot
  : new URL('file:///app/.pi/agent/extensions/');
const extensionSource = new URL('00-session-ownership.ts', bundledExtensionRoot);
const interactiveShellSource = new URL('interactive-shell.ts', bundledExtensionRoot);
const extensionCopy = new URL('../.session-ownership-extension.test.ts', import.meta.url);

async function prepareExtensionCopy() {
  const tuiUrl = new URL('../../pi-tui/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;
  const source = await readFile(extensionSource, 'utf8');
  await writeFile(extensionCopy, source.replace('"@earendil-works/pi-tui"', JSON.stringify(tuiUrl)));
}

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness({ sessionId, sessionFile, idle = true }) {
  const handlers = new Map();
  let shutdowns = 0;
  let aborts = 0;
  const pi = { on(event, handler) { handlers.set(event, handler); } };
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const ctx = {
    mode: 'tui',
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
    isIdle: () => idle,
    abort: () => { aborts += 1; },
    shutdown: () => { shutdowns += 1; },
    ui: {
      theme,
      setStatus() {},
      notify() {},
      custom(factory) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {}, stop() {}, start() {} }, theme, {}, resolve);
          // Successful automatic requests resolve before this. On a failed gate,
          // emulate the operator choosing the fail-closed Exit Pi action.
          if (component.handleInput) setTimeout(() => component.handleInput('\x1b'), 10);
        });
      },
    },
  };
  return { pi, ctx, handlers, shutdowns: () => shutdowns, aborts: () => aborts };
}

function installFetch(sequence, calls) {
  globalThis.fetch = async (url, options = {}) => {
    const action = String(url).split('/').pop();
    calls.push({ action, body: options.body ? JSON.parse(options.body) : null });
    const next = sequence.shift();
    assert.ok(next, `unexpected ownership request: ${action}`);
    assert.equal(next.action, action);
    return response(next.status ?? 200, next.body);
  };
}

test('bundled discovery runs ownership before interactive shell short-circuits user bash', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-extension-order-'));
  const agentDir = path.join(root, 'agent');
  const extensionsDir = path.join(agentDir, 'extensions');
  const originalFetch = globalThis.fetch;
  await mkdir(extensionsDir, { recursive: true });
  const tuiUrl = new URL('../../pi-tui/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href;
  await writeFile(
    path.join(extensionsDir, '00-session-ownership.ts'),
    (await readFile(extensionSource, 'utf8')).replace('"@earendil-works/pi-tui"', JSON.stringify(tuiUrl)),
  );
  await writeFile(path.join(extensionsDir, 'interactive-shell.ts'), await readFile(interactiveShellSource, 'utf8'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  });

  const bundledNames = await readdir(bundledExtensionRoot);
  assert.ok(bundledNames.includes('00-session-ownership.ts'));
  assert.equal(bundledNames.includes('session-ownership.ts'), false, 'renamed bundle must not retain a duplicate handler');

  const loaded = await discoverAndLoadExtensions([], path.join(root, 'workspace'), agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(
    loaded.extensions.map((extension) => path.basename(extension.path)),
    ['00-session-ownership.ts', 'interactive-shell.ts'],
  );

  const sessionId = '018f47a2-9b3c-7def-8000-456789abcdef';
  const sessionFile = path.join(root, `day_${sessionId}.jsonl`);
  const spawnedMarker = path.join(root, 'interactive-spawned');
  const calls = [];
  installFetch([
    { action: 'reserve', body: { ok: true, state: 'reserved', lease_token: 'ordered-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'release', body: { ok: true, state: 'released' } },
  ], calls);
  const runtime = harness({ sessionId, sessionFile });
  const emit = async (event, payload) => {
    for (const extension of loaded.extensions) {
      for (const handler of extension.handlers.get(event) ?? []) {
        const result = await handler(payload, runtime.ctx);
        if (event === 'user_bash' && result) return result;
      }
    }
    return undefined;
  };

  await emit('session_start', {});
  const result = await emit('user_bash', { command: `i printf spawned > ${JSON.stringify(spawnedMarker)}` });
  assert.deepEqual(calls.map((call) => call.action), ['reserve'], 'ownership reserves before interactive-shell returns a result');
  assert.equal(result?.result?.exitCode, 0);
  assert.equal(existsSync(spawnedMarker), true, 'interactive shell ran only after reservation');
  await emit('session_shutdown', { reason: 'quit' });
  assert.deepEqual(calls.map((call) => call.action), ['reserve', 'release']);
});

test('extension behavior gates first input/bash, promotes before tools, resumes by claim, and releases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-extension-'));
  const originalFetch = globalThis.fetch;
  await prepareExtensionCopy();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await rm(extensionCopy, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  const { default: extension } = await import(`${extensionCopy.href}?behavioral`);

  const firstId = '018f47a2-9b3c-7def-8123-456789abcdef';
  const firstFile = path.join(root, `day_${firstId}.jsonl`);
  const calls = [];
  installFetch([
    { action: 'reserve', body: { ok: true, state: 'reserved', lease_token: 'first-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'promote', body: { ok: true, state: 'claimed', lease_token: 'first-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'release', body: { ok: true, state: 'released' } },
  ], calls);
  const first = harness({ sessionId: firstId, sessionFile: firstFile });
  extension(first.pi);
  await first.handlers.get('session_start')({}, first.ctx);
  assert.deepEqual(calls, [], 'opening an unused launcher must not contact agentd');
  assert.equal(await first.handlers.get('input')({}, first.ctx), undefined);
  assert.equal(calls[0].action, 'reserve');
  await writeFile(firstFile, `${JSON.stringify({ type: 'session', id: firstId })}\n`);
  assert.equal(await first.handlers.get('tool_call')({}, first.ctx), undefined);
  assert.equal(calls[1].action, 'promote', 'materialized pending ownership promotes before tool execution');
  await first.handlers.get('session_shutdown')({ reason: 'quit' }, first.ctx);
  assert.equal(calls[2].action, 'release');

  const bashId = '018f47a2-9b3c-7def-8456-456789abcdef';
  const bashFile = path.join(root, `day_${bashId}.jsonl`);
  const bashCalls = [];
  installFetch([
    { action: 'reserve', body: { ok: true, state: 'reserved', lease_token: 'bash-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'release', body: { ok: true, state: 'released' } },
  ], bashCalls);
  const bash = harness({ sessionId: bashId, sessionFile: bashFile });
  extension(bash.pi);
  await bash.handlers.get('session_start')({}, bash.ctx);
  assert.equal(await bash.handlers.get('user_bash')({}, bash.ctx), undefined, 'successful first-action reservation preserves original bash execution');
  assert.equal(bashCalls[0].action, 'reserve');
  await bash.handlers.get('session_shutdown')({ reason: 'quit' }, bash.ctx);
  assert.equal(bashCalls[1].action, 'release');

  const blockedBashId = '018f47a2-9b3c-7def-8567-456789abcdef';
  const blockedBashFile = path.join(root, `day_${blockedBashId}.jsonl`);
  const blockedBashCalls = [];
  installFetch([{ action: 'reserve', status: 500, body: { error: 'unavailable' } }], blockedBashCalls);
  const blockedBash = harness({ sessionId: blockedBashId, sessionFile: blockedBashFile });
  extension(blockedBash.pi);
  await blockedBash.handlers.get('session_start')({}, blockedBash.ctx);
  const blockedBashResult = await blockedBash.handlers.get('user_bash')({}, blockedBash.ctx);
  assert.equal(blockedBashResult?.result?.cancelled, true);
  assert.equal(blockedBash.shutdowns(), 1);
  assert.deepEqual(blockedBashCalls.map((call) => call.action), ['reserve']);

  const resumedId = '018f47a2-9b3c-7def-8789-456789abcdef';
  const resumedFile = path.join(root, `day_${resumedId}.jsonl`);
  await writeFile(resumedFile, `${JSON.stringify({ type: 'session', id: resumedId })}\n`);
  const resumeCalls = [];
  installFetch([
    { action: 'claim', body: { ok: true, state: 'claimed', lease_token: 'resume-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'release', body: { ok: true, state: 'released' } },
  ], resumeCalls);
  const resumed = harness({ sessionId: resumedId, sessionFile: resumedFile });
  extension(resumed.pi);
  await resumed.handlers.get('session_start')({}, resumed.ctx);
  assert.equal(resumeCalls[0].action, 'claim');
  await resumed.handlers.get('session_shutdown')({ reason: 'quit' }, resumed.ctx);
  assert.equal(resumeCalls[1].action, 'release');
});

test('extension blocks work and aborts when materialized promotion remains uncertain', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ownership-extension-failure-'));
  const originalFetch = globalThis.fetch;
  await prepareExtensionCopy();
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await rm(extensionCopy, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  const { default: extension } = await import(`${extensionCopy.href}?failure`);
  const sessionId = '018f47a2-9b3c-7def-8999-456789abcdef';
  const sessionFile = path.join(root, `day_${sessionId}.jsonl`);
  const calls = [];
  installFetch([
    { action: 'reserve', body: { ok: true, state: 'reserved', lease_token: 'pending-token', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    { action: 'promote', status: 500, body: { error: 'uncertain' } },
    { action: 'promote', status: 500, body: { error: 'uncertain' } },
  ], calls);
  const failed = harness({ sessionId, sessionFile, idle: false });
  extension(failed.pi);
  await failed.handlers.get('session_start')({}, failed.ctx);
  await failed.handlers.get('input')({}, failed.ctx);
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId })}\n`);
  const result = await failed.handlers.get('tool_call')({}, failed.ctx);
  assert.equal(result?.block, true);
  assert.equal(failed.aborts(), 1);
  assert.equal(failed.shutdowns(), 1);
  assert.deepEqual(calls.map((call) => call.action), ['reserve', 'promote', 'promote']);
});
