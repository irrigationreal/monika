import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent';
import { readDispatchFence } from './dispatch-fence.mjs';
import { ForumForkLedger, filterForumForkSessionDiscovery } from './forum-fork-operation.mjs';

export class ForumCloneConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ForumCloneConflictError';
    this.code = code;
    this.details = details;
  }
}

export class ForumCloneLedger extends ForumForkLedger {}

export function readForumCloneSnapshot(conv) {
  if (!conv.sessionPath) throw new ForumCloneConflictError('legacy_session', 'Persisted Pi session is required');
  const manager = SessionManager.open(conv.sessionPath, undefined, conv.cwd);
  const header = manager.getHeader();
  if (!header || header.version !== CURRENT_SESSION_VERSION)
    throw new ForumCloneConflictError('legacy_session', 'Only the current Pi session format can be cloned');
  return {
    leaf_entry_id: manager.getLeafId(),
    active_entry_ids: manager.getBranch().map((entry) => entry.id),
  };
}

function stableRequest(input) {
  return JSON.stringify({
    operation_kind: 'clone',
    source_session_id: input.source_session_id,
    source_session_path: input.source_session_path,
    expected_leaf_id: input.expected_leaf_id,
  });
}

function validateRequest(input) {
  const operationId = typeof input?.operation_id === 'string' ? input.operation_id.trim() : '';
  const expectedLeafId = typeof input?.expected_leaf_id === 'string' ? input.expected_leaf_id.trim() : '';
  if (!operationId) throw new TypeError('operation_id is required');
  if (!expectedLeafId) throw new TypeError('expected_leaf_id is required');
  return { operationId, expectedLeafId };
}

/**
 * Pi's native clone is runtime.fork(currentLeaf, { position: 'at' }). Agentd
 * must not replace the loaded parent runtime, so this applies the same native
 * SessionManager extraction to a detached manager.
 */
export async function cloneConversationAtLeaf({ conv, input, ledger }) {
  const { operationId, expectedLeafId } = validateRequest(input);
  const request = {
    source_session_id: conv.piSessionId,
    source_session_path: conv.sessionPath,
    expected_leaf_id: expectedLeafId,
  };
  const requestHash = createHash('sha256').update(stableRequest(request)).digest('hex');
  const existing = await ledger.read(operationId);
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new ForumCloneConflictError('operation_mismatch', 'operation_id is already used by another clone request');
    if (existing.state === 'canonical_completed' || existing.state === 'acknowledged')
      return { ...existing.result, already_completed: true };
    if (existing.state === 'manual_recovery')
      throw new ForumCloneConflictError('clone_manual_recovery', existing.error_message ?? 'Clone requires manual recovery');
    if (existing.state === 'failed' && (existing.child_session_id || existing.child_session_path)) {
      const message = existing.error_message ?? 'Clone failed after child persistence and requires manual recovery';
      await ledger.write({ ...existing, state: 'manual_recovery', error_code: 'clone_manual_recovery', error_message: message });
      throw new ForumCloneConflictError('clone_manual_recovery', message);
    }
    if (existing.state === 'failed')
      throw new ForumCloneConflictError(existing.error_code ?? 'clone_failed', existing.error_message ?? 'Clone failed');
  }

  if (!conv.sessionPath) throw new ForumCloneConflictError('legacy_session', 'Persisted Pi session is required');
  const sourceBefore = await readFile(conv.sessionPath);
  const manager = SessionManager.open(conv.sessionPath, undefined, conv.cwd);
  const snapshot = readForumCloneSnapshot(conv);
  if (!snapshot.leaf_entry_id)
    throw new ForumCloneConflictError('empty_session', 'A conversation with no current entry cannot be cloned');
  if (snapshot.leaf_entry_id !== expectedLeafId)
    throw new ForumCloneConflictError('stale_leaf', 'Conversation leaf changed before clone', {
      expected_leaf_id: expectedLeafId,
      actual_leaf_id: snapshot.leaf_entry_id,
    });

  const createdAt = existing?.created_at ?? new Date().toISOString();
  const candidateScope = existing?.candidate_scope ?? {
    session_dir: manager.getSessionDir(),
    parent_session_path: conv.sessionPath,
    not_before: createdAt,
    boundary_entry_id: expectedLeafId,
  };
  const durableRequest = {
    operation_id: operationId,
    operation_kind: 'clone',
    request_hash: requestHash,
    ...request,
    created_at: createdAt,
    candidate_scope: candidateScope,
  };
  await ledger.write({ ...durableRequest, state: 'creating' });
  let childPath = existing?.child_session_path ?? null;
  let childSessionId = existing?.child_session_id ?? null;
  try {
    if (!childPath && existing?.state === 'creating') {
      const candidates = await (await import('node:fs/promises')).readdir(manager.getSessionDir());
      const exact = [];
      for (const name of candidates.filter((candidate) => candidate.endsWith('.jsonl'))) {
        const candidatePath = path.join(manager.getSessionDir(), name);
        if (candidatePath === conv.sessionPath) continue;
        try {
          const candidate = SessionManager.open(candidatePath, undefined, conv.cwd);
          const branch = candidate.getBranch();
          const marked = branch.some((entry) =>
            entry.type === 'custom' && entry.customType === 'monika.forum.clone.operation' &&
            entry.data?.operationId === operationId && entry.data?.leafEntryId === expectedLeafId
          );
          if (candidate.getHeader()?.parentSession === conv.sessionPath &&
              branch.some((entry) => entry.id === expectedLeafId) && marked) exact.push(candidatePath);
        } catch {}
      }
      if (exact.length === 1) childPath = exact[0];
      else {
        const message = exact.length > 1
          ? 'Multiple operation-marked clone children require manual recovery'
          : 'Clone creation outcome is unknown and no operation-marked child can be adopted';
        await ledger.write({ ...durableRequest, state: 'manual_recovery', error_code: 'clone_manual_recovery', error_message: message, failed_at: new Date().toISOString() });
        throw new ForumCloneConflictError('clone_manual_recovery', message);
      }
    }
    if (!childPath) {
      childPath = manager.createBranchedSession(expectedLeafId);
      if (!childPath) throw new Error('Pi did not persist the cloned session');
      SessionManager.open(childPath, undefined, conv.cwd)
        .appendCustomEntry('monika.forum.clone.operation', { operationId, leafEntryId: expectedLeafId });
    }
    let child = SessionManager.open(childPath, undefined, conv.cwd);
    childSessionId = child.getSessionId();
    await ledger.write({ ...durableRequest, state: 'child_created', child_session_id: childSessionId, child_session_path: childPath });
    const inheritedGeneration = readDispatchFence(child.getBranch()).generation;
    if (!child.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'monika.lineage' && entry.data?.operationId === operationId))
      child.appendCustomEntry('monika.lineage', {
        kind: 'clone', source: 'forum', parentSession: conv.sessionPath,
        operationId, leafEntryId: expectedLeafId, createdAt: new Date().toISOString(),
      });
    if (!child.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'monika.forum.clone.pending' && entry.data?.operationId === operationId))
      child.appendCustomEntry('monika.forum.clone.pending', { operationId, leafEntryId: expectedLeafId });
    child = SessionManager.open(childPath, undefined, conv.cwd);
    if (!(await readFile(conv.sessionPath)).equals(sourceBefore))
      throw new Error('Parent session changed during detached clone');
    const result = {
      operation_id: operationId,
      child_session_id: child.getSessionId(),
      child_session_path: childPath,
      parent_session_id: conv.piSessionId,
      cloned_leaf_entry_id: expectedLeafId,
      inherited_generation: inheritedGeneration,
      active_entry_ids: child.getBranch().map((entry) => entry.id),
      already_completed: false,
    };
    await ledger.write({ ...durableRequest, state: 'canonical_completed', child_session_id: result.child_session_id, child_session_path: childPath, completed_at: new Date().toISOString(), result });
    return result;
  } catch (error) {
    if (error instanceof ForumCloneConflictError && error.code === 'clone_manual_recovery') throw error;
    await ledger.write({ ...durableRequest, state: 'failed', child_session_id: childSessionId, child_session_path: childPath, error_code: 'clone_failed', error_message: error instanceof Error ? error.message : String(error), failed_at: new Date().toISOString() });
    throw error;
  }
}

export function filterForumCloneSessionDiscovery(sessions, records) {
  return filterForumForkSessionDiscovery(sessions, records);
}
