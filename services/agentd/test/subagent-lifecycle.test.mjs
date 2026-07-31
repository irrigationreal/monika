import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  SUBAGENT_RUN_CUSTOM_TYPE,
  SubagentLifecycle,
  backgroundStatus,
  capLifecycleRuns,
  hasActiveBackgroundWork,
  mergeMappedLifecycleRuns,
  pruneTerminalSubagentRuns,
  prioritizeLifecycleRuns,
  quarantineLifecycleRun,
  resolvePendingSubagentDelivery,
  resolveSubagentEffects,
  scanActiveLifecycleRuns,
  scanLifecycleSnapshot,
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

test('workload capping prioritizes blockers and reports omitted blocker details', () => {
  const history = Array.from({ length: 70 }, (_, index) => ({ run_id: `history-${index}`, blocking: false, execution_state: 'terminal', delivery_state: 'settled-or-unavailable', updated_at: index }));
  const pending = { run_id: 'pending', blocking: false, execution_state: 'terminal', delivery_state: 'pending', updated_at: 1 };
  const blockers = Array.from({ length: 70 }, (_, index) => ({ run_id: `blocker-${index}`, blocking: true, execution_state: index === 0 ? 'uncertain' : 'active', delivery_state: 'pending', updated_at: index }));
  const effectsUnknown = { run_id: 'effects-unknown', lifecycle_artifact_version: 4, blocking: false, execution_state: 'terminal', effects_state: 'unknown', delivery_state: 'settled', updated_at: 100 };
  const capped = capLifecycleRuns([...history, pending, effectsUnknown, ...blockers], 64);
  assert.equal(capped.selected.every((run) => run.blocking || run.effects_state === 'unknown'), true);
  assert.equal(capped.selected.length, 64);
  assert.equal(capped.blockerCount, 71);
  assert.equal(capped.omittedBlockerCount, 7);
  assert.equal(capped.omitted, 78);
  const mixed = prioritizeLifecycleRuns([...history, pending, blockers[0], effectsUnknown], 64);
  assert.deepEqual(mixed.slice(0, 2).map((run) => run.run_id), ['effects-unknown', 'blocker-0']);
  assert.equal(mixed[2].run_id, 'pending');
});

test('operator delivery resolution is audited and retains uncertain result bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-resolution-'));
  const resultsRoot = path.join(root, 'async-subagent-results');
  const operatorRoot = path.join(root, 'operator-state');
  await mkdir(resultsRoot);
  await writeFile(path.join(resultsRoot, 'run-legacy.json'), '{"legacy":true}\n');
  try {
    const resolution = await resolvePendingSubagentDelivery({
      lifecycleRoot: root, resultsRoot, operatorRoot, runId: 'run-legacy', action: 'supersede', reason: 'operator verified newer work',
    });
    assert.equal(JSON.parse(await readFile(resolution.retainedResult, 'utf8')).legacy, true);
    assert.match(await readFile(path.join(operatorRoot, 'operator-resolutions.jsonl'), 'utf8'), /operator verified newer work/);
    await assert.rejects(() => access(path.join(resultsRoot, 'run-legacy.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivery resolution rejects retained-directory symlink escape and preserves source on partial failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-safety-'));
  const resultsRoot = path.join(root, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator'); const escape = path.join(root, 'escape');
  await mkdir(resultsRoot); await mkdir(operatorRoot); await mkdir(escape);
  await writeFile(path.join(resultsRoot, 'run-safe.json'), '{"safe":true}\n');
  await symlink(escape, path.join(operatorRoot, 'retained-results'));
  const input = { lifecycleRoot: root, resultsRoot, operatorRoot, runId: 'run-safe', action: 'dismiss', reason: 'verified' };
  try {
    await assert.rejects(() => resolvePendingSubagentDelivery(input), /unsafe retained/);
    await access(path.join(resultsRoot, 'run-safe.json'));
    await rm(path.join(operatorRoot, 'retained-results'));
    await assert.rejects(() => resolvePendingSubagentDelivery({ ...input, beforeStep: async (step) => { if (step === 'completed-audit') throw new Error('injected crash'); } }), /injected crash/);
    await access(path.join(resultsRoot, 'run-safe.json'));
    const retried = await resolvePendingSubagentDelivery(input);
    assert.equal(JSON.parse(await readFile(retried.retainedResult, 'utf8')).safe, true);
    await assert.rejects(() => access(path.join(resultsRoot, 'run-safe.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delivery resolution rejects a destination symlink to the pending source without completing audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-destination-link-'));
  const resultsRoot = path.join(root, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator');
  const retained = path.join(operatorRoot, 'retained-results');
  await mkdir(resultsRoot); await mkdir(operatorRoot); await mkdir(retained);
  const source = path.join(resultsRoot, 'run-link.json');
  await writeFile(source, '{"pending":true}\n');
  await symlink(source, path.join(retained, 'run-link.dismiss.json'));
  try {
    await assert.rejects(() => resolvePendingSubagentDelivery({
      lifecycleRoot: root, resultsRoot, operatorRoot, runId: 'run-link', action: 'dismiss', reason: 'verified',
    }), /unsafe retained result destination/);
    assert.equal(JSON.parse(await readFile(source, 'utf8')).pending, true);
    const audit = (await readFile(path.join(operatorRoot, 'operator-resolutions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(audit.map((entry) => entry.phase), ['requested']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test('lifecycle v4 preserves separate state dimensions and only safe target identity', () => {
  const artifact = validateLifecycleArtifact({
    lifecycleArtifactVersion: 4, runId: 'r', sessionId: 's', asyncDir: '/tmp/r', state: 'complete',
    execution_state: 'terminal', outcome_state: 'succeeded', effects_state: 'unknown', delivery_state: 'pending',
    executionTarget: { kind: 'ssh', name: 'stanza' },
  });
  assert.equal(artifact.executionState, 'terminal');
  assert.equal(artifact.effectsState, 'unknown');
  assert.deepEqual(artifact.executionTarget, { kind: 'ssh', name: 'stanza' });
  assert.equal(validateLifecycleArtifact({
    lifecycleArtifactVersion: 4, runId: 'r', sessionId: 's', asyncDir: '/tmp/r', state: 'complete',
    execution_state: 'terminal', outcome_state: 'succeeded', effects_state: 'unknown',
  }), null);
});

test('terminal lifecycle v4 with effects unknown is quiescent but deployment-unsafe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-effects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'remote-unknown'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 4, runId: 'remote-unknown', sessionId: 'parent-session', state: 'complete',
    execution_state: 'terminal', outcome_state: 'succeeded', effects_state: 'unknown', delivery_state: 'pending',
    executionTarget: { kind: 'ssh', name: 'stanza' }, processTerminal: observedProof('remote-unknown'), lastUpdate: 2,
  }));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'absent-runtime') });
  assert.equal(snapshot.active_count, 0, 'effects uncertainty does not fabricate a live runner');
  assert.equal(snapshot.effects_unknown_count, 1, 'safe deployment remains fail-closed');
  assert.equal(snapshot.runs[0].blocking, false);
  assert.equal(snapshot.runs[0].effects_state, 'unknown');
  await writeFile(path.join(asyncDir, 'effects-resolution.json'), JSON.stringify({
    version: 1, kind: 'effects-attestation', runId: 'remote-unknown', effectsState: 'none', reason: 'forged sidecar', resolvedAt: 3,
  }));
  const forged = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'absent-runtime') });
  assert.equal(forged.effects_unknown_count, 1, 'an unaudited sidecar cannot unblock deployment');

  const resolution = await resolveSubagentEffects({
    lifecycleRoot: root, runId: 'remote-unknown', effectsState: 'confirmed',
    reason: 'operator inspected the remote target and confirmed the partial write',
    runtimeInstanceFile: path.join(root, 'absent-runtime'),
  });
  assert.equal(resolution.effectsState, 'confirmed');
  const resolved = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'absent-runtime') });
  assert.equal(resolved.effects_unknown_count, 0);
  assert.equal(resolved.runs[0].effects_state, 'confirmed');
  assert.equal(resolved.runs[0].effects_resolution.reason, resolution.reason);
  assert.match(await readFile(path.join(root, 'operator-resolutions.jsonl'), 'utf8'), /effects-attestation/);
  const retried = await resolveSubagentEffects({
    lifecycleRoot: root, runId: 'remote-unknown', effectsState: 'confirmed', reason: resolution.reason,
    runtimeInstanceFile: path.join(root, 'absent-runtime'),
  });
  assert.deepEqual(retried, resolution, 'lost-response retries are idempotent');
  await assert.rejects(() => resolveSubagentEffects({
    lifecycleRoot: root, runId: 'remote-unknown', effectsState: 'none', reason: 'conflicting retry',
    runtimeInstanceFile: path.join(root, 'absent-runtime'),
  }), /already resolved/);
});

test('concurrent effects attestation retries do not remove each other\'s durable state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-effects-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'remote-concurrent'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 4, runId: 'remote-concurrent', sessionId: 'parent-session', state: 'complete',
    execution_state: 'terminal', outcome_state: 'failed', effects_state: 'unknown', delivery_state: 'pending',
    executionTarget: { kind: 'ssh', name: 'stanza' }, processTerminal: observedProof('remote-concurrent'), lastUpdate: 2,
  }));
  const input = { lifecycleRoot: root, runId: 'remote-concurrent', effectsState: 'none', reason: 'operator proved no change', runtimeInstanceFile: path.join(root, 'none') };
  const resolutions = await Promise.all([resolveSubagentEffects(input), resolveSubagentEffects(input)]);
  assert.equal(resolutions.every((item) => item.effectsState === 'none'), true);
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.effects_unknown_count, 0);
  assert.equal(snapshot.runs[0].effects_state, 'none');
});

test('effects attestation refuses active and legacy runs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-effects-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, version, state, proof] of [
    ['active', 4, 'running', null],
    ['legacy', 3, 'complete', observedProof('legacy')],
  ]) {
    const asyncDir = path.join(root, id); await mkdir(asyncDir);
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
      lifecycleArtifactVersion: version, runId: id, sessionId: 'parent-session', state,
      ...(version >= 4 ? { execution_state: state === 'running' ? 'active' : 'terminal', outcome_state: 'unknown', effects_state: 'unknown', delivery_state: 'pending' } : {}),
      ...(proof ? { processTerminal: proof } : {}), lastUpdate: 2,
    }));
  }
  await assert.rejects(() => resolveSubagentEffects({
    lifecycleRoot: root, runId: 'active', effectsState: 'none', reason: 'unsafe', runtimeInstanceFile: path.join(root, 'none'),
  }), /durably inactive/);
  await assert.rejects(() => resolveSubagentEffects({
    lifecycleRoot: root, runId: 'legacy', effectsState: 'none', reason: 'not applicable', runtimeInstanceFile: path.join(root, 'none'),
  }), /version 4/);
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
  const active = await scanActiveLifecycleRuns({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'runtime-instance.json') });
  assert.deepEqual(active.map((run) => run.runId).sort(), ['running', 'unknown-proof']);
});

test('durable reconciliation clears a stale loaded lease without a completion event', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-converge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'run-1'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 3, runId: 'run-1', sessionId: 'parent-session',
    state: 'complete', processTerminal: observedProof(), lastUpdate: 2,
  }));
  const conv = conversation();
  conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
    version: 1, runId: 'run-1', sessionId: 'parent-session', asyncDir, origin: {}, startedAt: 1,
  });
  const lifecycle = new SubagentLifecycle(); await lifecycle.attach(conv);
  conv.subagents.runs.get('run-1').active = true; // model a missed terminal event after attach
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'absent-runtime') });
  await lifecycle.reconcileArtifacts(snapshot);
  assert.equal(backgroundStatus(conv).active_count, 0);
  assert.equal(conv.subagents.runs.get('run-1').executionState, 'terminal');
});

test('legacy unknown terminal proof predating a new runtime reconciles interrupted without deleting diagnostics', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'run-old'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 3, runId: 'run-old', sessionId: 'parent-session', state: 'failed', pid: 999999,
    processTerminal: { version: 1, state: 'unknown', runId: 'run-old', runnerProcessInstanceId: 'old', reason: 'runner-candidate-missing' },
    lastUpdate: 50,
  }));
  const runtimeFile = path.join(root, 'runtime.json');
  await writeFile(runtimeFile, JSON.stringify({ version: 1, id: 'new-container', createdAt: 100 }));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: runtimeFile });
  assert.equal(snapshot.active_count, 0);
  assert.equal(snapshot.runs[0].execution_state, 'interrupted');
  assert.equal(snapshot.runs[0].reason, 'legacy-record-predates-runtime');
  assert.ok(await readFile(path.join(asyncDir, 'status.json')));
});

test('nested lifecycle trees and mapped missing artifacts remain deployment-visible', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-nested-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested-subagent-runs', 'parent-run', 'nested-run'); await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: 'nested-run', sessionId: 'parent-session', state: 'running', pid: 42, lastUpdate: 3 }));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs[0].run_id, 'nested-run');

  const conv = conversation(); const lifecycle = new SubagentLifecycle(); await lifecycle.attach(conv);
  lifecycle.onStarted(start('mapped-missing', { asyncDir: path.join(root, 'deleted-run') }));
  mergeMappedLifecycleRuns(snapshot, [conv]);
  assert.equal(snapshot.active_count, 2);
  assert.equal(snapshot.byId.get('mapped-missing').reason, 'mapped-lifecycle-artifact-missing');
});

test('same-runtime dead runner reconciles interrupted while a matching live identity blocks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, 'runtime.json');
  await writeFile(runtimeFile, JSON.stringify({ version: 1, id: 'runtime-1', createdAt: 1 }));
  for (const id of ['dead', 'live']) {
    const asyncDir = path.join(root, id); await mkdir(asyncDir);
    await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ runId: id, sessionId: 'parent', asyncDir, state: 'spawned', runtimeInstanceId: 'runtime-1', pid: 42, processStartTicks: id, registeredAt: 2 }));
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: id, sessionId: 'parent', state: 'running', pid: 42, lastUpdate: 3 }));
  }
  const launchOnly = path.join(root, 'launch-only-dead'); await mkdir(launchOnly);
  await writeFile(path.join(launchOnly, 'launch.json'), JSON.stringify({ runId: 'launch-only-dead', sessionId: 'parent', asyncDir: launchOnly, state: 'spawned', runtimeInstanceId: 'runtime-1', pid: 42, processStartTicks: 'launch-only-dead', registeredAt: 2 }));
  const snapshot = await scanLifecycleSnapshot({
    lifecycleRoot: root, runtimeInstanceFile: runtimeFile,
    processInspector: async (_pid, launch) => launch.processStartTicks === 'live',
  });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs.find((run) => run.run_id === 'dead').execution_state, 'interrupted');
  assert.equal(snapshot.runs.find((run) => run.run_id === 'launch-only-dead').execution_state, 'interrupted');
  assert.equal(snapshot.runs.find((run) => run.run_id === 'live').execution_state, 'active');
});

test('pre-spawn launch records block and lifecycle traversal errors fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'run-launch'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ runId: 'run-launch', sessionId: 'parent', asyncDir, state: 'registered', registeredAt: 1 }));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs[0].reason, 'launch-not-yet-settled');

  const notDirectory = path.join(root, 'not-a-directory'); await writeFile(notDirectory, 'x');
  await assert.rejects(scanLifecycleSnapshot({ lifecycleRoot: notDirectory }), /ENOTDIR/);
});

test('operator quarantine is identity-bound, audited, and refuses a live runner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-quarantine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'uncertain'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 3, runId: 'uncertain', sessionId: 'parent', state: 'failed',
    processTerminal: { version: 1, state: 'unknown', runId: 'uncertain', runnerProcessInstanceId: 'runner-1', reason: 'observer-unavailable' }, lastUpdate: 3,
  }));
  await assert.rejects(quarantineLifecycleRun({ lifecycleRoot: root, runId: 'uncertain', runnerProcessInstanceId: 'wrong', reason: 'verified' }), /does not match/);
  const blockedAuditPath = path.join(root, 'operator-resolutions.jsonl'); await mkdir(blockedAuditPath);
  await assert.rejects(quarantineLifecycleRun({ lifecycleRoot: root, runId: 'uncertain', runnerProcessInstanceId: 'runner-1', reason: 'must remain blocked' }));
  let failedSnapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(failedSnapshot.active_count, 1, 'failed audit persistence cannot publish an effective quarantine');
  await rm(blockedAuditPath, { recursive: true });

  const resolution = await quarantineLifecycleRun({ lifecycleRoot: root, runId: 'uncertain', runnerProcessInstanceId: 'runner-1', reason: 'operator verified no process' });
  assert.equal(resolution.action, 'quarantine');
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 0);
  assert.equal(snapshot.runs[0].execution_state, 'quarantined');
  assert.match(await readFile(path.join(root, 'operator-resolutions.jsonl'), 'utf8'), /operator verified no process/);
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
