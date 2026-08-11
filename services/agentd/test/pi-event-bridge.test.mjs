import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderError, handlePiEvent } from '../src/pi-event-bridge.mjs';

function harness() {
  const events = [];
  const conv = { id: 'conversation-1', current: null };
  let nextId = 0;
  const emit = (_conv, event, data) => events.push({ event, data });
  const dispatch = (event) => handlePiEvent(conv, event, emit, () => `id-${++nextId}`);
  return { conv, events, dispatch };
}

function utterance(id, text, continuation = null) {
  return { piMessageId: id, utteranceId: id, text, continuation, attachmentRefs: [], executionOrigins: [] };
}

test('turn_started exposes the accepted durable dispatch ID and direct runs keep UUID fallback', () => {
  const accepted = harness();
  accepted.conv.provenanceState = { activeTurnId: 'forum-dispatch-1' };
  accepted.dispatch({ type: 'agent_start' });
  assert.deepEqual(accepted.events[0], {
    event: 'turn_started',
    data: { message_id: 'forum-dispatch-1', turn_id: 'forum-dispatch-1', thread_id: 'conversation-1' },
  });

  const direct = harness();
  direct.dispatch({ type: 'agent_start' });
  assert.deepEqual(direct.events[0].data, {
    message_id: 'id-1', turn_id: 'id-1', thread_id: 'conversation-1',
  });
});

test('normal agent run emits canonical persisted content only after agent_settled', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'different live draft' } });
  dispatch({ type: 'agent_end', messages: [{ role: 'assistant', content: 'draft', usage: { input: 4, output: 2, totalTokens: 6 } }] });
  assert.equal(events.some(({ event }) => event === 'turn_completed'), false);

  conv.current.assistantUtterances = [{
    ...utterance('pi-assistant-1', 'Exact persisted text'),
    utteranceIds: ['external-event-1'],
    executionOrigins: [{
      utteranceId: 'external-event-1', originKind: 'external', channelKind: 'matrix',
      topicId: 'topic-1', postId: 'post-1', surfaceId: 'surface-1', externalEventId: '$event',
      scope: '!room', scopeKind: 'thread',
    }],
  }];
  conv.current.userMappings = [{ turn_id: 'forum-dispatch-1', user_pi_message_id: 'pi-user-1' }];
  dispatch({ type: 'agent_settled' });

  assert.equal(events.filter(({ event }) => event === 'turn_started').length, 1);
  const completedItem = events.find(({ event }) => event === 'item_completed').data.item;
  assert.equal(completedItem.content[0].text, 'Exact persisted text');
  assert.deepEqual(completedItem.utterance_ids, ['external-event-1']);
  assert.equal(completedItem.execution_origins[0].externalEventId, '$event');
  assert.deepEqual(events.find(({ event }) => event === 'turn_usage').data.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  assert.deepEqual(events.find(({ event }) => event === 'turn_completed').data, {
    message_id: 'id-1', pi_message_id: 'pi-assistant-1', user_pi_message_id: 'pi-user-1',
    user_mappings: [{ turn_id: 'forum-dispatch-1', user_pi_message_id: 'pi-user-1' }], thread_id: 'conversation-1',
  });
  assert.equal(conv.current, null);
});

test('two canonical assistant entries remain separate and ordered before one idle marker', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'First. Second.' } });
  conv.current.assistantUtterances = [utterance('pi-a', 'First.'), utterance('pi-b', 'Second.')];
  dispatch({ type: 'agent_settled' });
  dispatch({ type: 'agent_settled' });

  assert.deepEqual(events.filter(({ event }) => event === 'item_completed').map(({ data }) => [data.item.id, data.item.content[0].text]), [
    ['pi-a', 'First.'], ['pi-b', 'Second.'],
  ]);
  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 1);
  assert.equal(events.find(({ event }) => event === 'turn_completed').data.pi_message_id, 'pi-b');
});

test('item-specific follow-up attribution does not affect an earlier ordinary item', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  conv.current.assistantUtterances = [
    utterance('pi-a', 'Ordinary'),
    utterance('pi-b', 'Follow-up', {
      sourceKind: 'subagent-completion', subagentRunId: 'run-1', subagentRunIds: ['run-1'], subagentOrigins: [],
      origin: { turnId: 'forum-turn-1', topicId: 'topic-1', postId: 'post-1' },
    }),
  ];
  dispatch({ type: 'agent_settled' });
  const items = events.filter(({ event }) => event === 'item_completed').map(({ data }) => data.item);
  assert.equal(items[0].source_kind, undefined);
  assert.equal(items[1].source_kind, 'subagent-completion');
  assert.equal(items[1].origin_post_id, 'post-1');
  assert.equal(events.find(({ event }) => event === 'turn_completed').data.source_kind, undefined);
});

test('continuation metadata is emitted item-adjacent and cannot precede an ordinary sibling', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  conv.current.assistantUtterances = [utterance('pi-a', 'Ordinary'), utterance('pi-b', 'Continuation', {
    sourceKind: 'subagent-completion', subagentRunId: 'run-b', subagentRunKey: 'top:run-b',
    subagentRunIds: ['run-b'], subagentRunKeys: ['top:run-b'], subagentOrigins: [], origin: null,
  })];
  dispatch({ type: 'agent_settled' });
  assert.deepEqual(events.map(({ event }) => event), ['turn_started', 'item_completed', 'item_completed', 'turn_completed']);
  const items = events.filter(({ event }) => event === 'item_completed').map(({ data }) => data.item);
  assert.equal(items[0].subagent_run_id, undefined);
  assert.equal(items[1].subagent_run_id, 'run-b');
});

test('subagent tool completion redacts exact child bytes while retaining bounded claim status', () => {
  const { events, dispatch } = harness(); const secret = 'CHILD-SECRET-DO-NOT-STREAM';
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent_wait', args: { id: 'run-1' } });
  const internalResult = {
    content: [{ type: 'text', text: `Awaited exact output: ${secret}` }],
    details: { mode: 'management', results: [{ output: secret }], resultClaims: [{
      claim: { runId: 'run-1', runKey: 'top:run-1', deliveryDisposition: 'awaited', resultSha256: 'a'.repeat(64), resultSizeBytes: 123 },
      claimEntryId: 'claim-entry-1', claimPath: `/private/${secret}`, resultPath: `/private/${secret}.json`, idempotent: false,
    }] },
  };
  dispatch({ type: 'tool_execution_end', toolCallId: 'call-1', result: internalResult });
  assert.equal(internalResult.content[0].text.includes(secret), true, 'internal parent tool result remains exact');
  const packet = events.find(({ event }) => event === 'tool_completed');
  assert.equal(JSON.stringify(packet).includes(secret), false);
  assert.deepEqual(packet.data.result.claims, [{ run_id: 'run-1', run_key: 'top:run-1', delivery_disposition: 'awaited', result_sha256: 'a'.repeat(64), result_size_bytes: 123, claim_entry_id: 'claim-entry-1', idempotent: false }]);
  assert.deepEqual(packet.data.result.status, { mode: 'management', state: null, run_id: null, delivery_disposition: null, result_count: 1, claim_count: 1 });
});

test('agent_settled without outward entries emits no message item and marks idle', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  conv.current.assistantUtterances = [];
  dispatch({ type: 'agent_settled' });
  assert.equal(events.some(({ event }) => event === 'item_completed'), false);
  assert.equal(events.find(({ event }) => event === 'turn_completed').data.pi_message_id, null);
});

test('terminal provider failure keeps earlier successful items but emits no successful idle marker', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: 'Earlier' } });
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit exceeded' } });
  conv.current.assistantUtterances = [utterance('pi-earlier', 'Earlier')];
  conv.current.userMappings = [{ turn_id: 'forum-turn-1', user_pi_message_id: 'pi-user-1' }];
  dispatch({ type: 'agent_settled' });
  dispatch({ type: 'agent_settled' });
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.id, 'pi-earlier');
  assert.equal(events.filter(({ event }) => event === 'turn_error').length, 1);
  assert.equal(events.find(({ event }) => event === 'turn_error').data.pi_message_id, 'pi-earlier');
  assert.equal(events.some(({ event }) => event === 'turn_completed'), false);
});

test('a successful retry clears a prior provider failure', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'service unavailable' } });
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: 'Recovered' } });
  conv.current.assistantUtterances = [utterance('pi-recovered', 'Recovered')];
  dispatch({ type: 'agent_settled' });
  assert.equal(events.some(({ event }) => event === 'turn_error'), false);
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.content[0].text, 'Recovered');
});

test('provider error categories are conservative', () => {
  assert.equal(classifyProviderError('maximum context length exceeded'), 'context_overflow');
  assert.equal(classifyProviderError('HTTP 429: too many requests'), 'rate_limit');
  assert.equal(classifyProviderError('401 unauthorized: invalid API key'), 'authentication');
  assert.equal(classifyProviderError('403 Forbidden'), 'authentication');
  assert.equal(classifyProviderError('upstream service unavailable'), 'provider');
  assert.equal(classifyProviderError('Something peculiar happened'), 'unknown');
});

test('compaction lifecycle is forwarded without creating a turn', () => {
  const { events, dispatch } = harness();
  dispatch({ type: 'compaction_start', reason: 'manual' });
  dispatch({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { tokensBefore: 42 } });
  assert.deepEqual(events.map(({ event }) => event), ['compaction_start', 'compaction_end']);
  assert.equal(events[1].data.result.tokensBefore, 42);
});
