import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
  writeSubagentDeliveryAck,
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

function observedProof(runId = 'run-1', resumeDisposition) {
  return {
    version: 1, state: 'observed', runId, runnerProcessInstanceId: `runner-${runId}`, observedAt: 2000,
    instances: [{ kind: 'runner', processInstanceId: `runner-${runId}`, closeObservedAt: 2000, exitCode: 0, signal: null }],
    ...(resumeDisposition ? { resumeDisposition } : {}),
  };
}

async function writeLaunch(asyncDir, id, sessionId = `session-${id}`, overrides = {}) {
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ lifecycleArtifactVersion: 1, runId: id, sessionId,
    asyncDir, state: 'spawned', runnerProcessInstanceId: `runner-${id}`, registeredAt: 1, ...overrides }));
}

async function deliveryFixture(root, id) {
  const lifecycleRoot = path.join(root, 'lifecycle'); const runsRoot = path.join(lifecycleRoot, 'async-subagent-runs');
  const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results'); const asyncDir = path.join(runsRoot, id);
  await mkdir(asyncDir, { recursive: true }); await mkdir(resultsRoot, { recursive: true });
  const proof = observedProof(id, 'unavailable');
  await writeLaunch(asyncDir, id);
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, asyncDir, state: 'complete', processTerminal: proof, lastUpdate: 2000 }));
  await writeFile(path.join(asyncDir, 'process-terminal.json'), JSON.stringify(proof));
  await writeFile(path.join(resultsRoot, `${id}.json`), '{"pending":true}\n');
  return { lifecycleRoot, resultsRoot, asyncDir };
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
  const { lifecycleRoot, resultsRoot } = await deliveryFixture(root, 'run-legacy');
  const operatorRoot = path.join(root, 'operator-state');
  await writeFile(path.join(resultsRoot, 'run-legacy.json'), '{"legacy":true}\n');
  try {
    const resolution = await resolvePendingSubagentDelivery({
      lifecycleRoot, resultsRoot, operatorRoot, runId: 'run-legacy', action: 'supersede', reason: 'operator verified newer work',
    });
    assert.equal(JSON.parse(await readFile(resolution.retainedResult, 'utf8')).legacy, true);
    assert.match(await readFile(path.join(operatorRoot, 'operator-resolutions.jsonl'), 'utf8'), /operator verified newer work/);
    await assert.rejects(() => access(path.join(resultsRoot, 'run-legacy.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operator resolution custody preserves a concurrently swapped newer result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-swap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycleRoot, resultsRoot } = await deliveryFixture(root, 'run-swap'); const operatorRoot = path.join(root, 'operator');
  const source = path.join(resultsRoot, 'run-swap.json'); const displaced = path.join(resultsRoot, 'run-swap.old.json');
  await assert.rejects(() => resolvePendingSubagentDelivery({ lifecycleRoot, resultsRoot, operatorRoot, runId: 'run-swap', action: 'dismiss', reason: 'verified', beforeStep: async (step) => {
    if (step === 'result-custody') { await rename(source, displaced); await writeFile(source, '{"new":true}\n'); }
  } }), /source restored/);
  assert.equal(JSON.parse(await readFile(source, 'utf8')).new, true); assert.equal(JSON.parse(await readFile(displaced, 'utf8')).pending, true);
});

test('operator delivery retry recovers a result left in custody after interruption', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-custody-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycleRoot, resultsRoot } = await deliveryFixture(root, 'run-retry'); const operatorRoot = path.join(root, 'operator');
  const input = { lifecycleRoot, resultsRoot, operatorRoot, runId: 'run-retry', action: 'dismiss', reason: 'verified interrupted custody' };
  await assert.rejects(() => resolvePendingSubagentDelivery({ ...input, beforeStep: async (step) => { if (step === 'result-captured') throw new Error('interrupted after capture'); } }), /interrupted after capture/);
  await assert.rejects(() => access(path.join(resultsRoot, 'run-retry.json')));
  assert.equal((await readdir(resultsRoot)).filter((name) => name.includes('.custody.')).length, 1);
  const resolution = await resolvePendingSubagentDelivery(input);
  assert.equal(JSON.parse(await readFile(resolution.retainedResult, 'utf8')).pending, true);
  assert.equal((await readdir(resultsRoot)).filter((name) => name.includes('.custody.')).length, 0);
});

test('delivery resolution rejects retained-directory symlink escape and preserves source on partial failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-delivery-safety-'));
  const { lifecycleRoot, resultsRoot } = await deliveryFixture(root, 'run-safe'); const operatorRoot = path.join(root, 'operator'); const escape = path.join(root, 'escape');
  await mkdir(operatorRoot); await mkdir(escape);
  await writeFile(path.join(resultsRoot, 'run-safe.json'), '{"safe":true}\n');
  await symlink(escape, path.join(operatorRoot, 'retained-results'));
  const input = { lifecycleRoot, resultsRoot, operatorRoot, runId: 'run-safe', action: 'dismiss', reason: 'verified' };
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
  const { lifecycleRoot, resultsRoot } = await deliveryFixture(root, 'run-link'); const operatorRoot = path.join(root, 'operator');
  const retained = path.join(operatorRoot, 'retained-results');
  await mkdir(operatorRoot); await mkdir(retained);
  const source = path.join(resultsRoot, 'run-link.json');
  await writeFile(source, '{"pending":true}\n');
  await symlink(source, path.join(retained, 'run-link.dismiss.json'));
  try {
    await assert.rejects(() => resolvePendingSubagentDelivery({
      lifecycleRoot, resultsRoot, operatorRoot, runId: 'run-link', action: 'dismiss', reason: 'verified',
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

test('awaited claims bind forward while awaited and silent completions never become notifications', async () => {
  const conv = conversation();
  const lifecycle = new SubagentLifecycle(); const bus = eventBus(); lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  bus.emit('subagent:async-started', start('awaited-1', { deliveryDisposition: 'awaited', runKey: 'top:awaited-1' }));
  bus.emit('subagent:async-complete', { runId: 'awaited-1', runKey: 'top:awaited-1', deliveryDisposition: 'awaited', success: true });
  bus.emit('subagent:result-claimed', {
    version: 1, kind: 'pi-subagents.result-claim', runId: 'awaited-1', runKey: 'top:awaited-1',
    sessionId: 'parent-session', deliveryDisposition: 'awaited', resultSha256: 'a'.repeat(64), resultSizeBytes: 12,
    claimedAt: 1, claimEntryId: 'claim-entry-1', claimPath: '/private/path-must-not-propagate',
  });
  lifecycle.handleSessionEvent({ type: 'message_start', message: { role: 'custom', customType: 'subagent-notify', details: { runIds: ['awaited-1'] } } });
  assert.equal(lifecycle.continuation(), null);
  const causal = lifecycle.consumeCausalMetadata();
  assert.equal(causal.continuation, null);
  assert.equal(causal.resultClaims[0].claimEntryId, 'claim-entry-1');
  assert.equal(causal.resultClaims[0].claim.claimPath, undefined);
  assert.equal(lifecycle.findRun('awaited-1', 'top:awaited-1').deliveryState, 'claimed-awaiting-synthesis');

  bus.emit('subagent:async-started', start('silent-1', { deliveryDisposition: 'silent' }));
  bus.emit('subagent:async-complete', { runId: 'silent-1', deliveryDisposition: 'silent', success: true });
  lifecycle.handleSessionEvent({ type: 'message_start', message: { role: 'custom', customType: 'subagent-notify', details: { runIds: ['silent-1'] } } });
  assert.equal(lifecycle.continuation(), null);
  assert.equal(conv.subagents.runs.get('silent-1').deliveryState, 'retained');
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
  await writeLaunch(asyncDir, 'run-1', 'parent-session');
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

test('restart restores an unmatched canonical awaited claim for exactly one outward assistant', async () => {
  const conv = conversation(); const asyncDir = '/tmp/async/awaited-restart';
  conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
    version: 2, runId: 'awaited-restart', runKey: 'top:awaited-restart', sessionId: 'parent-session', artifactSessionId: 'parent-session',
    asyncDir, deliveryDisposition: 'awaited', deliveryState: 'awaiting-claim', claimState: 'unclaimed', origin: {}, startedAt: 1,
  });
  const claim = { version: 1, kind: 'pi-subagents.result-claim', runId: 'awaited-restart', runKey: 'top:awaited-restart', sessionId: 'parent-session', deliveryDisposition: 'awaited', resultSha256: 'b'.repeat(64), resultSizeBytes: 44, claimedAt: 2 };
  const claimEntryId = conv.session.sessionManager.appendCustomEntry('pi-subagents.result-claim', claim);
  const lifecycle = new SubagentLifecycle(); await lifecycle.attach(conv);
  lifecycle.handleSessionEvent({ type: 'agent_settled' });
  const restored = lifecycle.consumeCausalMetadata();
  assert.deepEqual(restored.resultClaims, [{ claim, claimEntryId }]);
  assert.deepEqual(lifecycle.consumeCausalMetadata().resultClaims, [], 'one lifecycle cannot attach the claim twice');

  const restarted = new SubagentLifecycle(); await restarted.attach(conv);
  assert.deepEqual(restarted.consumeCausalMetadata().resultClaims, [{ claim, claimEntryId }], 'a crash before synthesis safely restores the unmatched claim');
  conv.session.sessionManager.appendCustomEntry('monika.message.provenance', {
    version: 2, messageKind: 'assistant_outward', piMessageId: 'assistant-1', resultClaims: [{ ...claim, claimEntryId }],
  });
  const afterSynthesis = new SubagentLifecycle(); await afterSynthesis.attach(conv);
  assert.deepEqual(afterSynthesis.consumeCausalMetadata().resultClaims, [], 'canonical synthesis consumes recovery custody exactly once');
});

test('foreign-session result claims are rejected before causal attribution', async () => {
  const conv = conversation(); const lifecycle = new SubagentLifecycle(); const bus = eventBus(); lifecycle.extension().factory({ events: bus }); await lifecycle.attach(conv);
  bus.emit('subagent:async-started', start('foreign-claim', { deliveryDisposition: 'awaited', runKey: 'top:foreign-claim' }));
  const accepted = lifecycle.onClaimed({ version: 1, kind: 'pi-subagents.result-claim', runId: 'foreign-claim', runKey: 'top:foreign-claim', sessionId: 'other-session', deliveryDisposition: 'awaited', resultSha256: 'c'.repeat(64), resultSizeBytes: 1, claimedAt: 1, claimEntryId: 'foreign-entry' });
  assert.equal(accepted, false); assert.deepEqual(lifecycle.consumeCausalMetadata().resultClaims, []);
});

test('pending explicit follow_up recovery stays passive until open reconciliation and emits once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-follow-up-recover-')); t.after(() => rm(root, { recursive: true, force: true }));
  const resultsRoot = path.join(root, 'async-subagent-results'); const asyncDir = path.join(root, 'async-subagent-runs', 'follow-restart');
  await mkdir(resultsRoot, { recursive: true }); await mkdir(asyncDir, { recursive: true });
  const identity = { lifecycleArtifactVersion: 5, runId: 'follow-restart', sessionId: 'parent-session', asyncDir, deliveryDisposition: 'follow_up' };
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ ...identity, state: 'spawned', runnerProcessInstanceId: 'runner-follow-restart', registeredAt: 1 }));
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ ...identity, state: 'complete', execution_state: 'terminal', outcome_state: 'succeeded', effects_state: 'none', delivery_state: 'pending', processTerminal: observedProof('follow-restart'), lastUpdate: 2 }));
  await writeFile(path.join(resultsRoot, 'follow-restart.json'), JSON.stringify({ ...identity, success: true, summary: 'recovered exact result' }));
  const conv = conversation(); conv.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_CUSTOM_TYPE, {
    version: 2, runId: 'follow-restart', runKey: 'top:follow-restart', sessionId: 'parent-session', artifactSessionId: 'parent-session', asyncDir,
    deliveryDisposition: 'follow_up', deliveryState: 'pending', claimState: 'unclaimed', origin: { postId: 'post-1' }, startedAt: 1,
  });
  const lifecycle = new SubagentLifecycle({ lifecycleRoot: root, resultsRoot }); const bus = eventBus(); lifecycle.extension().factory({ events: bus });
  await lifecycle.attach(conv);
  assert.deepEqual([...conv.subagents.runs.values()].map((run) => ({ active: run.active, deliveryState: run.deliveryState, deliveryDisposition: run.deliveryDisposition, runKey: run.runKey })), [
    { active: false, deliveryState: 'unproven', deliveryDisposition: 'follow_up', runKey: 'top:follow-restart' },
  ]);
  assert.equal(bus.emitted.some((event) => event.name === 'subagent:async-complete'), false, 'attach/startup remains passive');
  assert.deepEqual(await lifecycle.recoverPendingFollowUps(), { recovered: 1 });
  assert.deepEqual(await lifecycle.recoverPendingFollowUps(), { recovered: 0 });
  const recovered = bus.emitted.filter((event) => event.name === 'subagent:async-complete');
  assert.equal(recovered.length, 1); assert.equal(recovered[0].data.runKey, 'top:follow-restart'); assert.equal(recovered[0].data.triggerTurn, true);
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
  await writeLaunch(asyncDir, 'remote-unknown', 'parent-session');
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
  await writeLaunch(asyncDir, 'remote-concurrent', 'parent-session');
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
    await writeLaunch(asyncDir, id, 'parent-session');
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
    await writeLaunch(dir, id);
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({
      lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, state,
      processTerminal: proof, lastUpdate: 1,
    }));
  }
  const active = await scanActiveLifecycleRuns({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'runtime-instance.json') });
  assert.deepEqual(active.map((run) => run.runId).sort(), ['running', 'unknown-proof']);
  assert.ok(active.every((run) => run.run_key === `top:${run.run_id}` && run.scope === 'top' && run.root_run_id === null));
});

test('durable reconciliation clears a stale loaded lease without a completion event', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-converge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'run-1'); await mkdir(asyncDir);
  await writeLaunch(asyncDir, 'run-1', 'parent-session');
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
  await writeFile(path.join(nested, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: 'nested-run', sessionId: 'parent-session', asyncDir: nested, state: 'running', pid: 42, lastUpdate: 3 }));
  const resultsRoot = path.join(root, 'async-subagent-results'); await mkdir(path.join(resultsRoot, 'nested', 'parent-run'), { recursive: true });
  await writeFile(path.join(resultsRoot, 'nested', 'parent-run', 'nested-run.json'), '{}\n');
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, resultsRoot, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs[0].run_id, 'nested-run');
  assert.equal(snapshot.runs[0].run_key, 'nested:parent-run:nested-run');
  assert.equal(snapshot.runs[0].scope, 'nested');
  assert.equal(snapshot.runs[0].root_run_id, 'parent-run');
  assert.equal(snapshot.runs[0].result_path, path.join(resultsRoot, 'nested', 'parent-run', 'nested-run.json'));
  assert.equal(snapshot.runs[0].delivery_state, 'pending');

  const conv = conversation(); const lifecycle = new SubagentLifecycle(); await lifecycle.attach(conv);
  lifecycle.onStarted(start('mapped-missing', { asyncDir: path.join(root, 'deleted-run') }));
  mergeMappedLifecycleRuns(snapshot, [conv]);
  assert.equal(snapshot.active_count, 2);
  assert.equal(snapshot.byId.get('mapped-missing').reason, 'mapped-lifecycle-artifact-missing');
});

test('delivery classification requires an identity-bound central acknowledgement and ranking surfaces unproven first', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-delivery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const resultsRoot = path.join(root, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator'); await mkdir(resultsRoot); await mkdir(operatorRoot);
  const fixtures = [
    { id: 'top-settled', dir: path.join(root, 'async-subagent-runs', 'top-settled'), key: 'top:top-settled', ack: true },
    { id: 'nested-unproven', dir: path.join(root, 'nested-subagent-runs', 'parent', 'nested-unproven'), key: 'nested:parent:nested-unproven', ack: false },
    { id: 'top-pending', dir: path.join(root, 'async-subagent-runs', 'top-pending'), key: 'top:top-pending', pending: true },
  ];
  for (const fixture of fixtures) {
    await mkdir(fixture.dir, { recursive: true });
    await writeLaunch(fixture.dir, fixture.id, 'parent-session');
    await writeFile(path.join(fixture.dir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: fixture.id, sessionId: 'parent-session', asyncDir: fixture.dir, state: 'complete', processTerminal: observedProof(fixture.id), lastUpdate: 1 }));
    if (fixture.ack) {
      const result = path.join(resultsRoot, `${fixture.id}.json`); await writeFile(result, '{}');
      await writeSubagentDeliveryAck({ lifecycleRoot: root, asyncDir: fixture.dir, resultsRoot, operatorRoot, runId: fixture.id, runKey: fixture.key, proofKind: 'notification', proofReference: 'message-1' });
      await rm(result);
    }
    if (fixture.pending) await writeFile(path.join(resultsRoot, `${fixture.id}.json`), '{}');
  }
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, resultsRoot, operatorRoot, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.byKey.get('top:top-settled').delivery_state, 'settled');
  assert.equal(snapshot.byKey.get('nested:parent:nested-unproven').delivery_state, 'unproven');
  assert.equal(snapshot.byKey.get('top:top-pending').delivery_state, 'pending');
  assert.equal(prioritizeLifecycleRuns(snapshot.runs, 3)[0].run_key, 'nested:parent:nested-unproven');
});

test('scoped run-key collisions preserve proven scoped state while raw-ID lookup stays ambiguous', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-collision-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [path.join(root, 'async-subagent-runs', 'same'), path.join(root, 'nested-subagent-runs', 'root', 'same')]) {
    await mkdir(dir, { recursive: true });
    await writeLaunch(dir, 'same', 'parent');
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: 'same', sessionId: 'parent', asyncDir: dir, state: 'complete', processTerminal: observedProof('same'), lastUpdate: 1 }));
  }
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 0); assert.equal(snapshot.uncertain_count, 0); assert.equal(snapshot.byId.has('same'), false);
  assert.deepEqual(new Set(snapshot.runs.map((run) => run.run_key)), new Set(['top:same', 'nested:root:same']));
  assert.equal(snapshot.byKey.get('top:same').scope, 'top');
  assert.equal(snapshot.byKey.get('nested:root:same').root_run_id, 'root');
  assert.ok(snapshot.runs.every((run) => run.execution_state === 'terminal'));
});

test('scanner retains canonical correlation for malformed and later read-failed scoped records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-malformed-map-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'lifecycle'); const resultsRoot = path.join(root, 'results'); await mkdir(resultsRoot);
  const malformedDir = path.join(lifecycleRoot, 'async-subagent-runs', 'malformed');
  await mkdir(malformedDir, { recursive: true });
  await writeFile(path.join(malformedDir, 'status.json'), JSON.stringify({ runId: 'malformed', sessionId: 'parent', parentSessionPath: '/sessions/parent.jsonl', state: 42 }));
  const failedDir = path.join(lifecycleRoot, 'async-subagent-runs', 'read-failed');
  await mkdir(failedDir, { recursive: true });
  await writeFile(path.join(failedDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: 'read-failed', sessionId: 'parent', parentSessionPath: '/sessions/parent.jsonl', asyncDir: failedDir, state: 'complete', processTerminal: observedProof('read-failed'), lastUpdate: 1 }));
  await symlink(path.join(root, 'missing-result'), path.join(resultsRoot, 'read-failed.json'));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot, resultsRoot, runtimeInstanceFile: path.join(root, 'none') });
  for (const id of ['malformed', 'read-failed']) {
    const run = snapshot.byKey.get(`top:${id}`);
    assert.equal(run.parent_session_id, 'parent'); assert.equal(run.parent_session_path, '/sessions/parent.jsonl');
    assert.equal(run.execution_state, 'uncertain'); assert.equal(run.blocking, true);
  }
});

test('same-runtime dead runner reconciles interrupted while a matching live identity blocks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, 'runtime.json');
  await writeFile(runtimeFile, JSON.stringify({ version: 1, id: 'runtime-1', createdAt: 1 }));
  for (const id of ['dead', 'live']) {
    const asyncDir = path.join(root, id); await mkdir(asyncDir);
    await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ runId: id, sessionId: 'parent', asyncDir, state: 'spawned', runnerProcessInstanceId: `runner-${id}`, runtimeInstanceId: 'runtime-1', pid: 42, processStartTicks: id, registeredAt: 2 }));
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: id, sessionId: 'parent', state: 'running', pid: 42, lastUpdate: 3 }));
  }
  const launchOnly = path.join(root, 'launch-only-dead'); await mkdir(launchOnly);
  await writeFile(path.join(launchOnly, 'launch.json'), JSON.stringify({ runId: 'launch-only-dead', sessionId: 'parent', asyncDir: launchOnly, state: 'spawned', runnerProcessInstanceId: 'runner-launch-only-dead', runtimeInstanceId: 'runtime-1', pid: 42, processStartTicks: 'launch-only-dead', registeredAt: 2 }));
  const snapshot = await scanLifecycleSnapshot({
    lifecycleRoot: root, runtimeInstanceFile: runtimeFile,
    processInspector: async (_pid, launch) => launch.processStartTicks === 'live',
  });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs.find((run) => run.run_id === 'dead').execution_state, 'interrupted');
  assert.equal(snapshot.runs.find((run) => run.run_id === 'launch-only-dead').execution_state, 'interrupted');
  assert.equal(snapshot.runs.find((run) => run.run_id === 'live').execution_state, 'active');
});

test('present malformed launch cannot fall back to unbound legacy proof for a live process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-malformed-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'malformed-current'; const asyncDir = path.join(root, id); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'launch.json'), '{malformed');
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 3, runId: id, sessionId: 'parent', parentSessionPath: '/sessions/parent.jsonl',
    asyncDir, state: 'complete', pid: process.pid, processTerminal: observedProof(id), lastUpdate: Date.now(),
  }));
  const snapshot = await scanLifecycleSnapshot({
    lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none'),
    processInspector: async (pid) => pid === process.pid,
  });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.uncertain_count, 1);
  assert.equal(snapshot.runs[0].execution_state, 'uncertain');
  assert.equal(snapshot.runs[0].blocking, true);
  assert.equal(snapshot.runs[0].reason, 'malformed-lifecycle-artifact');
  assert.equal(snapshot.runs[0].parent_session_id, 'parent');
});

test('stale terminal proofs cannot override a live current launch instance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-stale-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const state of ['observed', 'not-started']) {
    const id = `stale-${state}`; const asyncDir = path.join(root, id); await mkdir(asyncDir);
    await writeLaunch(asyncDir, id, 'parent', { runnerProcessInstanceId: `current-${id}`, pid: 42, processStartTicks: 'live' });
    const proof = state === 'observed' ? observedProof(id) : {
      version: 1, state: 'not-started', runId: id, runnerProcessInstanceId: `runner-${id}`,
    };
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
      lifecycleArtifactVersion: 3, runId: id, sessionId: 'parent', asyncDir, state: 'complete', pid: 42,
      processTerminal: proof, lastUpdate: 2,
    }));
  }
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none'),
    processInspector: async () => true });
  assert.equal(snapshot.active_count, 2);
  assert.ok(snapshot.runs.every((run) => run.blocking && run.execution_state === 'uncertain'));
});

test('pre-spawn launch records block and lifecycle traversal errors fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'run-launch'); await mkdir(asyncDir);
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ runId: 'run-launch', sessionId: 'parent', asyncDir, state: 'registered', runnerProcessInstanceId: 'runner-run-launch', registeredAt: 1 }));
  const snapshot = await scanLifecycleSnapshot({ lifecycleRoot: root, runtimeInstanceFile: path.join(root, 'none') });
  assert.equal(snapshot.active_count, 1);
  assert.equal(snapshot.runs[0].reason, 'launch-not-yet-settled');

  const notDirectory = path.join(root, 'not-a-directory'); await writeFile(notDirectory, 'x');
  await assert.rejects(scanLifecycleSnapshot({ lifecycleRoot: notDirectory }), /ENOTDIR/);
  await symlink(asyncDir, path.join(root, 'unsafe-link'));
  await assert.rejects(scanLifecycleSnapshot({ lifecycleRoot: root }), /unsafe lifecycle symlink/);
});

test('operator quarantine is identity-bound, audited, and refuses a live runner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-quarantine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, 'uncertain'); await mkdir(asyncDir);
  await writeLaunch(asyncDir, 'uncertain', 'parent', { runnerProcessInstanceId: 'runner-1' });
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

test('automatic child-session pruning preserves every terminal session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-subagent-retention-'));
  const lifecycleRoot = path.join(root, 'lifecycle'); const sessionRoot = path.join(root, 'sessions');
  await mkdir(lifecycleRoot); await mkdir(sessionRoot); t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 6, 30); const old = now - 15 * 24 * 60 * 60 * 1000;
  async function fixture(id, resumeDisposition, proofDisposition = resumeDisposition) {
    const asyncDir = path.join(lifecycleRoot, id); const sessionDir = path.join(sessionRoot, id);
    await mkdir(asyncDir); await mkdir(sessionDir); await writeFile(path.join(sessionDir, 'session.jsonl'), '{}\n');
    const terminal = { ...observedProof(id, resumeDisposition), observedAt: old, instances: [{ kind: 'runner', processInstanceId: `runner-${id}`, closeObservedAt: old, exitCode: 0, signal: null }] };
    const proof = { ...terminal, resumeDisposition: proofDisposition };
    await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, asyncDir, sessionDir, state: 'completed', processTerminal: terminal, lastUpdate: old }));
    await writeFile(path.join(asyncDir, 'process-terminal.json'), JSON.stringify(proof)); return { asyncDir, sessionDir };
  }
  const unavailable = await fixture('unavailable', 'unavailable');
  const resumable = await fixture('resumable', 'resumable');
  const statusResumable = await fixture('status-resumable', 'resumable', 'unavailable');
  const result = await pruneTerminalSubagentRuns({ lifecycleRoot, sessionRoot, nowMs: now });
  assert.deepEqual(result.removed, []);
  await access(unavailable.sessionDir);
  await access(resumable.sessionDir);
  await access(statusResumable.sessionDir);
});
