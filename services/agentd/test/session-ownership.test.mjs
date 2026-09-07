import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionOwnershipRegistry } from '../src/session-ownership.mjs';

function requireRead(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '{"leases":[]}';
    throw error;
  }
}

test('claims, renews, and releases an external session lease', () => {
  let now = 1_000;
  const registry = new SessionOwnershipRegistry({ leaseMs: 100, createToken: () => 'token-1', now: () => now });

  const claimed = registry.claim('session-1', 'client-1');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.lease.token, 'token-1');
  assert.equal(registry.claim('session-1', 'client-2').ok, false);

  now = 1_050;
  assert.equal(registry.heartbeat('session-1', 'wrong-token'), null);
  assert.equal(registry.heartbeat('session-1', 'token-1')?.expiresAtMs, 1_150);
  assert.equal(registry.release('session-1', 'wrong-token'), false);
  assert.equal(registry.release('session-1', 'token-1'), true);
  assert.equal(registry.get('session-1'), null);
});

test('expires abandoned leases and permits a new owner', () => {
  let now = 1_000;
  let token = 0;
  const registry = new SessionOwnershipRegistry({ leaseMs: 100, createToken: () => `token-${++token}`, now: () => now });

  registry.claim('session-1', 'client-1');
  now = 1_101;
  const claimed = registry.claim('session-1', 'client-2');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.lease.token, 'token-2');
});

test('approximate lease count is an O(1) cache read that intentionally includes expired leases', () => {
  let now = 1_000;
  const registry = new SessionOwnershipRegistry({ leaseMs: 100, now: () => now });
  registry.claim('session-1', 'client-1');
  now = 1_101;

  registry.pruneExpired = () => assert.fail('approximate count must not prune');
  registry.persist = () => assert.fail('approximate count must not persist');
  registry.now = () => assert.fail('approximate count must not check the clock');

  assert.equal(registry.approximateLeaseCount(), 1);
});

test('accurate ownership reads still prune an expired approximate count', () => {
  let now = 1_000;
  const registry = new SessionOwnershipRegistry({ leaseMs: 100, now: () => now });
  registry.claim('session-1', 'client-1');
  now = 1_101;

  assert.equal(registry.approximateLeaseCount(), 1);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.approximateLeaseCount(), 0);
});

test('pending reservation is durable, visible in health/list/quiescence, and promotes after validation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentd-ownership-pending-'));
  const storagePath = path.join(directory, 'leases.json');
  try {
    let now = 1_000;
    const registry = new SessionOwnershipRegistry({ storagePath, leaseMs: 100, now: () => now, createToken: () => 'pending-token' });
    const reserved = registry.reserve('session-1', '/sessions/day_session-1.jsonl', 'client-1');
    assert.equal(reserved.ok, true);
    assert.equal(reserved.lease.pending, true);
    assert.equal(registry.approximateLeaseCount(), 1);
    assert.equal(registry.list()[0].pending, true);
    assert.equal(registry.quiescenceList()[0].pending, true);
    assert.equal(JSON.parse(requireRead(storagePath)).pending[0].token, 'pending-token');

    now = 1_010;
    const promoted = registry.promote('session-1', '/sessions/day_session-1.jsonl', 'pending-token');
    assert.equal(promoted?.pending, undefined);
    assert.equal(registry.approximateLeaseCount(), 1);
    assert.equal(JSON.parse(requireRead(storagePath)).leases[0].token, 'pending-token');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pending reservations restore token fencing, heartbeat, and promotion after restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentd-ownership-restart-'));
  const storagePath = path.join(directory, 'leases.json');
  try {
    let now = 1_000;
    const first = new SessionOwnershipRegistry({ storagePath, leaseMs: 100, now: () => now, createToken: () => 'pending-token' });
    first.reserve('session-1', '/sessions/day_session-1.jsonl', 'client-1');
    const restarted = new SessionOwnershipRegistry({ storagePath, leaseMs: 100, now: () => now });
    assert.equal(restarted.get('session-1')?.pending, true);
    assert.equal(restarted.claim('session-1', 'client-1').ok, false, 'ordinary claim cannot bypass restored pending promotion');
    assert.equal(restarted.claim('session-1', 'client-2').ok, false);
    now = 1_010;
    assert.equal(restarted.heartbeat('session-1', 'pending-token')?.expiresAtMs, 1_110);
    assert.equal(restarted.promote('session-1', '/sessions/day_session-1.jsonl', 'wrong-token'), null);
    assert.equal(restarted.promote('session-1', '/sessions/day_session-1.jsonl', 'pending-token')?.token, 'pending-token');
    assert.equal(restarted.get('session-1')?.pending, undefined);

    // A successful promotion response can be lost. Retrying with the same
    // capability remains idempotent both immediately and after agentd restarts.
    now = 1_020;
    assert.equal(restarted.promote('session-1', '/sessions/day_session-1.jsonl', 'pending-token')?.expiresAtMs, 1_120);
    assert.equal(restarted.promote('session-1', '/sessions/other.jsonl', 'pending-token'), null);
    const promotedRestart = new SessionOwnershipRegistry({ storagePath, leaseMs: 100, now: () => now });
    assert.equal(promotedRestart.promote('session-1', '/sessions/day_session-1.jsonl', 'pending-token')?.token, 'pending-token');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('capability heartbeat and release use the token index with route-ID consistency', () => {
  let now = 1_000;
  let token = 0;
  const registry = new SessionOwnershipRegistry({ leaseMs: 100, now: () => now, createToken: () => `token-${++token}` });
  registry.claim('session-1', 'client-1');
  registry.claim('session-2', 'client-2');
  registry.get = () => assert.fail('capability operations must not perform ID lookup or global pruning');
  registry.pruneExpired = () => assert.fail('capability operations must not globally prune');
  assert.equal(registry.heartbeat('wrong-session', 'token-1'), null);
  now = 1_010;
  assert.equal(registry.heartbeat('session-1', 'token-1')?.expiresAtMs, 1_110);
  assert.equal(registry.release('wrong-session', 'token-1'), false);
  assert.equal(registry.release('session-1', 'token-1'), true);
  now = 1_101;
  assert.equal(registry.heartbeat('session-2', 'token-2'), null);
  assert.equal(registry.approximateLeaseCount(), 0, 'only the addressed expired token is pruned');
});

test('restores an unexpired lease after agentd restarts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentd-ownership-'));
  const storagePath = path.join(directory, 'leases.json');
  try {
    const first = new SessionOwnershipRegistry({ storagePath, now: () => 1_000, createToken: () => 'persisted-token' });
    first.claim('session-1', 'client-1');

    const restored = new SessionOwnershipRegistry({ storagePath, now: () => 1_001 });
    assert.equal(restored.get('session-1')?.token, 'persisted-token');
    assert.equal(restored.describe('session-1')?.client_id, 'client-1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
