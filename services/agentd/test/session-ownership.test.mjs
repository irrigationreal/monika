import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionOwnershipRegistry } from '../src/session-ownership.mjs';

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
