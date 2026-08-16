import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertForumCreationRequest,
  ForumCreationConflictError,
  ForumCreationLedger,
  forumCreationRequestHash,
  hasForumCreationAnchor,
  reconcileForumCreation,
  validateForumCreationId,
} from '../src/forum-creation-operation.mjs';

test('creation ledger persists intended canonical identity atomically and reopens it by operation id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-forum-create-'));
  try {
    const ledger = new ForumCreationLedger(path.join(root, 'ledger'));
    const sessionPath = path.join(root, 'sessions', 'one.jsonl');
    await mkdir(path.dirname(sessionPath));
    const requestHash = forumCreationRequestHash({ cwd: '/workspace', model: 'provider/model' });
    await ledger.write({ creation_id: 'dispatch-1', request_hash: requestHash, state: 'creating', session_id: 'session-1', session_path: sessionPath });
    const first = await ledger.read('dispatch-1');
    assert.deepEqual(first, {
      creation_id: 'dispatch-1', request_hash: requestHash, state: 'creating', session_id: 'session-1', session_path: sessionPath,
    });
    assertForumCreationRequest(first, requestHash);
    await ledger.write({ ...first, state: 'anchored' });
    assert.equal((await ledger.read('dispatch-1')).session_path, sessionPath);
    assert.equal((await readFile(path.join(root, 'ledger', 'dispatch-1.json'), 'utf8')).endsWith('\n'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a creating record requires exact operation-marked completed canonical evidence', () => {
  const header = JSON.stringify({ type: 'session', id: 'session-1' });
  const marked = JSON.stringify({ type: 'custom', customType: 'monika.forum.session', data: { creation_id: 'dispatch-1' } });
  const completed = JSON.stringify({ type: 'custom', customType: 'monika.forum.creation.completed', data: { creation_id: 'dispatch-1' } });
  assert.equal(hasForumCreationAnchor(`${header}\n${marked}\n${completed}\n`, 'dispatch-1'), true);
  assert.equal(hasForumCreationAnchor(`${header}\n${marked}\n`, 'dispatch-1'), false);
  assert.equal(hasForumCreationAnchor(`${header}\n${marked}\n${completed}\n`, 'dispatch-2'), false);
  assert.equal(hasForumCreationAnchor(`${header}\n`, 'dispatch-1'), false);
});

test('lost-response retry promotes only the exact operation-marked intended session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-forum-create-'));
  try {
    const ledger = new ForumCreationLedger(path.join(root, 'ledger'));
    const sessionPath = path.join(root, 'sessions', 'one.jsonl');
    await mkdir(path.dirname(sessionPath));
    const requestHash = forumCreationRequestHash({ cwd: '/workspace' });
    const record = { creation_id: 'dispatch-1', request_hash: requestHash, state: 'creating', session_id: 'session-1', session_path: sessionPath };
    await ledger.write(record);
    const canonical = {
      id: 'session-1', path: sessionPath,
      raw: `${JSON.stringify({ type: 'session', id: 'session-1' })}\n${JSON.stringify({ type: 'custom', customType: 'monika.forum.session', data: { creation_id: 'dispatch-1' } })}\n${JSON.stringify({ type: 'custom', customType: 'monika.forum.creation.completed', data: { creation_id: 'dispatch-1' } })}\n`,
    };
    const reconciled = await reconcileForumCreation({
      ledger, creationId: 'dispatch-1', requestHash, resolveCanonical: async () => canonical,
    });
    assert.equal(reconciled.record.state, 'anchored');
    assert.equal((await ledger.read('dispatch-1')).session_id, 'session-1');
    const retry = await reconcileForumCreation({
      ledger, creationId: 'dispatch-1', requestHash, resolveCanonical: async () => canonical,
    });
    assert.equal(retry.record.session_path, sessionPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creating crash windows without exact canonical evidence fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-forum-create-'));
  try {
    const ledger = new ForumCreationLedger(path.join(root, 'ledger'));
    const sessionPath = path.join(root, 'sessions', 'one.jsonl');
    const requestHash = forumCreationRequestHash({ cwd: '/workspace' });
    await ledger.write({ creation_id: 'dispatch-1', request_hash: requestHash, state: 'creating', session_id: 'session-1', session_path: sessionPath });
    await assert.rejects(
      reconcileForumCreation({ ledger, creationId: 'dispatch-1', requestHash, resolveCanonical: async () => null }),
      (error) => error instanceof ForumCreationConflictError && error.code === 'creation_manual_recovery',
    );
    assert.equal((await ledger.read('dispatch-1')).state, 'creating');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creation ids, paths, and request reuse fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-forum-create-'));
  try {
    const ledger = new ForumCreationLedger(path.join(root, 'ledger'));
    assert.throws(() => validateForumCreationId('../escape'), /creation_id/);
    await assert.rejects(
      ledger.write({ creation_id: 'safe', request_hash: 'x', state: 'creating', session_id: 'id', session_path: 'relative.jsonl' }),
      /absolute intended session identity/,
    );
    assert.throws(
      () => assertForumCreationRequest({ request_hash: 'first' }, 'second'),
      (error) => error instanceof ForumCreationConflictError && error.code === 'creation_mismatch',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
