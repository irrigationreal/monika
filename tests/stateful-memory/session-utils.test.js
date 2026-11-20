import assert from 'node:assert/strict';
import test from 'node:test';
import { runContext } from '../../config/extensions/stateful-memory/session-utils.js';

test('run context separates user-only enrichment from custom continuation topic routing', () => {
  assert.deepEqual(runContext({ messageType: 'user', prompt: 'new task' }), {
    userPrompt: 'new task', query: 'new task',
  });
  for (const content of ['delegate result', [{ type: 'text', text: 'delegate result' }, { type: 'image', data: 'not text' }]]) {
    assert.deepEqual(runContext({ messageType: 'custom', message: { content }, prompt: 'not a user prompt' }), {
      userPrompt: '', query: 'delegate result',
    });
  }
  assert.deepEqual(runContext({ messageType: 'custom', message: { content: [] } }), { userPrompt: '', query: '' });
});
