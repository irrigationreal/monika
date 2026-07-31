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

test('normal agent run completes only after agent_settled', () => {
  const { conv, events, dispatch } = harness();

  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
  dispatch({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }], usage: { input: 4, output: 2, totalTokens: 6 } }],
  });

  assert.equal(events.some(({ event }) => event === 'turn_completed'), false);
  assert.notEqual(conv.current, null);

  conv.current.piMessageId = 'pi-assistant-1';
  conv.current.userMappings = [{ turn_id: 'forum-dispatch-1', user_pi_message_id: 'pi-user-1' }];
  dispatch({ type: 'agent_settled' });

  assert.equal(events.filter(({ event }) => event === 'turn_started').length, 1);
  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 1);
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.content[0].text, 'Hello');
  assert.deepEqual(events.find(({ event }) => event === 'turn_usage').data.usage, {
    input_tokens: 4,
    output_tokens: 2,
    total_tokens: 6,
  });
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.id, 'pi-assistant-1');
  assert.deepEqual(events.find(({ event }) => event === 'turn_completed').data, {
    message_id: 'id-1',
    pi_message_id: 'pi-assistant-1',
    user_pi_message_id: 'pi-user-1',
    user_mappings: [{ turn_id: 'forum-dispatch-1', user_pi_message_id: 'pi-user-1' }],
    thread_id: 'conversation-1',
  });
  assert.equal(conv.current, null);
});

test('subagent completion continuation emits canonical attribution without a fake user mapping', () => {
  const { conv, events, dispatch } = harness();
  dispatch({ type: 'agent_start' });
  Object.assign(conv.current, {
    sourceKind: 'subagent-completion',
    subagentRunId: 'run-1',
    origin: { turnId: 'forum-turn-1', topicId: 'topic-1', postId: 'post-1' },
    piMessageId: 'pi-assistant-1',
  });
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done' } });
  dispatch({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Done' }] });
  dispatch({ type: 'agent_settled' });

  const item = events.find(({ event }) => event === 'item_completed').data.item;
  assert.equal(item.id, 'pi-assistant-1');
  assert.equal(item.source_kind, 'subagent-completion');
  assert.equal(item.subagent_run_id, 'run-1');
  assert.equal(item.origin_post_id, 'post-1');
  const completed = events.find(({ event }) => event === 'turn_completed').data;
  assert.deepEqual(completed.user_mappings, []);
  assert.equal(completed.user_pi_message_id, null);
  assert.equal(completed.source_kind, 'subagent-completion');
  assert.equal(completed.origin_turn_id, 'forum-turn-1');
});

test('terminal provider failure emits one standardized error at settlement without completion', () => {
  const { conv, events, dispatch } = harness();

  dispatch({ type: 'agent_start' });
  dispatch({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit exceeded' },
  });
  conv.current.piMessageId = 'pi-error-1';
  conv.current.userMappings = [{ turn_id: 'forum-turn-1', user_pi_message_id: 'pi-user-1' }];

  assert.equal(events.some(({ event }) => event === 'turn_error'), false);
  dispatch({ type: 'agent_settled' });
  dispatch({ type: 'agent_settled' });

  assert.deepEqual(events.filter(({ event }) => event === 'turn_error'), [{
    event: 'turn_error',
    data: {
      error: '429 rate limit exceeded',
      category: 'rate_limit',
      turn_id: 'forum-turn-1',
      pi_message_id: 'pi-error-1',
      thread_id: 'conversation-1',
    },
  }]);
  assert.equal(events.some(({ event }) => event === 'turn_completed'), false);
  assert.equal(events.some(({ event }) => event === 'item_completed'), false);
  assert.equal(conv.current, null);
});

test('a successful retry clears the prior provider failure', () => {
  const { events, dispatch } = harness();

  dispatch({ type: 'agent_start' });
  dispatch({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'service unavailable' },
  });
  dispatch({ type: 'agent_end', messages: [] });
  dispatch({ type: 'agent_start' });
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered' } });
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: 'Recovered' } });
  dispatch({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Recovered' }] });
  dispatch({ type: 'agent_settled' });

  assert.equal(events.some(({ event }) => event === 'turn_error'), false);
  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 1);
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

test('retry or continuation does not create an early or duplicate completion', () => {
  const { conv, events, dispatch } = harness();

  dispatch({ type: 'agent_start' });
  const messageId = conv.current.messageId;
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'First. ' } });
  dispatch({ type: 'agent_end', messages: [{ role: 'assistant', content: 'First.' }] });

  dispatch({ type: 'agent_start' });
  assert.equal(conv.current.messageId, messageId);
  dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Second.' } });
  dispatch({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: 'Second.', usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }],
  });

  assert.equal(events.filter(({ event }) => event === 'turn_started').length, 1);
  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 0);

  dispatch({ type: 'agent_settled' });
  dispatch({ type: 'agent_settled' });

  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 1);
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.content[0].text, 'First. Second.');
  assert.equal(conv.current, null);
});
