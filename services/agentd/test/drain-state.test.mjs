import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableDrainState } from '../src/drain-state.mjs';

test('durable drain state restores the remaining deploy lease and cancel clears it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'drain.json');
  const state = new DurableDrainState(file);

  const now = Date.now();
  await state.publish({ reason: 'deploy-api', leaseExpiresAtMs: now + 20_000 });
  assert.deepEqual(await state.restore(now + 10_000), {
    reason: 'deploy-api',
    leaseExpiresAtMs: now + 20_000,
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    reason: 'deploy-api',
    lease_expires_at_ms: now + 20_000,
  });

  await state.clear();
  assert.equal(await state.restore(now + 10_000), null);
});

test('expired durable drain state safely clears on restore', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new DurableDrainState(path.join(root, 'drain.json'));

  await state.publish({ reason: 'deploy-api', leaseExpiresAtMs: Date.now() + 1_000 });
  assert.equal(await state.restore(Date.now() + 2_000), null);
  assert.equal(await state.restore(Date.now() + 2_000), null);
});

test('drain state path must be absolute', () => {
  assert.throws(() => new DurableDrainState('relative/drain.json'), /absolute path/);
});
