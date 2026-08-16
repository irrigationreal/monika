import assert from 'node:assert/strict';
import test from 'node:test';

import { runBoundedShutdown, runCanonicalShutdownCleanup } from '../src/shutdown.mjs';

test('canonical shutdown aggregates close failures and still attempts every conversation', async () => {
  const attempted = [];
  const retentionFailure = new Error('retention fence unresolved');
  const closeFailure = new Error('fork fence unresolved');
  await assert.rejects(
    runCanonicalShutdownCleanup({
      waitForRetention: async () => {
        throw retentionFailure;
      },
      conversations: ['first', 'second'],
      closeConversation: async (conversation) => {
        attempted.push(conversation);
        if (conversation === 'first') throw closeFailure;
      },
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [retentionFailure, closeFailure]);
      return true;
    },
  );
  assert.deepEqual(attempted, ['first', 'second']);
});

test('bounded shutdown ends transport and exits at the deadline when canonical cleanup is fenced', async () => {
  const calls = [];
  let fireDeadline;
  const fenced = new Promise(() => {});
  const running = runBoundedShutdown({
    beginTransportShutdown: () => calls.push('begin-transport'),
    gracefulShutdown: () => fenced,
    forceTransportShutdown: () => calls.push('force-transport'),
    exit: (code) => calls.push(`exit-${code}`),
    deadlineMs: 50,
    setTimer: (callback) => {
      fireDeadline = callback;
      return { unref() {} };
    },
    clearTimer: () => calls.push('clear-timer'),
  });

  assert.deepEqual(calls, ['begin-transport']);
  fireDeadline();
  const result = await running;
  assert.equal(result.graceful, false);
  assert.deepEqual(calls, ['begin-transport', 'clear-timer', 'force-transport', 'exit-1']);
});

test('bounded shutdown reports canonical cleanup failures as a nonzero exit', async () => {
  const calls = [];
  const failure = new Error('unresolved fork fence');
  const result = await runBoundedShutdown({
    beginTransportShutdown: () => calls.push('begin-transport'),
    gracefulShutdown: async () => {
      throw failure;
    },
    forceTransportShutdown: () => calls.push('finish-transport'),
    exit: (code) => calls.push(`exit-${code}`),
    deadlineMs: 50,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => calls.push('clear-timer'),
  });
  assert.equal(result.graceful, false);
  assert.equal(result.error, failure);
  assert.deepEqual(calls, ['begin-transport', 'clear-timer', 'finish-transport', 'exit-1']);
});

test('bounded shutdown preserves graceful cleanup before a clean exit', async () => {
  const calls = [];
  await runBoundedShutdown({
    beginTransportShutdown: () => calls.push('begin-transport'),
    gracefulShutdown: async () => calls.push('memory-saved'),
    forceTransportShutdown: () => calls.push('finish-transport'),
    exit: (code) => calls.push(`exit-${code}`),
    deadlineMs: 50,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => calls.push('clear-timer'),
  });
  assert.deepEqual(calls, ['begin-transport', 'memory-saved', 'clear-timer', 'finish-transport', 'exit-0']);
});
