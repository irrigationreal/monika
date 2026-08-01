import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compactSubagentRetention, conversationHasPendingRetentionMutations, inventorySubagentRetention, retentionApplyInput, SubagentRetentionCoordinator, summarizeSubagentRetention } from '../src/subagent-retention.mjs';

const DAY = 24 * 60 * 60 * 1000;
function proof(id, at, resumeDisposition = 'unavailable') {
  return { version: 1, state: 'observed', runId: id, runnerProcessInstanceId: `runner-${id}`, observedAt: at, resumeDisposition,
    instances: [{ kind: 'runner', processInstanceId: `runner-${id}`, closeObservedAt: at, exitCode: 0, signal: null }] };
}
async function roots(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-retention-core-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime'); const runsRoot = path.join(lifecycleRoot, 'async-subagent-runs');
  const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results'); const sessionRoot = path.join(root, 'sessions'); const operatorRoot = path.join(root, 'operator');
  await mkdir(runsRoot, { recursive: true }); await mkdir(resultsRoot); await mkdir(sessionRoot); await mkdir(operatorRoot);
  return { root, lifecycleRoot, runsRoot, resultsRoot, sessionRoot, operatorRoot };
}
async function fixture(env, id, { now, age = 15 * DAY, resumeDisposition = 'unavailable', ack = true, pending = false, nestedRoot = null, symlinkFile = false } = {}) {
  const at = now - age;
  const asyncDir = nestedRoot ? path.join(env.lifecycleRoot, 'nested-subagent-runs', nestedRoot, id) : path.join(env.runsRoot, id);
  const sessionDir = path.join(env.sessionRoot, `${nestedRoot ?? 'top'}-${id}`); await mkdir(asyncDir, { recursive: true }); await mkdir(sessionDir);
  await writeFile(path.join(sessionDir, 'session.jsonl'), 'session\n');
  const terminal = proof(id, at, resumeDisposition);
  // Match real pi-subagents status artifacts: lifecycle location comes from the
  // containing scan directory rather than a redundant asyncDir property.
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId: id, sessionId: `session-${id}`, sessionDir, state: 'complete', processTerminal: terminal, lastUpdate: at }));
  await writeFile(path.join(asyncDir, 'process-terminal.json'), JSON.stringify(terminal));
  await writeFile(path.join(asyncDir, 'events.jsonl'), 'verbose events\n'); await writeFile(path.join(asyncDir, 'output-0.log'), 'verbose output\n');
  const runKey = nestedRoot ? `nested:${nestedRoot}:${id}` : `top:${id}`;
  if (ack) {
    const acknowledgement = { version: 1, kind: 'completion-delivery', runId: id, runKey, resultSha256: 'a'.repeat(64), resultSize: 2, proofKind: 'test', proofReference: 'proof-1', acknowledgedAt: at };
    const ackBytes = Buffer.from(JSON.stringify(acknowledgement));
    await writeFile(path.join(asyncDir, 'delivery-ack.json'), ackBytes);
    const ledger = { version: 1, kind: 'completion-delivery-ledger', runId: id, runKey, ackSha256: createHash('sha256').update(ackBytes).digest('hex'), resultSha256: acknowledgement.resultSha256, resultSize: acknowledgement.resultSize, proofKind: acknowledgement.proofKind, proofReference: acknowledgement.proofReference, acknowledgedAt: at };
    await import('node:fs/promises').then(({ appendFile }) => appendFile(path.join(env.operatorRoot, 'delivery-acknowledgements.jsonl'), `${JSON.stringify(ledger)}\n`));
  }
  const resultFile = nestedRoot ? path.join(env.resultsRoot, 'nested', nestedRoot, `${id}.json`) : path.join(env.resultsRoot, `${id}.json`);
  if (pending) { await mkdir(path.dirname(resultFile), { recursive: true }); await writeFile(resultFile, '{}'); }
  if (symlinkFile) await symlink(path.join(env.root, 'escape'), path.join(asyncDir, 'unsafe-link'));
  return { asyncDir, sessionDir, runKey };
}

test('retention summary matches the full forum DTO shape and gives safety errors precedence over age', () => {
  const summary = summarizeSubagentRetention({ inventory: { digest: 'abc', generated_at: 10, retention_ms: 20, eligible_count: 1, eligible_bytes: 7,
    items: [{ eligible: true, bytes: 7, protected_reasons: [] }, { eligible: false, bytes: 3, protected_reasons: ['retention-age-not-met'] },
      { eligible: false, bytes: 2, protected_reasons: ['active-run'] },
      { eligible: false, bytes: 5, protected_reasons: ['retention-age-not-met', 'unsafe-run-directory'] },
      { eligible: false, bytes: 0, protected_reasons: ['already-compacted'] }] },
    result: { compacted_count: 4 }, running: true, lastRunAt: 30 });
  assert.deepEqual(summary, { ok: true, digest: 'abc', generatedAt: 10, retentionMs: 20,
    counts: { protected: 1, waiting: 1, eligible: 1, compacted: 4, error: 1 }, bytes: { tracked_removable: 17, eligible: 7 }, omitted: 0,
    running: true, last_run_at: 30, last_error: null });
});

test('pending conversation mutations block retention even without a current stream', () => {
  assert.equal(conversationHasPendingRetentionMutations({ current: null, pendingMutations: 1 }), true);
  assert.equal(conversationHasPendingRetentionMutations({ current: null, pendingMutations: 0 }), false);
});

test('operator apply requires the exact dry-run digest and an audit reason', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(retentionApplyInput({ apply: true, inventory_digest: digest, reason: ' approved cleanup ' }), {
    inventoryDigest: digest, reason: 'approved cleanup',
  });
  for (const body of [{}, { apply: false, inventory_digest: digest, reason: 'x' },
    { apply: true, inventory_digest: 'not-a-digest', reason: 'x' }, { apply: true, inventory_digest: digest, reason: ' ' }]) {
    assert.throws(() => retentionApplyInput(body), /inventory_digest/);
  }
});

test('cleanup coordinator is an observable blocker and serializes cleanup', async () => {
  const coordinator = new SubagentRetentionCoordinator(); let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const running = coordinator.run(async () => { await paused; return 'done'; });
  await Promise.resolve(); assert.equal(coordinator.inProgress, true);
  await assert.rejects(() => coordinator.run(async () => {}), /already in progress/);
  release(); assert.equal(await running, 'done'); assert.equal(coordinator.inProgress, false);
  await coordinator.wait();
});

test('inventory protects every class outside the narrow automatic tier', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31);
  await fixture(env, 'eligible', { now });
  await fixture(env, 'resumable', { now, resumeDisposition: 'resumable' });
  await fixture(env, 'unacked', { now, ack: false });
  await fixture(env, 'pending', { now, pending: true });
  await fixture(env, 'young', { now, age: DAY });
  await fixture(env, 'root-run', { now });
  await fixture(env, 'nested', { now, nestedRoot: 'root-run' });
  const inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.deepEqual(inventory.items.filter((item) => item.eligible).map((item) => item.run_key), ['top:eligible']);
  assert.ok(inventory.items.find((item) => item.run_key === 'top:resumable').protected_reasons.includes('resumability-or-terminal-proof-protected'));
  assert.ok(inventory.items.find((item) => item.run_key === 'top:unacked').protected_reasons.includes('delivery-ack-missing-or-invalid'));
  assert.ok(inventory.items.find((item) => item.run_key === 'top:pending').protected_reasons.includes('result-still-pending'));
  assert.ok(inventory.items.find((item) => item.run_key === 'top:young').protected_reasons.includes('retention-age-not-met'));
  assert.ok(inventory.items.find((item) => item.run_key === 'top:root-run').protected_reasons.includes('nested-descendants-present'));
  assert.ok(inventory.items.find((item) => item.run_key === 'nested:root-run:nested').protected_reasons.includes('not-unique-top-level'));
});

test('real package status may omit asyncDir while a conflicting claimed path fails closed', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31);
  const run = await fixture(env, 'package-status', { now });
  let inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  let item = inventory.items.find((candidate) => candidate.run_id === 'package-status');
  assert.equal(item.eligible, true);
  assert.equal(item.protected_reasons.includes('invalid-status'), false);

  const statusFile = path.join(run.asyncDir, 'status.json');
  const status = JSON.parse(await readFile(statusFile, 'utf8'));
  status.asyncDir = path.join(env.runsRoot, 'different-run');
  await writeFile(statusFile, JSON.stringify(status));
  inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  item = inventory.items.find((candidate) => candidate.run_id === 'package-status');
  assert.equal(item.eligible, false);
  assert.ok(item.protected_reasons.includes('invalid-status'));
});

test('forged sidecar without exact central ledger proof cannot become eligible', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); await fixture(env, 'forged', { now });
  await rm(path.join(env.operatorRoot, 'delivery-acknowledgements.jsonl'));
  let inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.equal(inventory.eligible_count, 0); assert.ok(inventory.items[0].protected_reasons.includes('central-delivery-ack-missing-or-invalid'));
  await writeFile(path.join(env.operatorRoot, 'delivery-acknowledgements.jsonl'), '{broken\n');
  inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.equal(inventory.eligible_count, 0); assert.ok(inventory.items[0].protected_reasons.includes('central-delivery-ack-missing-or-invalid'));
});

test('digest fencing, authorization durability, and retry are failure-atomic', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); const run = await fixture(env, 'eligible', { now });
  const inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  await assert.rejects(() => compactSubagentRetention({ ...env, nowMs: now, expectedDigest: 'stale' }), /digest mismatch/);
  await assert.rejects(() => compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest,
    beforeStep: async (step) => { if (step === 'before-tombstone') throw new Error('tombstone unavailable'); } }), /tombstone unavailable/);
  await access(path.join(run.asyncDir, 'events.jsonl')); await access(path.join(run.sessionDir, 'session.jsonl'));
  const blockedAudit = path.join(env.lifecycleRoot, 'retention-audit.jsonl'); await mkdir(blockedAudit);
  await assert.rejects(() => compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest }));
  await access(path.join(run.asyncDir, 'events.jsonl')); await access(path.join(run.sessionDir, 'session.jsonl')); await rm(blockedAudit, { recursive: true });
  await assert.rejects(() => compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest,
    beforeStep: async (step) => { if (step === 'after-audit') throw new Error('crash after authorization'); } }), /crash after authorization/);
  await access(path.join(run.asyncDir, 'events.jsonl')); await access(path.join(run.sessionDir, 'session.jsonl'));
  const retryInventory = await inventorySubagentRetention({ ...env, nowMs: now });
  const result = await compactSubagentRetention({ ...env, nowMs: now, expectedDigest: retryInventory.digest });
  assert.equal(result.compacted_count, 1); await assert.rejects(() => access(path.join(run.asyncDir, 'events.jsonl'))); await access(run.sessionDir);
  await access(path.join(run.asyncDir, 'status.json')); await access(path.join(run.asyncDir, 'process-terminal.json')); await access(path.join(run.asyncDir, 'delivery-ack.json'));
  const audit = (await readFile(path.join(env.lifecycleRoot, 'retention-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(audit.some((entry) => entry.phase === 'completed'));
});

test('loaded parent sessions are protected and tombstones bind exact proof bytes and parent linkage', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); const run = await fixture(env, 'loaded', { now });
  const protectedInventory = await inventorySubagentRetention({ ...env, nowMs: now, protectedParentSessionIds: new Set(['session-loaded']) });
  assert.ok(protectedInventory.items[0].protected_reasons.includes('loaded-parent-session'));
  const inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  await compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest });
  const tombstone = JSON.parse(await readFile(path.join(run.asyncDir, 'retention-tombstone.json'), 'utf8'));
  assert.equal(tombstone.parentSessionId, 'session-loaded');
  assert.match(tombstone.processTerminalSha256, /^[a-f0-9]{64}$/);
  assert.match(tombstone.deliveryAckSha256, /^[a-f0-9]{64}$/);
  assert.equal('prompt' in tombstone, false); assert.equal('result' in tombstone, false);
});

test('exact pending control state and parse errors conservatively protect runs', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); await fixture(env, 'controlled', { now });
  const controls = path.join(env.lifecycleRoot, 'chain-runs'); await mkdir(controls);
  await writeFile(path.join(controls, 'pending.json'), JSON.stringify({ state: 'pending', runId: 'controlled' }));
  let inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.ok(inventory.items[0].protected_reasons.includes('pending-supervisor-control'));
  await writeFile(path.join(controls, 'broken.json'), '{');
  inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.ok(inventory.items[0].protected_reasons.includes('pending-supervisor-control'));
});

test('supervisor requests protect only their exact run until a matching reply exists', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31);
  await fixture(env, 'waiting', { now }); await fixture(env, 'other', { now });
  const channel = path.join(env.lifecycleRoot, 'supervisor-channels', 'waiting-worker-0');
  await mkdir(path.join(channel, 'requests'), { recursive: true }); await mkdir(path.join(channel, 'replies'));
  const request = { type: 'subagent.supervisor.request', id: 'recovered-request', createdAt: 0, reason: 'need_decision', message: 'recover me', runId: 'waiting', agent: 'worker', childIndex: 0, expectsReply: true };
  await writeFile(path.join(channel, 'requests', 'recovered-request.json'), JSON.stringify(request));
  await writeFile(path.join(channel, 'requests', 'progress.json'), JSON.stringify({ ...request, id: 'progress', reason: 'progress_update', expectsReply: false }));
  let inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.ok(inventory.items.find((item) => item.run_id === 'waiting').protected_reasons.includes('pending-supervisor-control'));
  assert.equal(inventory.items.find((item) => item.run_id === 'other').protected_reasons.includes('pending-supervisor-control'), false);
  await writeFile(path.join(channel, 'replies', 'recovered-request.json'), '{}');
  inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.equal(inventory.items.some((item) => item.protected_reasons.includes('pending-supervisor-control')), false);
  await writeFile(path.join(channel, 'requests', 'malformed.json'), '{');
  inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.ok(inventory.items.every((item) => item.protected_reasons.includes('pending-supervisor-control')));
});

test('compaction inventory excludes and always preserves child session bytes', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); const run = await fixture(env, 'preserved-session', { now });
  const inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  assert.equal(inventory.items[0].session_present, true); assert.ok(inventory.items[0].session_bytes > 0);
  assert.equal(inventory.items[0].bytes, inventory.items[0].files.reduce((sum, file) => sum + file.size, 0));
  const result = await compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest });
  assert.equal(result.compacted_count, 1); await access(path.join(run.sessionDir, 'session.jsonl'));
});

test('root symlinks fail closed and swapped sessions are preserved without affecting log compaction', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); const run = await fixture(env, 'swap', { now });
  const rootLink = path.join(env.root, 'session-link'); await symlink(env.sessionRoot, rootLink);
  await assert.rejects(() => inventorySubagentRetention({ ...env, sessionRoot: rootLink, nowMs: now }), /unsafe retention root/);
  const inventory = await inventorySubagentRetention({ ...env, nowMs: now });
  const moved = `${run.sessionDir}-original`;
  await compactSubagentRetention({ ...env, nowMs: now, expectedDigest: inventory.digest,
    beforeStep: async (step) => { if (step === 'after-audit') { await rename(run.sessionDir, moved); await mkdir(run.sessionDir); await writeFile(path.join(run.sessionDir, 'replacement'), 'keep'); } } });
  await access(path.join(run.sessionDir, 'replacement')); await access(path.join(moved, 'session.jsonl'));
});

test('symlinks protect the entire run and no candidate is deleted', async (t) => {
  const env = await roots(t); const now = Date.UTC(2026, 6, 31); const run = await fixture(env, 'linked', { now, symlinkFile: true });
  await assert.rejects(() => inventorySubagentRetention({ ...env, nowMs: now }), /unsafe lifecycle symlink/);
  await access(path.join(run.asyncDir, 'events.jsonl')); await access(run.sessionDir);
});
