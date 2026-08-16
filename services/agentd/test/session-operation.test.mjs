import assert from 'node:assert/strict';
import test from 'node:test';

import { ForumForkConflictError } from '../src/forum-fork-operation.mjs';
import { SessionOperationCoordinator, withForumMutableSessionOperation } from '../src/session-operation.mjs';

test('a writer queued before fork fencing rechecks mutability after acquiring the session lock', async () => {
  const coordinator = new SessionOperationCoordinator();
  let fenced = false;
  const ledger = { hasSourceFence: async () => fenced };
  let releaseHolder;
  const holder = coordinator.run('session-1', () => new Promise((resolve) => { releaseHolder = resolve; }));
  await Promise.resolve();

  const fork = coordinator.run('session-1', async () => {
    fenced = true;
  });
  let mutated = false;
  const queuedWriter = withForumMutableSessionOperation(coordinator, ledger, 'session-1', async () => {
    mutated = true;
  });

  // The fork was queued first and publishes durable fencing while the writer
  // waits. The old pre-lock check/use sequence would mutate after this point.
  releaseHolder();
  await holder;
  await fork;

  await assert.rejects(
    queuedWriter,
    (error) => error instanceof ForumForkConflictError && error.code === 'fork_in_progress',
  );
  assert.equal(mutated, false);
});

test('the fork operation can own the same session lock without recursively taking the mutable-writer lock', async () => {
  const coordinator = new SessionOperationCoordinator();
  const order = [];
  await coordinator.run('session-1', async () => {
    order.push('fork-start');
    order.push('fork-fenced');
  });
  assert.deepEqual(order, ['fork-start', 'fork-fenced']);
});
