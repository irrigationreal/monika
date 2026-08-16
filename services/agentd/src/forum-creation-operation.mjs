import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ForumCreationConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForumCreationConflictError';
    this.code = code;
  }
}

export function validateForumCreationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._~-]{1,200}$/.test(id)) {
    throw new TypeError('creation_id must contain 1-200 URL-safe characters');
  }
  return id;
}

function stableRequest(input) {
  return JSON.stringify({
    cwd: input.cwd ?? null,
    model: input.model ?? null,
    reasoning: input.reasoning ?? input.thinking ?? null,
    instructions: input.instructions ?? null,
    auto_compact: input.auto_compact ?? null,
    tools: input.tools ?? null,
    coordination_mode: input.coordination_mode ?? null,
    parent_pi_session_id: input.parent_pi_session_id ?? null,
    parent_pi_session_path: input.parent_pi_session_path ?? null,
    lineage_kind: input.lineage_kind ?? null,
    lineage_source: input.lineage_source ?? null,
    lineage_metadata: input.lineage_metadata ?? null,
  });
}

export function forumCreationRequestHash(input) {
  return createHash('sha256').update(stableRequest(input)).digest('hex');
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export class ForumCreationLedger {
  constructor(root) {
    if (!path.isAbsolute(root)) throw new TypeError('forum creation ledger root must be absolute');
    this.root = path.resolve(root);
  }

  file(creationId) {
    return path.join(this.root, `${validateForumCreationId(creationId)}.json`);
  }

  async read(creationId) {
    try {
      const record = JSON.parse(await readFile(this.file(creationId), 'utf8'));
      if (record.creation_id !== validateForumCreationId(creationId)) {
        throw new ForumCreationConflictError('creation_record_invalid', 'creation record identity is invalid');
      }
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(record) {
    validateForumCreationId(record.creation_id);
    if (typeof record.session_id !== 'string' || !record.session_id ||
        typeof record.session_path !== 'string' || !path.isAbsolute(record.session_path)) {
      throw new TypeError('creation record requires an absolute intended session identity');
    }
    await atomicJson(this.file(record.creation_id), record);
  }
}

export function assertForumCreationRequest(record, requestHash) {
  if (record.request_hash !== requestHash) {
    throw new ForumCreationConflictError('creation_mismatch', 'creation_id is already used by another conversation request');
  }
}

export async function reconcileForumCreation({ ledger, creationId, requestHash, resolveCanonical }) {
  const record = await ledger.read(creationId);
  if (!record) return null;
  assertForumCreationRequest(record, requestHash);
  if (record.state !== 'creating' && record.state !== 'anchored') {
    throw new ForumCreationConflictError('creation_manual_recovery', 'Durable conversation creation requires manual recovery');
  }
  const canonical = await resolveCanonical(record);
  if (!canonical || canonical.id !== record.session_id || canonical.path !== record.session_path ||
      !hasForumCreationAnchor(canonical.raw, creationId)) {
    throw new ForumCreationConflictError(
      'creation_manual_recovery',
      'Durable conversation creation is ambiguous; canonical evidence is missing and no replacement may be created',
    );
  }
  if (record.state === 'creating') {
    const anchored = { ...record, state: 'anchored', anchored_at: new Date().toISOString() };
    await ledger.write(anchored);
    return { record: anchored, canonical };
  }
  return { record, canonical };
}

export function hasForumCreationAnchor(raw, creationId) {
  let anchor = false;
  let completed = false;
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== 'custom' || entry.data?.creation_id !== creationId) continue;
      if (entry.customType === 'monika.forum.session') anchor = true;
      if (entry.customType === 'monika.forum.creation.completed') completed = true;
    } catch {}
  }
  return anchor && completed;
}
