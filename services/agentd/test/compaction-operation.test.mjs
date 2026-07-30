import assert from 'node:assert/strict';
import test from 'node:test';

import { compactConversation, ConversationConflictError } from '../src/compaction-operation.mjs';

function fixture({ leafId = 'leaf-1', branch, pendingMessageCount = 0 } = {}) {
  const entries = branch ?? [{ type: 'message', id: leafId, parentId: null }];
  let compactCalls = 0;
  const manager = {
    getLeafId: () => entries.at(-1)?.id ?? null,
    getBranch: () => entries,
  };
  const session = {
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount,
    compact: async (instructions) => {
      compactCalls += 1;
      const result = {
        summary: `summary:${instructions ?? ''}`,
        firstKeptEntryId: leafId,
        tokensBefore: 1200,
        estimatedTokensAfter: 300,
        usage: { input: 10, output: 5, totalTokens: 15 },
        details: { source: 'test' },
      };
      entries.push({ type: 'compaction', id: 'compact-1', parentId: leafId, ...result });
      return result;
    },
  };
  const conv = { current: null, session, compactionOperation: null };
  return { conv, entries, get compactCalls() { return compactCalls; } };
}

const request = {
  operation_id: 'operation-1',
  expected_leaf_id: 'leaf-1',
  custom_instructions: 'preserve decisions',
};

test('compacts an idle conversation and returns Pi result plus entry id', async () => {
  const state = fixture();
  const response = await compactConversation(state.conv, request);

  assert.equal(state.compactCalls, 1);
  assert.equal(response.operation_id, 'operation-1');
  assert.equal(response.compaction_entry_id, 'compact-1');
  assert.equal(response.already_completed, false);
  assert.equal(response.result.tokensBefore, 1200);
  assert.equal(response.result.estimatedTokensAfter, 300);
});

test('lost-response retry recognizes compaction child and never compacts twice', async () => {
  const state = fixture({ branch: [
    { type: 'message', id: 'leaf-1', parentId: null },
    {
      type: 'compaction', id: 'compact-existing', parentId: 'leaf-1', summary: 'saved',
      firstKeptEntryId: 'kept-1', tokensBefore: 900, usage: { totalTokens: 12 }, details: { durable: true },
    },
  ] });

  const response = await compactConversation(state.conv, request);
  assert.equal(state.compactCalls, 0);
  assert.equal(response.already_completed, true);
  assert.equal(response.compaction_entry_id, 'compact-existing');
  assert.deepEqual(response.result, {
    summary: 'saved', firstKeptEntryId: 'kept-1', tokensBefore: 900,
    usage: { totalTokens: 12 }, details: { durable: true },
  });
});

test('stale expected leaf returns a structured conflict', async () => {
  const state = fixture({ leafId: 'new-leaf' });
  await assert.rejects(
    compactConversation(state.conv, request),
    (err) => err instanceof ConversationConflictError
      && err.code === 'stale_leaf'
      && err.details.actual_leaf_id === 'new-leaf',
  );
  assert.equal(state.compactCalls, 0);
});

test('idle gate checks active turn, streaming, compaction, and pending queues', async () => {
  for (const mutate of [
    (conv) => { conv.current = {}; },
    (conv) => { conv.session.isStreaming = true; },
    (conv) => { conv.session.isCompacting = true; },
    (conv) => { conv.session.pendingMessageCount = 1; },
    (conv) => { conv.session.agent = { hasQueuedMessages: () => true }; },
    (conv) => { conv.compactionOperation = Promise.resolve(); },
  ]) {
    const state = fixture();
    mutate(state.conv);
    await assert.rejects(
      compactConversation(state.conv, request),
      (err) => err instanceof ConversationConflictError && err.code === 'conversation_busy',
    );
    assert.equal(state.compactCalls, 0);
  }
});

test('requires operation id, expected leaf, and string instructions', async () => {
  const state = fixture();
  await assert.rejects(compactConversation(state.conv, {}), /operation_id is required/);
  await assert.rejects(compactConversation(state.conv, { operation_id: 'op' }), /expected_leaf_id is required/);
  await assert.rejects(compactConversation(state.conv, {
    operation_id: 'op', expected_leaf_id: 'leaf-1', custom_instructions: 42,
  }), /custom_instructions must be a string/);
  assert.equal(state.compactCalls, 0);
});
