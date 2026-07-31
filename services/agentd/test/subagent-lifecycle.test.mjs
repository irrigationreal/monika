import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  SUBAGENT_RUN_CUSTOM_TYPE,
  SubagentLifecycle,
  backgroundStatus,
  hasActiveBackgroundWork,
  pruneTerminalSubagentRuns,
  scanActiveLifecycleRuns,
  validateLifecycleArtifact,
} from '../src/subagent-lifecycle.mjs';

function conversation(sessionId = 'parent-session') {
  const sessionManager = SessionManager.inMemory('/tmp/subagent-lifecycle-test');
  // SessionManager.inMemory generates an ID; agentd's canonical ID is explicit here.
  return {
    piSessionId: sessionId,
    sessionPath: `/app/.pi/agent/sessions/project/session_${sessionId}.jsonl`,
    session: { sessionManager },
    provenanceState: { dispatches: [] },
    subagents: { runs: new Map() },
  };
}

function eventBus() {
  const handlers = new Map(); const emitted = [];
  return {
    emitted,
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => list.splice(list.indexOf(handler), 1); },
    emit(name, data) { emitted.push({ name, data }); for (const handler of handlers.get(name) ?? []) handler(data); },
  };
}

function start(runId = 'run-1', overrides = {}) {
  return { lifecycleArtifactVersion: 1, id: runId, sessionId: 'parent-session', mode: 'async', asyncDir: `/tmp/async/${runId}`, ...overrides };
}

function observedProof(runId = 'run-1') {
  return {
    version: 1, state: 'observed', runId, runnerProcessInstanceId: `runner-${runId}`, observedAt: 2000,
    instances: [{ kind: 'runner', processInstanceId: `runner-${runId}`, closeObservedAt: 2000, exitCode: 0, signal: null }],
  };
}

test('async start captures current forum origin durably and active work blocks idle/deploy classification', async () => {
  const conv = conversation();
  conv.provenanceState.dispatches.push({
    turnId: 'turn-1', accepted: true, settled: false,
    provenance: { origin: 'forum', topicId: 'topic-1', postId: 'post-1' },
  });
  const lifecycle = new SubagentLifecycle({ now: () => 1000 });
  const bus = eventBus(); lifecycle.extension().factory({ events: bus });
  await lifecycle.attach(conv);

  bus.emit('subagent:async-started', start('run-1', { sessionId: conv.sessionPath }));
  assert.equal(hasActiveBackgroundWork(conv), true);
  assert.equal(backgroundStatus(conv).active_count, 1);
  const entry = conv.session.sessionManager.getBranch().find((item) => item.customType === SUBAGENT_RUN_CUSTOM_TYPE);
  assert.deepEqual(entry.data.origin, { turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' });
  assert.equal(entry.data.runId, 'run-1');
  assert.equal(entry.data.sessionId, 'parent-session');
  assert.equal(entry.data.artifactSessionId, conv.sessionPath);

  bus.emit('subagent:process-terminal', observedProof());
  bus.emit('subagent:async-complete', { runId: 'run-1', success: true, state: 'completed' });
  assert.equal(hasActiveBackgroundWork(conv), false);
});

test('logical completion remains active until exact process-terminal proof arrives', async () => {
  const conv = conversation();
  const lifecycle = new SubagentLifecycle(); const bus = eventBus();
  lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  bus.emit('subagent:async-started', start());
  bus.emit('subagent:async-complete', { runId: 'run-1', success: true, state: 'complete' });
  assert.equal(hasActiveBackgroundWork(conv), true, 'runner may still mutate after writing its result');
  bus.emit('subagent:process-terminal', observedProof());
  assert.equal(hasActiveBackgroundWork(conv), false);
});

test('completion notification is attributed only when its natural continuation starts, preserving ordering', async () => {
  const conv = conversation();
  conv.provenanceState.dispatches.push({ turnId: 'turn-1', accepted: true, settled: false, provenance: { topicId: 'topic-1', postId: 'post-1' } });
  const lifecycle = new SubagentLifecycle(); const bus = eventBus(); lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  bus.emit('subagent:async-started', start());
  bus.emit('subagent:async-complete', { runId: 'run-1', success: true });

  lifecycle.handleSessionEvent({ type: 'agent_start' });
  assert.equal(lifecycle.continuation(), null, 'an unrelated turn is not claimed before subagent-notify');
  lifecycle.handleSessionEvent({ type: 'agent_settled' });
  conv.current = {}; // Pi agent_start has opened the turn before custom message_start.
  lifecycle.handleSessionEvent({
    type: 'message_start',
    message: { role: 'custom', customType: 'subagent-notify', details: { version: 1, runIds: ['run-1'] } },
  });
  assert.deepEqual(lifecycle.continuation(), {
    runId: 'run-1', origin: { turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' },
    runIds: ['run-1'],
    origins: [{ runId: 'run-1', turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' }],
  });
});

test('grouped package notifications retain every run origin on one canonical continuation', async () => {
  const conv = conversation(); const lifecycle = new SubagentLifecycle(); const bus = eventBus(); lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  for (const [id, postId] of [['run-1', 'post-1'], ['run-2', 'post-2']]) {
    conv.provenanceState.dispatches = [{ turnId: `turn-${id}`, accepted: true, settled: false, provenance: { topicId: 'topic-1', postId } }];
    bus.emit('subagent:async-started', start(id));
    bus.emit('subagent:async-complete', { runId: id, success: true });
  }
  conv.current = {};
  lifecycle.handleSessionEvent({
    type: 'message_start',
    message: { role: 'custom', customType: 'subagent-notify', content: 'Background tasks completed (2): **a**, **b**', details: { version: 1, runIds: ['run-1', 'run-2'] } },
  });
  assert.deepEqual(lifecycle.continuation().runIds, ['run-1', 'run-2']);
  assert.deepEqual(lifecycle.continuation().origins.map((origin) => origin.postId), ['post-1', 'post-2']);
});

test('restart reconciliation restores canonical mapping and trusts only matching terminal artifacts', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-restart-')); t.after(() => rm(tmp, { recursive: true, force: true }));
  const asyncDir = path.join(tmp, 'run-1'); await mkdir(asyncDir);
  const conv = conversation();
  conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
    version: 1, runId: 'run-1', sessionId: 'parent-session', asyncDir,
    origin: { turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' }, startedAt: 1,
  });
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 1, runId: 'run-1', sessionId: 'parent-session', asyncDir,
    state: 'completed', processTerminal: observedProof(), updatedAt: 2,
  }));
  const lifecycle = new SubagentLifecycle(); await lifecycle.attach(conv);
  assert.equal(backgroundStatus(conv).active_count, 0);
  assert.equal(conv.subagents.runs.get('run-1').origin.postId, 'post-1');

  await writeFile(path.join(asyncDir, 'status.json'), '{broken');
  const second = conversation();
  second.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
    version: 1, runId: 'run-1', sessionId: 'parent-session', asyncDir, origin: {}, startedAt: 1,
  });
  await new SubagentLifecycle().attach(second);
  assert.equal(backgroundStatus(second).active_count, 1, 'malformed evidence retains the run lease');
});

test('explicit stop uses the public V1 RPC and never mutates lifecycle files', async () => {
  const conv = conversation(); const lifecycle = new SubagentLifecycle(); const bus = eventBus(); lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  bus.emit('subagent:async-started', start());
  const result = await lifecycle.requestStops();
  assert.deepEqual(result, { requested: 1, unavailable: 0 });
  const rpc = bus.emitted.find((entry) => entry.name === 'subagents:rpc:v1:request');
  assert.equal(rpc.data.version, 1); assert.equal(rpc.data.method, 'stop'); assert.deepEqual(rpc.data.params, { runId: 'run-1' });
});

test('artifact validation rejects malformed identity and non-absolute paths', () => {
  assert.equal(validateLifecycleArtifact(null), null);
  assert.equal(validateLifecycleArtifact({ lifecycleArtifactVersion: 1, runId: 'r', sessionId: 's', asyncDir: 'relative' }), null);
  assert.equal(validateLifecycleArtifact({ lifecycleArtifactVersion: 1, runId: 'other', sessionId: 's', asyncDir: '/tmp/x' }, { runId: 'r' }), null);
});

test('global lifecycle scan keeps unloaded and unproven runs deployment-active', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-global-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, state, proof] of [
    ['running', 'running', { version: 1, state: 'pending', runId: 'running', runnerProcessInstanceId: 'r' }],
    ['unknown-proof', 'complete', { version: 1, state: 'unknown', runId: 'unknown-proof', runnerProcessInstanceId: 'r', reason: 'observer-unavailable' }],
    ['done', 'complete', observedProof('done')],
  ]) {
    const dir = path.join(root, id); await mkdir(dir);
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({
      lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, state,
      processTerminal: proof, lastUpdate: 1,
    }));
  }
  const active = await scanActiveLifecycleRuns({ lifecycleRoot: root });
  assert.deepEqual(active.map((run) => run.runId).sort(), ['running', 'unknown-proof']);
});

test('14-day retention removes only old proven-terminal unleased child sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-retention-'));
  const lifecycleRoot = path.join(root, 'lifecycle');
  const sessionRoot = path.join(root, 'sessions');
  await mkdir(lifecycleRoot); await mkdir(sessionRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 6, 30); const old = now - 15 * 24 * 60 * 60 * 1000;
  async function fixture(id, patch = {}) {
    const asyncDir = path.join(lifecycleRoot, id); await mkdir(asyncDir);
    const sessionDir = path.join(sessionRoot, id); await mkdir(sessionDir);
    await writeFile(path.join(sessionDir, 'session.jsonl'), '{}\n');
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
      lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, sessionDir,
      state: 'completed', processTerminal: observedProof(id), lastUpdate: old, ...patch,
    }));
    return { asyncDir, sessionDir };
  }
  const removable = await fixture('remove');
  const active = await fixture('active');
  const unobserved = await fixture('unobserved', { processTerminal: { state: 'pending' } });
  const leased = await fixture('leased');
  const malformed = path.join(lifecycleRoot, 'malformed'); await mkdir(malformed); await writeFile(path.join(malformed, 'status.json'), '{}');

  const result = await pruneTerminalSubagentRuns({
    lifecycleRoot, sessionRoot, nowMs: now, activeRunIds: new Set(['active']),
    hasSessionLease: (id) => id === 'session-leased',
  });
  assert.deepEqual(result.removed, [removable.sessionDir]);
  await assert.rejects(readFile(path.join(removable.sessionDir, 'session.jsonl')));
  assert.ok(await readFile(path.join(removable.asyncDir, 'status.json')), 'lifecycle diagnostics follow package cleanup');
  for (const item of [active, unobserved, leased]) assert.ok(await readFile(path.join(item.sessionDir, 'session.jsonl')));
  assert.ok(await readFile(path.join(malformed, 'status.json')));
});
