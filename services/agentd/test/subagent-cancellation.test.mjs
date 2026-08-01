import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubagentCancellationCoordinator } from '../src/subagent-cancellation.mjs';
import { scanLifecycleSnapshot } from '../src/subagent-lifecycle.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime'); const operatorRoot = path.join(root, 'operator');
  await mkdir(lifecycleRoot); await mkdir(operatorRoot);
  return { root, lifecycleRoot, operatorRoot };
}
function run(env, id, overrides = {}) {
  const nestedRoot = overrides.root_run_id;
  const asyncDir = nestedRoot ? path.join(env.lifecycleRoot, 'nested-subagent-runs', nestedRoot, id)
    : path.join(env.lifecycleRoot, 'async-subagent-runs', id);
  return { run_id: id, run_key: nestedRoot ? `nested:${nestedRoot}:${id}` : `top:${id}`,
    scope: nestedRoot ? 'nested' : 'top', root_run_id: nestedRoot ?? null, async_dir: asyncDir,
    parent_session_id: overrides.parent_session_id ?? 'parent', parent_session_path: overrides.parent_session_path ?? '/sessions/parent.jsonl',
    execution_state: 'active', effects_state: 'none', blocking: true, ...overrides };
}
async function materialize(r) { await mkdir(r.async_dir, { recursive: true }); await writeFile(path.join(r.async_dir, 'status.json'), '{}'); }

test('cancels unloaded-parent top-level and nested runs to a fixed point with scoped identities', async (t) => {
  const env = await fixture(t); const top = run(env, 'same'); const nested = run(env, 'same', { root_run_id: 'same', parent_session_id: 'child' });
  await materialize(top); await materialize(nested); let scans = 0;
  const scan = async () => {
    scans += 1;
    const all = scans === 1 ? [top] : [top, nested];
    for (const item of all) {
      try { await access(path.join(item.async_dir, 'control', 'stop.json')); item.blocking = false; item.execution_state = 'interrupted'; } catch {}
    }
    return { runs: all };
  };
  let now = 0; const coordinator = createSubagentCancellationCoordinator({ ...env, scan, now: () => now++, sleep: async () => {} });
  const result = await coordinator.request({ operationId: 'op-1', sessionId: 'parent', sessionPath: '/sessions/parent.jsonl', generation: 7 });
  assert.equal(result.state, 'stopped'); assert.deepEqual(result.targets.map((item) => item.run_key).sort(), ['nested:same:same', 'top:same']);
  assert.equal(JSON.parse(await readFile(path.join(nested.async_dir, 'control', 'stop.json'), 'utf8')).cancellationGeneration, 7);
});

test('terminal pending delivery is marked before stopped can be reported', async (t) => {
  const env = await fixture(t); const terminal = run(env, 'terminal', { blocking: false, execution_state: 'terminal', delivery_state: 'pending' });
  await materialize(terminal);
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [terminal] }), sleep: async () => {} });
  const result = await coordinator.request({ operationId: 'terminal-result', sessionId: 'parent', sessionPath: '/sessions/parent.jsonl', generation: 4 });
  assert.equal(result.state, 'stopped'); assert.equal(result.targets[0].run_key, 'top:terminal');
  const marker = JSON.parse(await readFile(path.join(terminal.async_dir, 'host-cancellation.json'), 'utf8'));
  assert.equal(marker.runKey, 'top:terminal'); assert.equal(marker.parentSessionId, 'parent');
  await assert.rejects(() => access(path.join(terminal.async_dir, 'control', 'stop.json')));
});

test('same operation is durable and idempotent, can reconcile, and rejects identity conflicts', async (t) => {
  const env = await fixture(t); let uncertain = true; let now = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env,
    scan: async () => ({ runs: uncertain ? [run(env, 'ambiguous', { run_key: null, execution_state: 'uncertain' })] : [] }),
    now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const input = { operationId: 'retry-safe', sessionId: 'parent', generation: 2 };
  const first = await coordinator.request(input); assert.equal(first.state, 'uncertain');
  uncertain = false;
  const second = await coordinator.request(input); assert.equal(second.state, 'stopped');
  assert.equal(second.requested_at, first.requested_at);
  const third = await coordinator.request(input);
  assert.equal(third.state, second.state); assert.equal(third.requested_at, second.requested_at);
  await assert.rejects(() => coordinator.request({ ...input, generation: 3 }), /identity conflict/);
});

test('in-flight reuse validates full identity and reconciliation reasserts consumed control', async (t) => {
  const env = await fixture(t); const active = run(env, 'active'); await materialize(active);
  let release; const gate = new Promise((resolve) => { release = resolve; }); let scans = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => {
    scans += 1;
    if (scans === 1) await gate;
    try { await access(path.join(active.async_dir, 'control', 'stop.json')); } catch {}
    return { runs: [active] };
  }, now: (() => { let value = 0; return () => value += 1000; })(), sleep: async () => {}, settleTimeoutMs: 1 });
  const input = { operationId: 'inflight', sessionId: 'parent', sessionPath: '/sessions/parent.jsonl', generation: 2, reason: 'forum-stop' };
  const first = coordinator.request(input); await Promise.resolve();
  await assert.rejects(() => coordinator.request({ ...input, reason: 'other' }), /identity conflict/);
  release(); await first;
  await rm(path.join(active.async_dir, 'control', 'stop.json'));
  await coordinator.request(input);
  assert.equal(JSON.parse(await readFile(path.join(active.async_dir, 'control', 'stop.json'), 'utf8')).runKey, 'top:active');
});

 test('unsupported scheduled descendants remain explicit uncertainty and are not controlled', async (t) => {
  const env = await fixture(t); const scheduled = run(env, 'future', { scope: 'scheduled' }); await materialize(scheduled); let now = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [scheduled] }), now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const result = await coordinator.request({ operationId: 'scheduled', sessionId: 'parent', generation: 1 });
  assert.equal(result.state, 'uncertain'); assert.match(result.errors[0], /unsupported-scope:scheduled/);
  await assert.rejects(() => access(path.join(scheduled.async_dir, 'control', 'stop.json')));
});

test('malformed unscoped and effects-unknown runs remain explicit uncertainty', async (t) => {
  const env = await fixture(t); const bad = run(env, 'bad', { run_key: null, execution_state: 'uncertain', effects_state: 'unknown', reason: 'malformed' });
  await materialize(bad); let now = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [bad] }), now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const result = await coordinator.request({ operationId: 'uncertain', sessionId: 'parent', generation: 1 });
  assert.equal(result.state, 'uncertain'); assert.equal(result.effects_unknown.length, 1); assert.match(result.errors[0], /lacks scoped durable identity/);
});

test('actual scanner and coordinator retain malformed status under valid launch identity', async (t) => {
  const env = await fixture(t); const asyncDir = path.join(env.lifecycleRoot, 'async-subagent-runs', 'malformed-launch');
  await mkdir(asyncDir, { recursive: true });
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ lifecycleArtifactVersion: 1, runId: 'malformed-launch',
    sessionId: 'parent', parentSessionPath: '/sessions/parent.jsonl', asyncDir, state: 'spawned',
    runnerProcessInstanceId: 'runner-current', pid: 42, registeredAt: 1 }));
  await writeFile(path.join(asyncDir, 'status.json'), '{malformed');
  const scan = () => scanLifecycleSnapshot({ lifecycleRoot: env.lifecycleRoot,
    runtimeInstanceFile: path.join(env.root, 'none'), processInspector: async () => true });
  const snapshot = await scan(); const selected = snapshot.byKey.get('top:malformed-launch');
  assert.equal(selected.parent_session_id, 'parent'); assert.equal(selected.parent_session_path, '/sessions/parent.jsonl');
  assert.equal(selected.runner_process_instance_id, 'runner-current');
  assert.equal(selected.execution_state, 'uncertain'); assert.equal(selected.blocking, true);
  let now = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan, now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const result = await coordinator.request({ operationId: 'malformed-launch', sessionId: 'parent',
    sessionPath: '/sessions/parent.jsonl', generation: 2 });
  assert.equal(result.state, 'uncertain'); assert.equal(result.targets[0].run_key, 'top:malformed-launch');
  assert.equal(JSON.parse(await readFile(path.join(asyncDir, 'control', 'stop.json'), 'utf8')).runId, 'malformed-launch');
});

test('actual scanner keeps a present malformed launch in the cancellation barrier', async (t) => {
  const env = await fixture(t); const id = 'malformed-current';
  const asyncDir = path.join(env.lifecycleRoot, 'async-subagent-runs', id);
  await mkdir(asyncDir, { recursive: true });
  await writeFile(path.join(asyncDir, 'launch.json'), '{malformed');
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({
    lifecycleArtifactVersion: 3, runId: id, sessionId: 'parent', parentSessionPath: '/sessions/parent.jsonl',
    asyncDir, state: 'complete', pid: process.pid,
    processTerminal: { version: 1, state: 'observed', runId: id, runnerProcessInstanceId: `runner-${id}`, observedAt: 1,
      instances: [{ kind: 'runner', processInstanceId: `runner-${id}`, closeObservedAt: 1 }] }, lastUpdate: 1,
  }));
  const scan = () => scanLifecycleSnapshot({ lifecycleRoot: env.lifecycleRoot,
    runtimeInstanceFile: path.join(env.root, 'none'), processInspector: async (pid) => pid === process.pid });
  let now = 0;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan, now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const result = await coordinator.request({ operationId: id, sessionId: 'parent',
    sessionPath: '/sessions/parent.jsonl', generation: 3 });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.unresolved[0].run_key, `top:${id}`);
  assert.equal(JSON.parse(await readFile(path.join(asyncDir, 'control', 'stop.json'), 'utf8')).runId, id);
});

test('proven local stop preserves remote effects uncertainty', async (t) => {
  const env = await fixture(t); const remote = run(env, 'remote', { blocking: false, execution_state: 'terminal', effects_state: 'unknown' });
  await materialize(remote);
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [remote] }), sleep: async () => {} });
  const result = await coordinator.request({ operationId: 'remote-effects', sessionId: 'parent', generation: 1 });
  assert.equal(result.state, 'stopped'); assert.equal(result.effects_unknown.length, 1);
  assert.equal(result.effects_unknown[0].effects_state, 'unknown');
});

test('parent abort uncertainty survives child-only reconciliation until explicitly proven', async (t) => {
  const env = await fixture(t); const coordinator = createSubagentCancellationCoordinator({ ...env,
    scan: async () => ({ runs: [] }), sleep: async () => {} });
  const input = { operationId: 'parent-abort', sessionId: 'parent', generation: 5 };
  await coordinator.request(input);
  await coordinator.markParentAbortUncertain(input.operationId, 'abort timed out');
  const retried = await coordinator.request(input);
  assert.equal(retried.state, 'uncertain'); assert.match(retried.parent_abort_error, /timed out/);
  assert.ok(retried.errors.some((error) => error.includes('parent-abort')));
  await coordinator.proveParentTerminated(input.operationId);
  const proven = await coordinator.request(input);
  assert.equal(proven.state, 'stopped'); assert.equal(proven.parent_abort_error, null);
});

test('latest cancellation is selected by generation before wall-clock request time', async (t) => {
  const env = await fixture(t); let now = 100;
  const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [] }), now: () => now++, sleep: async () => {} });
  await coordinator.request({ operationId: 'generation-9', sessionId: 'parent', generation: 9 });
  now = 1000;
  await coordinator.request({ operationId: 'generation-8-later', sessionId: 'parent', generation: 8 });
  assert.equal((await coordinator.latestForSession('parent')).operation_id, 'generation-9');
});

test('symlink lifecycle directory is refused without writing outside the root', async (t) => {
  const env = await fixture(t); const outside = path.join(env.root, 'outside'); await mkdir(outside);
  const bad = run(env, 'linked'); await mkdir(path.dirname(bad.async_dir), { recursive: true }); await symlink(outside, bad.async_dir);
  let now = 0; const coordinator = createSubagentCancellationCoordinator({ ...env, scan: async () => ({ runs: [bad] }), now: () => now += 1000, sleep: async () => {}, settleTimeoutMs: 1 });
  const result = await coordinator.request({ operationId: 'safe', sessionId: 'parent', generation: 1 });
  assert.equal(result.state, 'uncertain'); await assert.rejects(() => access(path.join(outside, 'control', 'stop.json')));
});
