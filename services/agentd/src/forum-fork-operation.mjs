import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent';
import { readDispatchFence } from './dispatch-fence.mjs';

export class ForumForkConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ForumForkConflictError';
    this.code = code;
    this.details = details;
  }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n');
}

function stableRequest(input) {
  return JSON.stringify({
    source_session_id: input.source_session_id,
    source_session_path: input.source_session_path,
    expected_leaf_id: input.expected_leaf_id,
    boundary_entry_id: input.boundary_entry_id,
  });
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export class ForumForkLedger {
  constructor(root) {
    this.root = path.resolve(root);
  }

  file(operationId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new TypeError('invalid operation_id');
    return path.join(this.root, `${operationId}.json`);
  }

  async read(operationId) {
    try { return JSON.parse(await readFile(this.file(operationId), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  async write(record) { await atomicJson(this.file(record.operation_id), record); }

  async records() {
    let names;
    try { names = await (await import('node:fs/promises')).readdir(this.root); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      records.push(JSON.parse(await readFile(path.join(this.root, name), 'utf8')));
    }
    return records;
  }

  async pendingChildSessionIds() {
    return new Set((await this.records()).filter((record) => record.state !== 'acknowledged' && record.child_session_id).map((record) => record.child_session_id));
  }

  async hasSourceFence(sessionId) {
    return (await this.records()).some((record) =>
      record.source_session_id === sessionId &&
      (record.state === 'creating' || record.state === 'manual_recovery' || record.state === 'child_created' || record.state === 'canonical_completed' || (record.state === 'failed' && record.child_session_id))
    );
  }

  async acknowledge(operationId, childSessionId) {
    const record = await this.read(operationId);
    if (!record || record.child_session_id !== childSessionId) return false;
    if (record.state === 'acknowledged') return true;
    if (record.state !== 'canonical_completed') return false;
    await this.write({ ...record, state: 'acknowledged', acknowledged_at: new Date().toISOString() });
    return true;
  }
}

export async function assertForumForkSourceMutable(ledger, sessionId) {
  if (await ledger.hasSourceFence(sessionId)) {
    throw new ForumForkConflictError('fork_in_progress', 'Canonical fork materialization is unresolved');
  }
}

/**
 * Hide every session that could be an unresolved forum-fork child. Manual
 * recovery deliberately uses only durable scope evidence; it never opens,
 * marks, adopts, or otherwise modifies a candidate session.
 */
export function filterForumForkSessionDiscovery(sessions, records) {
  const explicitChildIds = new Set(
    records
      .filter((record) => record.state !== 'acknowledged' && record.child_session_id)
      .map((record) => record.child_session_id),
  );
  const ambiguousScopes = records
    .filter((record) => record.state === 'creating' || record.state === 'manual_recovery')
    .map((record) => ({
      sessionDir: record.candidate_scope?.session_dir ?? (record.source_session_path ? path.dirname(record.source_session_path) : null),
      parentPath: record.candidate_scope?.parent_session_path ?? record.source_session_path ?? null,
      notBefore: record.candidate_scope?.not_before ?? record.created_at ?? null,
      boundaryEntryId: record.candidate_scope?.boundary_entry_id ?? record.boundary_entry_id ?? null,
    }));

  return sessions.filter((session) => {
    if (explicitChildIds.has(session.id)) return false;
    return !ambiguousScopes.some((scope) => {
      if (!scope.sessionDir || !scope.parentPath || !scope.boundaryEntryId) return false;
      if (path.resolve(path.dirname(session.path)) !== path.resolve(scope.sessionDir)) return false;
      if (!session.parent_session_path || path.resolve(session.parent_session_path) !== path.resolve(scope.parentPath)) return false;
      const lowerBound = Date.parse(scope.notBefore ?? '');
      const candidateTime = Date.parse(session.timestamp ?? '');
      // Missing or malformed timestamps widen quarantine rather than making an
      // ambiguous child visible to generic discovery.
      return !Number.isFinite(lowerBound) || !Number.isFinite(candidateTime) || candidateTime >= lowerBound - 1000;
    });
  });
}

function validateRequest(input) {
  const operationId = typeof input?.operation_id === 'string' ? input.operation_id.trim() : '';
  const expectedLeafId = typeof input?.expected_leaf_id === 'string' ? input.expected_leaf_id.trim() : '';
  const boundaryEntryId = typeof input?.boundary_entry_id === 'string' ? input.boundary_entry_id.trim() : '';
  if (!operationId) throw new TypeError('operation_id is required');
  if (!expectedLeafId) throw new TypeError('expected_leaf_id is required');
  if (!boundaryEntryId) throw new TypeError('boundary_entry_id is required');
  return { operationId, expectedLeafId, boundaryEntryId };
}

/**
 * Copy the exact active path before a canonical user message without ever
 * replacing the loaded parent runtime. SessionManager's branch extraction is
 * the same primitive used by Pi's before-user fork flow; the detached manager
 * is discarded immediately after the child is opened and marked.
 */
export async function forkConversationBeforeUser({ conv, input, ledger }) {
  const { operationId, expectedLeafId, boundaryEntryId } = validateRequest(input);
  const request = {
    source_session_id: conv.piSessionId,
    source_session_path: conv.sessionPath,
    expected_leaf_id: expectedLeafId,
    boundary_entry_id: boundaryEntryId,
  };
  const requestHash = createHash('sha256').update(stableRequest(request)).digest('hex');
  const existing = await ledger.read(operationId);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new ForumForkConflictError('operation_mismatch', 'operation_id is already used by another fork request');
    if (existing.state === 'canonical_completed' || existing.state === 'acknowledged') return { ...existing.result, already_completed: true };
    if (existing.state === 'manual_recovery')
      throw new ForumForkConflictError('fork_manual_recovery', existing.error_message ?? 'Fork requires manual recovery');
    if (existing.state === 'failed' && !existing.child_session_path) throw new ForumForkConflictError(existing.error_code ?? 'fork_failed', existing.error_message ?? 'Fork failed');
  }

  if (!conv.sessionPath) throw new ForumForkConflictError('legacy_session', 'Persisted Pi session is required');
  const sourceBefore = await readFile(conv.sessionPath);
  const manager = SessionManager.open(conv.sessionPath, undefined, conv.cwd);
  const header = manager.getHeader();
  if (!header || header.version !== CURRENT_SESSION_VERSION) {
    throw new ForumForkConflictError('legacy_session', 'Only the current Pi session format can be forked');
  }
  const actualLeafId = manager.getLeafId();
  if (actualLeafId !== expectedLeafId) throw new ForumForkConflictError('stale_leaf', 'Conversation leaf changed before fork', { expected_leaf_id: expectedLeafId, actual_leaf_id: actualLeafId });
  const branch = manager.getBranch();
  const boundaryIndex = branch.findIndex((entry) => entry.id === boundaryEntryId);
  const boundary = branch[boundaryIndex];
  if (!boundary || boundary.type !== 'message' || boundary.message?.role !== 'user') {
    throw new ForumForkConflictError('invalid_boundary', 'Fork boundary must be a canonical user message on the active branch');
  }
  const response = branch.slice(boundaryIndex + 1).find((entry) => entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant'));
  if (!response || response.message?.role !== 'assistant' || !textContent(response.message.content).trim() || !['stop', 'length'].includes(response.message.stopReason)) {
    throw new ForumForkConflictError('missing_assistant_response', 'Fork boundary has no inherited completed assistant response');
  }

  const createdAt = existing?.created_at ?? new Date().toISOString();
  const candidateScope = existing?.candidate_scope ?? {
    session_dir: manager.getSessionDir(),
    parent_session_path: conv.sessionPath,
    not_before: createdAt,
    boundary_entry_id: boundaryEntryId,
  };
  const durableRequest = {
    operation_id: operationId,
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
      for (const name of candidates.filter((name) => name.endsWith('.jsonl'))) {
        const candidatePath = path.join(manager.getSessionDir(), name);
        if (candidatePath === conv.sessionPath) continue;
        try {
          const candidate = SessionManager.open(candidatePath, undefined, conv.cwd);
          const candidateHeader = candidate.getHeader();
          const candidateBranch = candidate.getBranch();
          const targetPresent = boundary.parentId ? candidateBranch.some((entry) => entry.id === boundary.parentId) : candidateBranch.every((entry) => entry.type === 'custom');
          const operationMarked = candidateBranch.some((entry) =>
            entry.type === 'custom' &&
            entry.customType === 'monika.forum.fork.operation' &&
            entry.data?.operationId === operationId &&
            entry.data?.boundaryEntryId === boundaryEntryId
          );
          if (candidateHeader?.parentSession === conv.sessionPath && targetPresent && !candidateBranch.some((entry) => entry.id === boundaryEntryId) && operationMarked)
            exact.push(candidatePath);
        } catch {}
      }
      if (exact.length === 1) childPath = exact[0];
      else {
        const message = exact.length > 1
          ? 'Multiple operation-marked fork children require manual recovery'
          : 'Fork creation outcome is unknown and no operation-marked child can be adopted';
        await ledger.write({ ...durableRequest, state: 'manual_recovery', error_code: 'fork_manual_recovery', error_message: message, failed_at: new Date().toISOString() });
        throw new ForumForkConflictError('fork_manual_recovery', message);
      }
    }
    if (!childPath) {
      if (boundary.parentId) childPath = manager.createBranchedSession(boundary.parentId);
      else {
        const child = SessionManager.create(conv.cwd, manager.getSessionDir());
        child.newSession({ parentSession: conv.sessionPath });
        childPath = child.getSessionFile();
      }
      if (!childPath) throw new Error('Pi did not persist the forked session');
      const createdChild = SessionManager.open(childPath, undefined, conv.cwd);
      createdChild.appendCustomEntry('monika.forum.fork.operation', { operationId, boundaryEntryId });
    }
    if (!childPath) throw new Error('Pi did not persist the forked session');
    let child = SessionManager.open(childPath, undefined, conv.cwd);
    childSessionId = child.getSessionId();
    await ledger.write({ ...durableRequest, state: 'child_created', child_session_id: childSessionId, child_session_path: childPath });
    const inheritedGeneration = readDispatchFence(child.getBranch()).generation;
    if (!child.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'monika.lineage' && entry.data?.operationId === operationId)) child.appendCustomEntry('monika.lineage', {
      kind: 'fork', source: 'forum', parentSession: conv.sessionPath,
      operationId, boundaryEntryId, createdAt: new Date().toISOString(),
    });
    if (!child.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'monika.forum.fork.pending' && entry.data?.operationId === operationId)) child.appendCustomEntry('monika.forum.fork.pending', { operationId, boundaryEntryId });
    child = SessionManager.open(childPath, undefined, conv.cwd);
    const sourceAfter = await readFile(conv.sessionPath);
    if (!sourceBefore.equals(sourceAfter)) throw new Error('Parent session changed during detached fork');
    const result = {
      operation_id: operationId,
      child_session_id: child.getSessionId(),
      child_session_path: childPath,
      parent_session_id: conv.piSessionId,
      boundary_entry_id: boundaryEntryId,
      inherited_generation: inheritedGeneration,
      active_entry_ids: child.getBranch().map((entry) => entry.id),
      already_completed: false,
    };
    await ledger.write({ ...durableRequest, state: 'canonical_completed', child_session_id: result.child_session_id, child_session_path: childPath, completed_at: new Date().toISOString(), result });
    return result;
  } catch (error) {
    if (error instanceof ForumForkConflictError && error.code === 'fork_manual_recovery') throw error;
    await ledger.write({ ...durableRequest, state: 'failed', child_session_id: childSessionId, child_session_path: childPath ?? null, error_code: 'fork_failed', error_message: error instanceof Error ? error.message : String(error), failed_at: new Date().toISOString() });
    throw error;
  }
}
