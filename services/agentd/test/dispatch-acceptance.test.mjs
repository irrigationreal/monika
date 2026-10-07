import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISPATCH_NOT_ACCEPTED,
  DISPATCH_SAFE_RETRY,
  DispatchNotAcceptedError,
  notAcceptedBody,
} from '../src/dispatch-acceptance.mjs';

const serverSource = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('dispatch acceptance markers distinguish terminal and explicitly safe retry', () => {
  const original = { error: 'internal_error', message: 'initialization failed' };
  assert.deepEqual(notAcceptedBody(original), {
    ...original,
    dispatch_acceptance: DISPATCH_NOT_ACCEPTED,
  });
  assert.deepEqual(notAcceptedBody(original, { safeRetry: true }), {
    ...original,
    dispatch_acceptance: DISPATCH_NOT_ACCEPTED,
    dispatch_retry: DISPATCH_SAFE_RETRY,
  });
  assert.equal(original.dispatch_acceptance, undefined);
  assert.equal(new DispatchNotAcceptedError(new Error('failed')).cause.message, 'failed');
});

test('message route wires HTTP success behind the behavioral preflight gate', () => {
  const messageStart = serverSource.indexOf("if (method === 'POST' && tail === 'messages')");
  const messageEnd = serverSource.indexOf("if (method === 'POST' && tail === 'interrupt')", messageStart);
  assert.ok(messageStart >= 0 && messageEnd > messageStart);
  const route = serverSource.slice(messageStart, messageEnd);
  assert.match(route, /createDispatchPreflightGate\(/);
  assert.match(route, /await awaitDispatchPreflight\(preflight\.accepted, promptPromise\)/);
  assert.ok(route.indexOf('await awaitDispatchPreflight') < route.lastIndexOf('return json(res, 200'));
  assert.match(route, /throw new DispatchNotAcceptedError\(error\)/);
});

test('post-acceptance failures retain markerless asynchronous handling', () => {
  const messageStart = serverSource.indexOf("if (method === 'POST' && tail === 'messages')");
  const messageEnd = serverSource.indexOf("if (method === 'POST' && tail === 'interrupt')", messageStart);
  const route = serverSource.slice(messageStart, messageEnd);
  assert.ok(route.indexOf('await awaitDispatchPreflight') < route.indexOf('void (async () =>'));
  assert.match(route, /await promptPromise/);
  assert.match(route, /emit\(conv, 'turn_error'/);
});

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startAgentd(root, port) {
  const agentDir = path.join(root, 'agent');
  for (const directory of [
    agentDir,
    path.join(root, 'runtime'),
    path.join(root, 'subsessions'),
    path.join(root, 'operator'),
    path.join(root, 'forks'),
    path.join(root, 'creations'),
  ]) await mkdir(directory, { recursive: true });
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_RUNTIME_ROOT: path.join(root, 'runtime'),
      PI_SUBAGENT_SESSION_ROOT: path.join(root, 'subsessions'),
      PI_SUBAGENT_OPERATOR_ROOT: path.join(root, 'operator'),
      MONIKA_RUNTIME_INSTANCE_FILE: path.join(root, 'instance.json'),
      MONIKA_AGENTD_FORUM_FORK_OPERATION_ROOT: path.join(root, 'forks'),
      MONIKA_AGENTD_FORUM_CREATION_OPERATION_ROOT: path.join(root, 'creations'),
      MONIKA_AGENTD_DRAIN_STATE_FILE: path.join(root, 'drain.json'),
      MONIKA_AGENTD_PORT: String(port),
      MONIKA_AGENTD_HOST: '127.0.0.1',
      MONIKA_AGENTD_IDLE_REAP_ENABLED: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`agentd exited during startup: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill('SIGTERM');
  throw new Error(`agentd did not become ready: ${stderr}`);
}

async function stopAgentd(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('message route returns a marked rejection when the SDK omits preflight callback', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentd-preflight-route-'));
  const port = await unusedPort();
  const child = await startAgentd(root, port);
  t.after(async () => {
    await stopAgentd(child);
    await rm(root, { recursive: true, force: true });
  });

  const createdResponse = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const conversationId = created.conversation.conversation_id;
  const dispatchId = 'callback-less-rejection';
  const response = await fetch(`http://127.0.0.1:${port}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hello', message_id: dispatchId, dispatch_id: dispatchId, generation: 0 }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.dispatch_acceptance, DISPATCH_NOT_ACCEPTED);
  assert.match(body.message, /model|API key/i);
});
