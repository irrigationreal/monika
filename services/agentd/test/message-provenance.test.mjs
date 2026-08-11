import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  isOutwardAssistantMessage,
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
    const lifecycleRoot = path.join(root, 'lifecycle'); const resultsRoot = path.join(root, 'results'); const operatorRoot = path.join(root, 'operator');
    await import('node:fs/promises').then((mod) => Promise.all([mod.mkdir(lifecycleRoot), mod.mkdir(resultsRoot), mod.mkdir(operatorRoot)]));
    for (const runId of ['run-ok', 'run-fail']) {
      const asyncDir = path.join(lifecycleRoot, runId); await import('node:fs/promises').then((mod) => mod.mkdir(asyncDir));
      await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId, sessionId: `session-${runId}`, asyncDir, state: 'complete', lastUpdate: 1 }));
      await writeFile(path.join(resultsRoot, `${runId}.json`), '{}');
    }
    const order = [];
    const outcomes = await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), {
      resultsRoot, lifecycleRoot, operatorRoot,
      beforeAck: async (ack) => { order.push(`ack:${ack.runId}`); if (ack.runId === 'run-fail') throw new Error('injected ack failure'); },
      beforeCustody: async ({ source }) => { order.push(`custody:${path.basename(source)}`); },
    });
    order.push('bind');
    assert.deepEqual(order, ['ack:run-ok', 'custody:run-ok.json', 'ack:run-fail', 'bind']);
    assert.deepEqual(outcomes, [
      { runId: 'run-ok', runKey: 'top:run-ok', settled: true, error: null },
      { runId: 'run-fail', runKey: null, settled: false, error: 'injected ack failure' },
    ]);
    await assert.rejects(() => import('node:fs/promises').then((mod) => mod.access(path.join(resultsRoot, 'run-ok.json'))));
    await import('node:fs/promises').then((mod) => mod.access(path.join(resultsRoot, 'run-fail.json')));
    const ack = JSON.parse(await readFile(path.join(lifecycleRoot, 'run-ok', 'delivery-ack.json'), 'utf8'));
    assert.equal(ack.runKey, 'top:run-ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exact awaited claim settles only after visible canonical parent synthesis', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'awaited-claim-settle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime');
  const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results');
  const operatorRoot = path.join(root, 'operator');
  const asyncDir = path.join(lifecycleRoot, 'async-subagent-runs', 'awaited-1');
  await import('node:fs/promises').then((mod) => Promise.all([mod.mkdir(asyncDir, { recursive: true }), mod.mkdir(resultsRoot, { recursive: true }), mod.mkdir(operatorRoot)]));
  const resultBytes = Buffer.from('{"lifecycleArtifactVersion":5,"runId":"awaited-1","sessionId":"parent-session","asyncDir":"' + asyncDir + '","deliveryDisposition":"awaited"}\n');
  const digest = (await import('node:crypto')).createHash('sha256').update(resultBytes).digest('hex');
  const claim = {
    version: 1, kind: 'pi-subagents.result-claim', runId: 'awaited-1', runKey: 'top:awaited-1',
    sessionId: 'parent-session', deliveryDisposition: 'awaited', resultSha256: digest,
    resultSizeBytes: resultBytes.length, claimedAt: 1,
  };
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify({ lifecycleArtifactVersion: 5, runId: 'awaited-1', sessionId: 'parent-session', asyncDir, deliveryDisposition: 'awaited' }));
  await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 5, runId: 'awaited-1', sessionId: 'parent-session', asyncDir, deliveryDisposition: 'awaited' }));
  await writeFile(path.join(asyncDir, 'result-claim.json'), `${JSON.stringify(claim)}\n`);
  await writeFile(path.join(resultsRoot, 'awaited-1.json'), resultBytes);

  const conv = conversation();
  const claimEntryId = conv.session.sessionManager.appendCustomEntry('pi-subagents.result-claim', claim);
  const assistantId = conv.session.sessionManager.appendMessage(assistantMessage('I incorporated the claimed result.'));
  conv.session.sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, {
    version: 2, piMessageId: assistantId, utteranceId: assistantId, messageKind: 'assistant_outward', utteranceKind: 'participant',
    executionOrigins: [], continuation: null, resultClaims: [{ ...claim, claimEntryId }], attachmentRefs: [], createdAt: new Date().toISOString(),
  });
  const outcomes = await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), {
    resultsRoot, lifecycleRoot, operatorRoot, parentSessionId: 'parent-session',
  });
  assert.deepEqual(outcomes, [{ runId: 'awaited-1', runKey: 'top:awaited-1', settled: true, error: null }]);
  await assert.rejects(() => import('node:fs/promises').then((mod) => mod.access(path.join(resultsRoot, 'awaited-1.json'))));
  const ack = JSON.parse(await readFile(path.join(asyncDir, 'delivery-ack.json'), 'utf8'));
  assert.equal(ack.proofKind, 'awaited-result-claim-synthesis');
});

test('foreign-session awaited claim retains exact result and cannot gain custody', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'awaited-claim-foreign-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime'); const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator');
  const asyncDir = path.join(lifecycleRoot, 'async-subagent-runs', 'awaited-foreign');
  await import('node:fs/promises').then((mod) => Promise.all([mod.mkdir(asyncDir, { recursive: true }), mod.mkdir(resultsRoot, { recursive: true }), mod.mkdir(operatorRoot)]));
  const result = { lifecycleArtifactVersion: 5, runId: 'awaited-foreign', sessionId: 'foreign-session', asyncDir, deliveryDisposition: 'awaited' };
  const resultBytes = Buffer.from(`${JSON.stringify(result)}\n`); const digest = (await import('node:crypto')).createHash('sha256').update(resultBytes).digest('hex');
  const claim = { version: 1, kind: 'pi-subagents.result-claim', runId: 'awaited-foreign', runKey: 'top:awaited-foreign', sessionId: 'foreign-session', deliveryDisposition: 'awaited', resultSha256: digest, resultSizeBytes: resultBytes.length, claimedAt: 1 };
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify(result)); await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify(result));
  await writeFile(path.join(asyncDir, 'result-claim.json'), `${JSON.stringify(claim)}\n`); await writeFile(path.join(resultsRoot, 'awaited-foreign.json'), resultBytes);
  const conv = conversation(); const claimEntryId = conv.session.sessionManager.appendCustomEntry('pi-subagents.result-claim', claim);
  const assistantId = conv.session.sessionManager.appendMessage(assistantMessage('Attempted foreign synthesis'));
  conv.session.sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, { version: 2, piMessageId: assistantId, utteranceId: assistantId, messageKind: 'assistant_outward', utteranceKind: 'participant', executionOrigins: [], continuation: null, resultClaims: [{ ...claim, claimEntryId }], attachmentRefs: [] });
  const outcomes = await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), { resultsRoot, lifecycleRoot, operatorRoot, parentSessionId: 'parent-session' });
  assert.equal(outcomes[0].settled, false); assert.match(outcomes[0].error, /parent session identity mismatch/);
  assert.deepEqual(await readFile(path.join(resultsRoot, 'awaited-foreign.json')), resultBytes);
  await assert.rejects(() => import('node:fs/promises').then((mod) => mod.access(path.join(asyncDir, 'delivery-ack.json'))));
});

test('silent result cannot be settled by fabricated follow-up provenance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'silent-result-retain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime'); const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator');
  const asyncDir = path.join(lifecycleRoot, 'async-subagent-runs', 'silent-1');
  await import('node:fs/promises').then((mod) => Promise.all([mod.mkdir(asyncDir, { recursive: true }), mod.mkdir(resultsRoot, { recursive: true }), mod.mkdir(operatorRoot)]));
  const artifact = { lifecycleArtifactVersion: 5, runId: 'silent-1', sessionId: 'parent-session', asyncDir, deliveryDisposition: 'silent' };
  await writeFile(path.join(asyncDir, 'launch.json'), JSON.stringify(artifact)); await writeFile(path.join(asyncDir, 'status.json'), JSON.stringify(artifact));
  const resultFile = path.join(resultsRoot, 'silent-1.json'); await writeFile(resultFile, '{}');
  const conv = conversation(); const assistantId = conv.session.sessionManager.appendMessage(assistantMessage('Visible but not a valid silent proof'));
  conv.session.sessionManager.appendCustomEntry(MESSAGE_PROVENANCE_CUSTOM_TYPE, {
    version: 2, piMessageId: assistantId, utteranceId: assistantId, messageKind: 'assistant_outward', utteranceKind: 'participant',
    executionOrigins: [], continuation: { sourceKind: 'subagent-completion', subagentRunId: 'silent-1', subagentRunKey: 'top:silent-1', subagentRunIds: ['silent-1'], subagentRunKeys: ['top:silent-1'] }, resultClaims: [], attachmentRefs: [],
  });
  const outcomes = await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), { resultsRoot, lifecycleRoot, operatorRoot });
  assert.equal(outcomes[0].settled, false); assert.match(outcomes[0].error, /follow_up disposition mismatch/);
  assert.equal(await readFile(resultFile, 'utf8'), '{}');
});

test('awaited claim without visible synthesis retains its exact result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'awaited-claim-retain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'runtime'); const resultsRoot = path.join(lifecycleRoot, 'async-subagent-results'); const operatorRoot = path.join(root, 'operator');
  await import('node:fs/promises').then((mod) => Promise.all([mod.mkdir(resultsRoot, { recursive: true }), mod.mkdir(operatorRoot)]));
  const resultFile = path.join(resultsRoot, 'awaited-1.json'); await writeFile(resultFile, '{}');
  const conv = conversation();
  conv.session.sessionManager.appendCustomEntry('pi-subagents.result-claim', {
    version: 1, kind: 'pi-subagents.result-claim', runId: 'awaited-1', runKey: 'top:awaited-1', sessionId: 'parent-session',
    deliveryDisposition: 'awaited', resultSha256: '0'.repeat(64), resultSizeBytes: 2, claimedAt: 1,
  });
  assert.deepEqual(await settleCompletedSubagentResults(conv.session.sessionManager.getBranch(), { resultsRoot, lifecycleRoot, operatorRoot }), []);
  assert.equal(await readFile(resultFile, 'utf8'), '{}');
});

test('normalizes forum provenance and rejects malformed origins', () => {
  assert.deepEqual(normalizeForumProvenance({ topic_id: 'topic-1', post_id: 'post-1' }), {
    origin: 'forum', topicId: 'topic-1', postId: 'post-1', version: 1,
    utteranceIds: ['post-1'], executionOrigins: [],
  });
  assert.equal(normalizeForumProvenance(undefined), null);
  assert.throws(() => normalizeForumProvenance({ origin: 'cli', topicId: 't', postId: 'p' }), /origin/);
  assert.throws(() => normalizeForumProvenance({ topicId: 't' }), /postId/);
});

test('preserves validated external v2 origin identity through canonical provenance', async () => {
  const origin = {
    utteranceId: 'matrix-event-1', originKind: 'external', channelKind: 'matrix',
    topicId: 'topic-1', postId: 'post-1', surfaceId: 'surface-1',
    externalEventId: '$event-1', scope: '!room:example', scopeKind: 'thread',
  };
  const provenance = normalizeForumProvenance({
    origin: 'forum', version: 2, topicId: 'topic-1', postId: 'post-1',
    utteranceIds: ['post-0', 'post-1'], executionOrigins: [origin],
  });
  assert.deepEqual(provenance.executionOrigins, [origin]);
  const conv = conversation();
  const dispatch = registerDispatch(conv, { turnId: 'v2', dispatchMode: 'queue', text: 'External', provenance });
  dispatch.accepted = true;
  handleProvenanceEvent(conv, { type: 'agent_start' });
  const user = userMessage('External');
  handleProvenanceEvent(conv, { type: 'message_end', message: user });
  conv.session.sessionManager.appendMessage(user);
  await Promise.resolve();
  const assistant = assistantMessage('Reply');
  handleProvenanceEvent(conv, { type: 'message_end', message: assistant });
  conv.session.sessionManager.appendMessage(assistant);
  const result = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.deepEqual(result.assistantUtterances[0].executionOrigins, [origin]);
  assert.deepEqual(result.assistantUtterances[0].utteranceIds, ['post-0', 'post-1']);
});

test('binds canonical structured attachment refs once to the next outward assistant', () => {
  const conv = conversation();
  handleProvenanceEvent(conv, { type: 'agent_start' });
  const refId = conv.session.sessionManager.appendCustomEntry('monika.forum.attachment.ref', {
    version: 1, pendingAttachmentId: 'pending-1', topicId: 'topic-1', filename: 'proof.txt',
    mimeType: 'text/plain', sizeBytes: 4, sha256: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const first = assistantMessage('With attachment');
  handleProvenanceEvent(conv, { type: 'message_end', message: first });
  conv.session.sessionManager.appendMessage(first);
  const result = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.equal(result.assistantUtterances[0].attachmentRefs[0].refEntryId, refId);

  handleProvenanceEvent(conv, { type: 'agent_start' });
  const second = assistantMessage('Without attachment');
  handleProvenanceEvent(conv, { type: 'message_end', message: second });
  conv.session.sessionManager.appendMessage(second);
  const replay = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.deepEqual(replay.assistantUtterances[0].attachmentRefs, []);
});

test('binds each agent_start to the earliest accepted queued dispatch without making steers boundaries', () => {
  const conv = conversation();
  const first = registerDispatch(conv, { turnId: 'queue-1', dispatchMode: 'queue', text: 'first', provenance: null });
  first.accepted = true;

  handleProvenanceEvent(conv, { type: 'agent_start' });
  assert.equal(conv.provenanceState.activeTurnId, 'queue-1');

  const steer = registerDispatch(conv, { turnId: 'steer-1', dispatchMode: 'steer', text: 'more', provenance: null });
  steer.accepted = true;
  const unaccepted = registerDispatch(conv, { turnId: 'queue-unaccepted', dispatchMode: 'queue', text: 'not durable', provenance: null });
  unaccepted.accepted = null;
  const next = registerDispatch(conv, { turnId: 'queue-2', dispatchMode: 'queue', text: 'next', provenance: null });
  next.accepted = true;

  handleProvenanceEvent(conv, { type: 'agent_start' });
  assert.equal(conv.provenanceState.activeTurnId, 'queue-1', 'agent_start retry does not create another boundary');
  handleProvenanceEvent(conv, { type: 'agent_settled' });
  handleProvenanceEvent(conv, { type: 'agent_start' });

  assert.equal(conv.provenanceState.activeTurnId, 'queue-2');
  assert.equal(steer.boundaryStarted, false);
  assert.equal(unaccepted.boundaryStarted, false);
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

  assert.equal(reconciliation.assistantPiMessageId, assistantId);
  assert.deepEqual(reconciliation.userMappings, [{ turn_id: 'dispatch-1', user_pi_message_id: userId }]);
  assert.deepEqual(reconciliation.assistantUtterances.map((item) => [item.piMessageId, item.text]), [[assistantId, 'Hi']]);

  const custom = conv.session.sessionManager.getBranch()
    .filter((entry) => entry.type === 'custom' && entry.customType === MESSAGE_PROVENANCE_CUSTOM_TYPE);
  assert.equal(custom.length, 2);
  assert.deepEqual(custom.map((entry) => entry.data.messageKind), ['user_prompt', 'assistant_outward']);
  for (const entry of custom) assert.equal(entry.data.version, 2);
  assert.equal(custom[0].data.turnId, 'dispatch-1');
  assert.equal(custom[0].data.topicId, 'topic-1');
  assert.equal(custom[0].data.postId, 'post-1');
  assert.equal(custom[0].data.dispatchMode, 'queue');
  assert.equal(custom[0].data.piMessageId, userId);
  assert.equal(custom[1].data.piMessageId, assistantId);
  assert.equal(custom[1].data.utteranceId, assistantId);
  assert.equal(custom[1].data.executionOrigins[0].postId, 'post-1');

  const parsed = extractMessageProvenance(custom);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].entryId, custom[1].id);
  assert.equal(parsed[1].piMessageId, assistantId);
});

test('queued and steered dispatches remain prompt facts while one outward entry has shared execution origins', async () => {
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
      && entry.data.messageKind === 'assistant_outward');
  assert.equal(assistantProvenance.length, 1);
  assert.equal(assistantProvenance[0].data.piMessageId, assistantId);
  assert.deepEqual(assistantProvenance[0].data.executionOrigins.map((origin) => origin.postId), ['dispatch-1-post', 'dispatch-2-post']);
});

test('outward classification is channel-neutral and keeps visible tool-use preambles', () => {
  for (const channel of [undefined, 'analysis', 'final', 'custom-transport']) {
    assert.equal(isOutwardAssistantMessage({ ...assistantMessage('Visible'), channel }), true);
    assert.equal(isOutwardAssistantMessage({ ...assistantMessage('Visible'), channel, stopReason: 'toolUse' }), true);
  }
  for (const message of [
    userMessage('user'),
    { role: 'custom', content: 'raw child result', customType: 'subagent-notify' },
    { role: 'toolResult', content: [{ type: 'text', text: 'internal tool result' }] },
    assistantMessage(''),
    { ...assistantMessage('failed'), stopReason: 'error' },
  ]) assert.equal(isOutwardAssistantMessage(message), false);
});

test('assistant A then notify then assistant B preserves both IDs and attributes only B', () => {
  const conv = conversation();
  handleProvenanceEvent(conv, { type: 'agent_start' });
  const first = assistantMessage('First', 1);
  handleProvenanceEvent(conv, { type: 'message_end', message: first }, { consumeCausalMetadata: () => ({}) });
  const firstId = conv.session.sessionManager.appendMessage(first);
  const continuation = {
    runId: 'run-1', runKey: 'top:run-1', runIds: ['run-1'], runKeys: ['top:run-1'], origins: [],
    origin: { turnId: 'turn-1', topicId: 'topic-1', postId: 'post-1' },
  };
  const second = assistantMessage('Second', 2);
  handleProvenanceEvent(conv, { type: 'message_end', message: second }, {
    consumeCausalMetadata: () => ({ continuation }),
  });
  const secondId = conv.session.sessionManager.appendMessage(second);
  const reconciliation = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.deepEqual(reconciliation.assistantUtterances.map((item) => [item.piMessageId, item.text]), [[firstId, 'First'], [secondId, 'Second']]);
  assert.equal(reconciliation.assistantUtterances[0].continuation, null);
  assert.equal(reconciliation.assistantUtterances[1].continuation.subagentRunKey, 'top:run-1');
  const outward = extractMessageProvenance(conv.session.sessionManager.getBranch()).filter((item) => item.messageKind === 'assistant_outward');
  assert.deepEqual(outward.map((item) => item.piMessageId), [firstId, secondId]);
  assert.equal(outward[0].continuation, null);
  assert.equal(outward[1].continuation.subagentRunId, 'run-1');
});

test('non-outward assistant does not consume forward causal metadata', () => {
  const conv = conversation(); let consumed = 0;
  handleProvenanceEvent(conv, { type: 'agent_start' });
  const empty = assistantMessage('');
  handleProvenanceEvent(conv, { type: 'message_end', message: empty }, { consumeCausalMetadata: () => { consumed += 1; return {}; } });
  conv.session.sessionManager.appendMessage(empty);
  const reconciliation = handleProvenanceEvent(conv, { type: 'agent_settled' });
  assert.equal(consumed, 0);
  assert.deepEqual(reconciliation.assistantUtterances, []);
});

