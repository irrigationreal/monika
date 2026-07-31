import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  MESSAGE_PROVENANCE_CUSTOM_TYPE,
  appendSubagentCompletionProvenance,
  extractCompletedSubagentRunIds,
  extractMessageProvenance,
  handleProvenanceEvent,
  normalizeForumProvenance,
  registerDispatch,
  settleCompletedSubagentResults,
} from '../src/message-provenance.mjs';

function conversation() {
  const sessionManager = SessionManager.inMemory('/tmp/provenance-test');
  return { session: { sessionManager } };
}

function userMessage(text, timestamp = 1) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function assistantMessage(text, timestamp = 2) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    timestamp,
  };
}

test('persists idempotent subagent completion provenance without a fake user dispatch', () => {
  const conv = conversation();
  const continuation = {
    sourceKind: 'subagent-completion', subagentRunId: 'run-1', subagentRunIds: ['run-1'],
    subagentOrigins: [{ runId: 'run-1', postId: 'post-1' }],
    origin: { turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' },
  };
  const first = appendSubagentCompletionProvenance(conv, 'assistant-1', continuation);
  const second = appendSubagentCompletionProvenance(conv, 'assistant-1', continuation);
  assert.equal(second, first);
  assert.deepEqual(extractMessageProvenance(conv.session.sessionManager.getBranch()).map((entry) => ({
    piMessageId: entry.piMessageId, origin: entry.origin, sourceKind: entry.sourceKind,
    runId: entry.runId, originPostId: entry.originPostId,
  })), [{
    piMessageId: 'assistant-1', origin: 'subagent-completion', sourceKind: 'subagent-completion',
    runId: 'run-1', originPostId: 'post-1',
  }]);
});

test('canonical completion acknowledgement requires an earlier visible terminal assistant', () => {
  const conv = conversation();
  const assistantId = conv.session.sessionManager.appendMessage(assistantMessage('Applied result'));
  appendSubagentCompletionProvenance(conv, assistantId, {
    sourceKind: 'subagent-completion', subagentRunId: 'run-1', subagentRunIds: ['run-1', 'run-2'],
    subagentOrigins: [], origin: null,
  });
  conv.session.sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, {
    version: 1, sourceKind: 'legacy-result', runIds: ['uncertain-run'], messageKind: 'assistant_terminal',
  });

  assert.deepEqual([...extractCompletedSubagentRunIds(conv.session.sessionManager.getBranch())], ['run-1', 'run-2']);
});

test('fabricated, stale, nonterminal, empty, and forward provenance cannot authorize deletion', () => {
  for (const [label, message, mutate] of [
    ['error', assistantMessage('failed'), (entry) => { entry.message.stopReason = 'error'; }],
    ['empty', assistantMessage(''), () => {}],
  ]) {
    const conv = conversation();
    const id = conv.session.sessionManager.appendMessage(message);
    mutate(conv.session.sessionManager.getBranch().find((entry) => entry.id === id));
    conv.session.sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, {
      version: 1, piMessageId: id, sourceKind: 'subagent-completion', messageKind: 'assistant_terminal', runIds: [`run-${label}`],
    });
    assert.deepEqual([...extractCompletedSubagentRunIds(conv.session.sessionManager.getBranch())], []);
  }
  const fabricated = [{ id: 'custom', type: 'custom', customType: MESSAGE_PROVENANCE_CUSTOM_TYPE, data: {
    version: 1, piMessageId: 'missing', sourceKind: 'subagent-completion', messageKind: 'assistant_terminal', runIds: ['run-fake'],
  }}];
  const stale = [{ id: 'assistant', type: 'message', message: assistantMessage('done') }, { id: 'custom', type: 'custom', customType: MESSAGE_PROVENANCE_CUSTOM_TYPE, data: {
    version: 0, piMessageId: 'assistant', sourceKind: 'subagent-completion', messageKind: 'assistant_terminal', runIds: ['run-stale'],
  }}];
  assert.deepEqual([...extractCompletedSubagentRunIds(fabricated)], []);
  assert.deepEqual([...extractCompletedSubagentRunIds(stale)], []);
});

test('proven results settle before bind while deletion failures remain pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'completion-settle-'));
  try {
    const conv = conversation();
    const assistantId = conv.session.sessionManager.appendMessage(assistantMessage('Applied'));
    appendSubagentCompletionProvenance(conv, assistantId, {
      sourceKind: 'subagent-completion', subagentRunId: 'run-ok', subagentRunIds: ['run-ok', 'run-fail'], subagentOrigins: [], origin: null,
    });
    await writeFile(path.join(root, 'run-ok.json'), '{}');
    await writeFile(path.join(root, 'run-fail.json'), '{}');
    const order = [];
    const outcomes = await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), {
      resultsRoot: root,
      remove: async (file, options) => {
        order.push(`remove:${path.basename(file)}`);
        if (file.endsWith('run-fail.json')) throw new Error('injected cleanup failure');
        await rm(file, options);
      },
    });
    order.push('bind');
    assert.deepEqual(order, ['remove:run-ok.json', 'remove:run-fail.json', 'bind']);
    assert.deepEqual(outcomes, [
      { runId: 'run-ok', settled: true, error: null },
      { runId: 'run-fail', settled: false, error: 'injected cleanup failure' },
    ]);
    await assert.rejects(() => import('node:fs/promises').then((mod) => mod.access(path.join(root, 'run-ok.json'))));
    await import('node:fs/promises').then((mod) => mod.access(path.join(root, 'run-fail.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normalizes forum provenance and rejects malformed origins', () => {
  assert.deepEqual(normalizeForumProvenance({ topic_id: 'topic-1', post_id: 'post-1' }), {
    origin: 'forum',
    topicId: 'topic-1',
    postId: 'post-1',
  });
  assert.equal(normalizeForumProvenance(undefined), null);
  assert.throws(() => normalizeForumProvenance({ origin: 'cli', topicId: 't', postId: 'p' }), /origin/);
  assert.throws(() => normalizeForumProvenance({ topicId: 't' }), /postId/);
});

test('ties versioned provenance entries to persisted canonical user and terminal assistant IDs', async () => {
  const conv = conversation();
  const dispatch = registerDispatch(conv, {
    turnId: 'dispatch-1',
    dispatchMode: 'queue',
    text: 'Hello',
    provenance: normalizeForumProvenance({ origin: 'forum', topicId: 'topic-1', postId: 'post-1' }),
  });
  dispatch.accepted = true;

  handleProvenanceEvent(conv, { type: 'agent_start' });
  const user = userMessage('Hello');
  handleProvenanceEvent(conv, { type: 'message_end', message: user });
  // Pi persists after notifying subscribers.
  const userId = conv.session.sessionManager.appendMessage(user);
  await Promise.resolve();

  const assistant = assistantMessage('Hi');
  handleProvenanceEvent(conv, { type: 'message_end', message: assistant });
  const assistantId = conv.session.sessionManager.appendMessage(assistant);
  const reconciliation = handleProvenanceEvent(conv, { type: 'agent_settled' });

  assert.deepEqual(reconciliation, {
    assistantPiMessageId: assistantId,
    userMappings: [{ turn_id: 'dispatch-1', user_pi_message_id: userId }],
  });

  const custom = conv.session.sessionManager.getBranch()
    .filter((entry) => entry.type === 'custom' && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE);
  assert.equal(custom.length, 2);
  assert.deepEqual(custom.map((entry) => entry.data.messageKind), ['user_prompt', 'assistant_terminal']);
  for (const entry of custom) {
    assert.equal(entry.data.version, 1);
    assert.equal(entry.data.turnId, 'dispatch-1');
    assert.equal(entry.data.topicId, 'topic-1');
    assert.equal(entry.data.postId, 'post-1');
    assert.equal(entry.data.dispatchMode, 'queue');
  }
  assert.equal(custom[0].data.piMessageId, userId);
  assert.equal(custom[1].data.piMessageId, assistantId);

  const parsed = extractMessageProvenance(custom);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].entryId, custom[1].id);
  assert.equal(parsed[1].piMessageId, assistantId);
});

test('queued and steered dispatches map to their user entries and one settled terminal assistant', async () => {
  const conv = conversation();
  for (const [turnId, text, dispatchMode] of [
    ['dispatch-1', 'First', 'queue'],
    ['dispatch-2', 'Second', 'steer'],
  ]) {
    const dispatch = registerDispatch(conv, {
      turnId,
      dispatchMode,
      text,
      provenance: normalizeForumProvenance({ topicId: 'topic-1', postId: `${turnId}-post` }),
    });
    dispatch.accepted = true;
  }

  handleProvenanceEvent(conv, { type: 'agent_start' });
  const userIds = [];
  for (const text of ['First', 'Second']) {
    const message = userMessage(text, userIds.length + 1);
    handleProvenanceEvent(conv, { type: 'message_end', message });
    userIds.push(conv.session.sessionManager.appendMessage(message));
    await Promise.resolve();
  }
  const assistant = assistantMessage('Combined answer');
  handleProvenanceEvent(conv, { type: 'message_end', message: assistant });
  const assistantId = conv.session.sessionManager.appendMessage(assistant);

  const reconciliation = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.equal(reconciliation.assistantPiMessageId, assistantId);
  assert.deepEqual(reconciliation.userMappings, [
    { turn_id: 'dispatch-1', user_pi_message_id: userIds[0] },
    { turn_id: 'dispatch-2', user_pi_message_id: userIds[1] },
  ]);

  const assistantProvenance = conv.session.sessionManager.getBranch()
    .filter((entry) => entry.type === 'custom'
      && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE
      && entry.data.messageKind === 'assistant_terminal');
  assert.equal(assistantProvenance.length, 2);
  assert.deepEqual(assistantProvenance.map((entry) => entry.data.piMessageId), [assistantId, assistantId]);
});

