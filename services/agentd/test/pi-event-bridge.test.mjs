import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePiEvent } from '../src/pi-event-bridge.mjs';

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

  dispatch({ type: 'agent_settled' });

  assert.equal(events.filter(({ event }) => event === 'turn_started').length, 1);
  assert.equal(events.filter(({ event }) => event === 'turn_completed').length, 1);
  assert.equal(events.find(({ event }) => event === 'item_completed').data.item.content[0].text, 'Hello');
  assert.deepEqual(events.find(({ event }) => event === 'turn_usage').data.usage, {
    input_tokens: 4,
    output_tokens: 2,
    total_tokens: 6,
  });
  assert.equal(conv.current, null);
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
