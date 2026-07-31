import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { acceptDispatch, advanceDispatchFence, dispatchPreflightHandler, inspectDispatch, prepareDispatch, readDispatchFence, resolveDispatchGeneration } from '../src/dispatch-fence.mjs';

function manager() { return SessionManager.inMemory('/tmp/dispatch-fence-test'); }

test('persists acceptance before execution and deduplicates a lost-response retry', () => {
  const sessionManager = manager();
  const first = acceptDispatch(sessionManager, { dispatchId: 'dispatch-1', generation: 2 });
  assert.equal(first.status, 'accepted');
  assert.equal(readDispatchFence(sessionManager.getBranch()).accepted.get('dispatch-1'), 2);
  const retry = acceptDispatch(sessionManager, { dispatchId: 'dispatch-1', generation: 2 });
  assert.equal(retry.status, 'duplicate');
  assert.equal(sessionManager.getBranch().filter((entry) => entry.customType === 'monika.dispatch.fence').length, 1);
});

test('preparation and rejected Pi preflight leave a dispatch retryable', async () => {
  const sessionManager = manager();
  const input = { dispatchId: 'dispatch-retry', generation: 0 };
  await assert.rejects(() => prepareDispatch(sessionManager, input, async () => {
    throw new Error('attachment preparation failed');
  }), /attachment preparation failed/);
  assert.equal(readDispatchFence(sessionManager.getBranch()).accepted.has(input.dispatchId), false);

  const prepared = await prepareDispatch(sessionManager, input, async () => ({ text: 'ready' }));
  assert.equal(prepared.inspection.status, 'ready');
  dispatchPreflightHandler(sessionManager, input)(false);
  assert.equal(inspectDispatch(sessionManager, input).status, 'ready');

  dispatchPreflightHandler(sessionManager, input)(true);
  assert.equal(inspectDispatch(sessionManager, input).status, 'duplicate');
  let duplicatePreparationCalls = 0;
  const duplicate = await prepareDispatch(sessionManager, input, async () => { duplicatePreparationCalls++; return {}; });
  assert.equal(duplicate.inspection.status, 'duplicate');
  assert.equal(duplicatePreparationCalls, 0);
});

test('preflight acceptance fails closed when durable acceptance cannot be written', () => {
  const sessionManager = manager();
  sessionManager.appendCustomEntry = () => { throw new Error('disk unavailable'); };
  const outcomes = [];
  const preflight = dispatchPreflightHandler(
    sessionManager,
    { dispatchId: 'dispatch-write-failure', generation: 0 },
    (accepted) => outcomes.push(accepted),
  );
  assert.throws(() => preflight(true), /disk unavailable/);
  assert.deepEqual(outcomes, [true]);
  assert.equal(readDispatchFence(sessionManager.getBranch()).accepted.has('dispatch-write-failure'), false);
});

test('interrupt fence rejects only explicit older generations and current direct work remains possible', () => {
  const sessionManager = manager();
  assert.deepEqual(advanceDispatchFence(sessionManager, 4), { advanced: true, generation: 4 });
  assert.deepEqual(inspectDispatch(sessionManager, { dispatchId: 'stale', generation: 3 }), { status: 'stale', generation: 4 });
  const currentGeneration = resolveDispatchGeneration(sessionManager, undefined);
  assert.equal(currentGeneration, 4);
  assert.equal(acceptDispatch(sessionManager, { dispatchId: 'direct-without-explicit-generation', generation: currentGeneration }).status, 'accepted');
  assert.equal(acceptDispatch(sessionManager, { dispatchId: 'current', generation: 4 }).status, 'accepted');
});
