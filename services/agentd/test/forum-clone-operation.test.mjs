import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  cloneConversationAtLeaf,
  ForumCloneConflictError,
  ForumCloneLedger,
  filterForumCloneSessionDiscovery,
  readForumCloneSnapshot,
} from '../src/forum-clone-operation.mjs';
import { ForumForkLedger } from '../src/forum-fork-operation.mjs';
import { SessionOperationCoordinator, withForumMutableSessionOperation } from '../src/session-operation.mjs';

function message(role, text, timestamp) {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp,
    ...(role === 'assistant'
      ? {
          stopReason: 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          api: 'x',
          provider: 'x',
          model: 'x',
        }
      : {}),
  };
}

function creatingRecord(manager, operationId) {
  const request = {
    source_session_id: manager.getSessionId(),
    source_session_path: manager.getSessionFile(),
    expected_leaf_id: manager.getLeafId(),
  };
  return {
    operation_id: operationId,
    operation_kind: 'clone',
    request_hash: createHash('sha256')
      .update(JSON.stringify({ operation_kind: 'clone', ...request }))
      .digest('hex'),
    state: 'creating',
    ...request,
    created_at: new Date().toISOString(),
  };
}

async function fixture(prefix = 'forum-clone-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessions = path.join(root, 'sessions');
  const manager = SessionManager.create(root, sessions);
  manager.appendMessage(message('user', 'first', 1));
  manager.appendMessage(message('assistant', 'answer', 2));
  manager.appendCustomEntry('compaction', { summary: 'preserve current compacted branch' });
  return {
    root,
    sessions,
    manager,
    conv: { piSessionId: manager.getSessionId(), sessionPath: manager.getSessionFile(), cwd: root },
  };
}

test('duplicates the exact current native branch without changing parent bytes and retries idempotently', async () => {
  const { root, manager, conv } = await fixture();
  try {
    const ledger = new ForumCloneLedger(path.join(root, 'ledger'));
    const parentBytes = await readFile(conv.sessionPath);
    const sourceBranchIds = manager.getBranch().map((entry) => entry.id);
    const snapshot = readForumCloneSnapshot(conv);
    assert.equal(snapshot.leaf_entry_id, sourceBranchIds.at(-1));
    assert.deepEqual(snapshot.active_entry_ids, sourceBranchIds);

    const input = { operation_id: 'clone-one', expected_leaf_id: snapshot.leaf_entry_id };
    const result = await cloneConversationAtLeaf({ conv, input, ledger });
    assert.equal(result.already_completed, false);
    assert.deepEqual(await readFile(conv.sessionPath), parentBytes);
    assert.deepEqual(result.active_entry_ids.slice(0, sourceBranchIds.length), sourceBranchIds);
    const child = SessionManager.open(result.child_session_path, undefined, root);
    assert.equal(child.getHeader().parentSession, conv.sessionPath);
    assert.equal(child.getBranch().some((entry) => entry.customType === 'compaction'), true);
    assert.equal(
      child.getBranch().some((entry) => entry.customType === 'monika.lineage' && entry.data?.kind === 'clone'),
      true,
    );

    const retry = await cloneConversationAtLeaf({ conv, input, ledger });
    assert.equal(retry.already_completed, true);
    assert.equal(retry.child_session_id, result.child_session_id);
    assert.equal(await ledger.acknowledge('clone-one', result.child_session_id), true);
    assert.equal(await ledger.acknowledge('clone-one', result.child_session_id), true);
    assert.equal((await ledger.pendingChildSessionIds()).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('matches detached SessionManager.createBranchedSession(currentLeaf) native semantics', async () => {
  const { root, manager, conv } = await fixture();
  try {
    const leaf = manager.getLeafId();
    const parityPath = manager.createBranchedSession(leaf);
    const nativeIds = SessionManager.open(parityPath, undefined, root)
      .getBranch()
      .map((entry) => entry.id);
    const result = await cloneConversationAtLeaf({
      conv,
      input: { operation_id: 'clone-parity', expected_leaf_id: leaf },
      ledger: new ForumCloneLedger(path.join(root, 'ledger')),
    });
    assert.deepEqual(result.active_entry_ids.slice(0, nativeIds.length), nativeIds);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a stale leaf before creating a child', async () => {
  const { root, sessions, manager, conv } = await fixture();
  try {
    const staleLeaf = manager.getLeafId();
    manager.appendMessage(message('user', 'changed', 3));
    const before = await readdir(sessions);
    await assert.rejects(
      cloneConversationAtLeaf({
        conv,
        input: { operation_id: 'clone-stale', expected_leaf_id: staleLeaf },
        ledger: new ForumCloneLedger(path.join(root, 'ledger')),
      }),
      (error) => error instanceof ForumCloneConflictError && error.code === 'stale_leaf',
    );
    assert.deepEqual(await readdir(sessions), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('turns a failed clone with a persisted child into manual recovery before stale-leaf validation', async () => {
  const { root, manager, conv } = await fixture();
  try {
    const record = creatingRecord(manager, 'clone-failed-after-child');
    const childPath = manager.createBranchedSession(record.expected_leaf_id);
    const childSessionId = SessionManager.open(childPath, undefined, root).getSessionId();
    const ledger = new ForumCloneLedger(path.join(root, 'ledger'));
    await ledger.write({
      ...record,
      state: 'failed',
      child_session_id: childSessionId,
      child_session_path: childPath,
      error_code: 'clone_failed',
      error_message: 'failure after child persistence',
      failed_at: new Date().toISOString(),
    });
    manager.appendMessage(message('user', 'parent changed after failure', 3));

    await assert.rejects(
      cloneConversationAtLeaf({
        conv,
        input: { operation_id: record.operation_id, expected_leaf_id: record.expected_leaf_id },
        ledger,
      }),
      (error) => error instanceof ForumCloneConflictError && error.code === 'clone_manual_recovery',
    );
    const recovered = await ledger.read(record.operation_id);
    assert.equal(recovered.state, 'manual_recovery');
    assert.equal(recovered.error_code, 'clone_manual_recovery');
    assert.equal(recovered.child_session_id, childSessionId);
    assert.equal(recovered.child_session_path, childPath);
    assert.equal(await ledger.hasSourceFence(record.source_session_id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adopts only an exact operation-marked child after an ambiguous response', async () => {
  const { root, manager, conv } = await fixture();
  try {
    const record = creatingRecord(manager, 'clone-marked');
    const childPath = manager.createBranchedSession(manager.getLeafId());
    SessionManager.open(childPath, undefined, root).appendCustomEntry('monika.forum.clone.operation', {
      operationId: record.operation_id,
      leafEntryId: record.expected_leaf_id,
    });
    const ledger = new ForumCloneLedger(path.join(root, 'ledger'));
    await ledger.write(record);
    const result = await cloneConversationAtLeaf({
      conv,
      input: { operation_id: record.operation_id, expected_leaf_id: record.expected_leaf_id },
      ledger,
    });
    assert.equal(result.child_session_path, childPath);
    assert.equal((await ledger.read(record.operation_id)).state, 'canonical_completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('turns an unmarked ambiguous child into durable manual recovery and quarantines candidates', async () => {
  const { root, sessions, manager, conv } = await fixture();
  try {
    const record = creatingRecord(manager, 'clone-ambiguous');
    const candidatePath = manager.createBranchedSession(manager.getLeafId());
    const candidateBytes = await readFile(candidatePath);
    const ledger = new ForumCloneLedger(path.join(root, 'ledger'));
    await ledger.write(record);

    await assert.rejects(
      cloneConversationAtLeaf({
        conv,
        input: { operation_id: record.operation_id, expected_leaf_id: record.expected_leaf_id },
        ledger,
      }),
      (error) => error instanceof ForumCloneConflictError && error.code === 'clone_manual_recovery',
    );
    assert.deepEqual(await readFile(candidatePath), candidateBytes);
    const recovered = await ledger.read(record.operation_id);
    assert.equal(recovered.state, 'manual_recovery');
    assert.equal(await ledger.hasSourceFence(record.source_session_id), true);
    const candidate = SessionManager.open(candidatePath, undefined, root);
    assert.deepEqual(
      filterForumCloneSessionDiscovery(
        [
          {
            id: candidate.getSessionId(),
            path: candidatePath,
            parent_session_path: conv.sessionPath,
            timestamp: candidate.getHeader().timestamp,
          },
          {
            id: 'unrelated',
            path: path.join(sessions, 'unrelated.jsonl'),
            parent_session_path: '/other/parent.jsonl',
            timestamp: new Date().toISOString(),
          },
        ],
        [recovered],
      ).map((session) => session.id),
      ['unrelated'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clone and fork ledgers mutually fence canonical mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forum-clone-fence-'));
  try {
    const forkLedger = new ForumForkLedger(path.join(root, 'fork-ledger'));
    const cloneLedger = new ForumCloneLedger(path.join(root, 'clone-ledger'));
    await cloneLedger.write({
      operation_id: 'clone-fence',
      state: 'canonical_completed',
      source_session_id: 'parent',
      child_session_id: 'child',
    });
    let mutated = false;
    await assert.rejects(
      withForumMutableSessionOperation(
        new SessionOperationCoordinator(),
        [forkLedger, cloneLedger],
        'parent',
        async () => {
          mutated = true;
        },
      ),
      (error) => error.code === 'fork_in_progress',
    );
    assert.equal(mutated, false);
    assert.equal(await cloneLedger.hasSourceFenceExcept('parent', 'clone-fence'), false);
    await forkLedger.write({ operation_id: 'fork-fence', state: 'creating', source_session_id: 'parent' });
    assert.equal(await forkLedger.hasSourceFenceExcept('parent', 'different-operation'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
