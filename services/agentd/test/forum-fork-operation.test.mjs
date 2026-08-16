import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  assertForumForkSourceMutable,
  ForumForkConflictError,
  ForumForkLedger,
  filterForumForkSessionDiscovery,
  forkConversationBeforeUser,
} from '../src/forum-fork-operation.mjs';

function message(role, text, timestamp) {
  return { role, content: [{ type: 'text', text }], timestamp, ...(role === 'assistant' ? { stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: 'x', provider: 'x', model: 'x' } : {}) };
}

function requestRecord(manager, operationId, boundaryEntryId) {
  const request = {
    source_session_id: manager.getSessionId(),
    source_session_path: manager.getSessionFile(),
    expected_leaf_id: manager.getLeafId(),
    boundary_entry_id: boundaryEntryId,
  };
  return {
    operation_id: operationId,
    request_hash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    state: 'creating',
    ...request,
    created_at: new Date().toISOString(),
  };
}

test('forks before a stable user boundary without changing parent bytes and retries idempotently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const sessions = path.join(root, 'sessions');
    const manager = SessionManager.create(root, sessions);
    manager.appendMessage(message('user', 'first', 1));
    manager.appendMessage(message('assistant', 'first answer', 2));
    const boundary = manager.appendMessage(message('user', 'opening to edit', 3));
    manager.appendMessage(message('assistant', 'inherited answer', 4));
    const sourcePath = manager.getSessionFile();
    const sourceBytes = await readFile(sourcePath);
    const conv = { piSessionId: manager.getSessionId(), sessionPath: sourcePath, cwd: root };
    const ledger = new ForumForkLedger(path.join(root, 'ledger'));
    const input = { operation_id: 'fork-one', expected_leaf_id: manager.getLeafId(), boundary_entry_id: boundary };

    const result = await forkConversationBeforeUser({ conv, input, ledger });
    assert.equal(result.already_completed, false);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    const child = SessionManager.open(result.child_session_path);
    assert.equal(child.getBranch().some((entry) => entry.id === boundary), false);
    assert.equal(child.getBranch().filter((entry) => entry.type === 'message').at(-1).message.content[0].text, 'first answer');
    assert.equal((await ledger.pendingChildSessionIds()).has(result.child_session_id), true);

    const retry = await forkConversationBeforeUser({ conv, input, ledger });
    assert.equal(retry.already_completed, true);
    assert.equal(retry.child_session_id, result.child_session_id);
    assert.equal(await ledger.acknowledge('fork-one', result.child_session_id), true);
    assert.equal(await ledger.acknowledge('fork-one', result.child_session_id), true);
    assert.equal((await ledger.pendingChildSessionIds()).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quarantines and source-fences failed operations that already own a child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const ledger = new ForumForkLedger(path.join(root, 'ledger'));
    await ledger.write({
      operation_id: 'fork-failed-child',
      state: 'failed',
      source_session_id: 'parent-session',
      child_session_id: 'child-session',
      child_session_path: '/sessions/child.jsonl',
    });
    assert.equal((await ledger.pendingChildSessionIds()).has('child-session'), true);
    assert.equal(await ledger.hasSourceFence('parent-session'), true);
    await assert.rejects(
      assertForumForkSourceMutable(ledger, 'parent-session'),
      (error) => error instanceof ForumForkConflictError && error.code === 'fork_in_progress',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not heuristically adopt an unmarked recent child after a creating-state crash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const sessions = path.join(root, 'sessions');
    const manager = SessionManager.create(root, sessions);
    manager.appendMessage(message('user', 'first', 1));
    const inheritedAssistant = manager.appendMessage(message('assistant', 'first answer', 2));
    const boundary = manager.appendMessage(message('user', 'opening', 3));
    manager.appendMessage(message('assistant', 'answer', 4));
    const record = requestRecord(manager, 'fork-crashed', boundary);
    const unrelatedPath = manager.createBranchedSession(inheritedAssistant);
    const unrelatedBefore = await readFile(unrelatedPath);
    const ledger = new ForumForkLedger(path.join(root, 'ledger'));
    await ledger.write(record);
    const sessionNamesBefore = await readdir(sessions);

    await assert.rejects(
      forkConversationBeforeUser({
        conv: { piSessionId: record.source_session_id, sessionPath: record.source_session_path, cwd: root },
        input: { operation_id: record.operation_id, expected_leaf_id: record.expected_leaf_id, boundary_entry_id: boundary },
        ledger,
      }),
      (error) => error instanceof ForumForkConflictError && error.code === 'fork_manual_recovery',
    );

    assert.deepEqual(await readFile(unrelatedPath), unrelatedBefore);
    assert.deepEqual(await readdir(sessions), sessionNamesBefore);
    const recovered = await ledger.read(record.operation_id);
    assert.equal(recovered.state, 'manual_recovery');
    assert.deepEqual(recovered.candidate_scope, {
      session_dir: sessions,
      parent_session_path: record.source_session_path,
      not_before: record.created_at,
      boundary_entry_id: boundary,
    });
    const plausible = SessionManager.open(unrelatedPath);
    const discovered = filterForumForkSessionDiscovery(
      [
        {
          id: plausible.getSessionId(),
          path: unrelatedPath,
          parent_session_path: record.source_session_path,
          timestamp: plausible.getHeader().timestamp,
        },
        {
          id: 'other-session',
          path: path.join(sessions, 'other.jsonl'),
          parent_session_path: '/sessions/other-parent.jsonl',
          timestamp: new Date().toISOString(),
        },
      ],
      [recovered],
    );
    assert.deepEqual(discovered.map((session) => session.id), ['other-session']);
    assert.equal(await ledger.hasSourceFence(record.source_session_id), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers only the exact operation-marked child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const sessions = path.join(root, 'sessions');
    const manager = SessionManager.create(root, sessions);
    manager.appendMessage(message('user', 'first', 1));
    const inheritedAssistant = manager.appendMessage(message('assistant', 'first answer', 2));
    const boundary = manager.appendMessage(message('user', 'opening', 3));
    manager.appendMessage(message('assistant', 'answer', 4));
    const record = requestRecord(manager, 'fork-marked', boundary);
    const markedPath = manager.createBranchedSession(inheritedAssistant);
    const marked = SessionManager.open(markedPath);
    marked.appendCustomEntry('monika.forum.fork.operation', { operationId: 'fork-marked', boundaryEntryId: boundary });
    const ledger = new ForumForkLedger(path.join(root, 'ledger'));
    await ledger.write(record);

    const result = await forkConversationBeforeUser({
      conv: { piSessionId: record.source_session_id, sessionPath: record.source_session_path, cwd: root },
      input: { operation_id: record.operation_id, expected_leaf_id: record.expected_leaf_id, boundary_entry_id: boundary },
      ledger,
    });
    assert.equal(result.child_session_path, markedPath);
    assert.equal((await ledger.read(record.operation_id)).state, 'canonical_completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('fails closed when the durable fork ledger is unreadable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const ledgerRoot = path.join(root, 'ledger');
    await mkdir(ledgerRoot, { recursive: true });
    await writeFile(path.join(ledgerRoot, 'broken.json'), '{');
    const ledger = new ForumForkLedger(ledgerRoot);
    await assert.rejects(ledger.records(), SyntaxError);
    await assert.rejects(ledger.hasSourceFence('parent-session'), SyntaxError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects boundaries without a completed inherited assistant response', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-fork-'));
  try {
    const manager = SessionManager.create(root, path.join(root, 'sessions'));
    const boundary = manager.appendMessage(message('user', 'unanswered', 1));
    const failed = message('assistant', '', 2);
    failed.stopReason = 'error';
    manager.appendMessage(failed);
    await assert.rejects(
      forkConversationBeforeUser({
        conv: { piSessionId: manager.getSessionId(), sessionPath: manager.getSessionFile(), cwd: root },
        input: { operation_id: 'fork-two', expected_leaf_id: manager.getLeafId(), boundary_entry_id: boundary },
        ledger: new ForumForkLedger(path.join(root, 'ledger')),
      }),
      (error) => error instanceof ForumForkConflictError && error.code === 'missing_assistant_response',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
