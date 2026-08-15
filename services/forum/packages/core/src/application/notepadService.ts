import {
  NOTEPAD_LIMITS,
  NotepadConflictError,
  NotepadNotFoundError,
  NotepadQuotaError,
  NotepadValidationError,
  normalizeNotepadTags,
  notepadExpiresAt,
} from '../domain/notepad';

import type { IdentityId } from '../domain/ids';
import type {
  NotepadEntry,
  NotepadEntryWriteInput,
  NotepadExpirationPreset,
  NotepadTagSummary,
} from '../domain/notepad';
import type { NotepadRepository } from '../interfaces/repositories';

export class NotepadService {
  constructor(
    private readonly repository: NotepadRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  list(
    ownerIdentityId: IdentityId,
    input: { query?: string; tags?: string[]; cursor?: string; limit?: number }
  ): Promise<{ entries: NotepadEntry[]; nextCursor: string | null }> {
    const requestedLimit = input.limit ?? 30;
    const value: { query?: string; tags: string[]; cursor?: string; limit: number } = {
      tags: normalizeNotepadTags(input.tags ?? []),
      limit: Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 30,
    };
    const query = input.query?.trim();
    if (query) value.query = query;
    if (input.cursor) value.cursor = input.cursor;
    return this.repository.list(ownerIdentityId, value);
  }

  get(ownerIdentityId: IdentityId, id: string): Promise<NotepadEntry | null> {
    return this.repository.get(ownerIdentityId, id);
  }

  tags(ownerIdentityId: IdentityId): Promise<NotepadTagSummary[]> {
    return this.repository.tags(ownerIdentityId);
  }

  async create(
    ownerIdentityId: IdentityId,
    input: NotepadEntryWriteInput & { draft?: { id: string; revision: number } }
  ): Promise<NotepadEntry> {
    const value = validate(input);
    const now = this.now();
    const createInput: Parameters<NotepadRepository['create']>[0] = {
      entry: {
        id: this.id(),
        ownerIdentityId,
        contentFormat: 'plaintext-v1',
        title: value.title,
        body: value.body,
        tags: value.tags,
        pinned: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: notepadExpiresAt(input.expiration ?? 'one_month', now),
      },
      quota: NOTEPAD_LIMITS.entriesPerIdentity,
      now,
    };
    if (input.draft) createInput.draft = input.draft;
    const result = await this.repository.create(createInput);
    if (result === 'conflict') throw new NotepadConflictError('Draft changed in another session');
    if (result === 'quota') throw new NotepadQuotaError('Notepad entry quota reached');
    return result;
  }

  async update(
    ownerIdentityId: IdentityId,
    id: string,
    expectedRevision: number,
    input: Omit<NotepadEntryWriteInput, 'expiration'> & {
      expiration?: NotepadExpirationPreset | 'keep';
      pinned?: boolean;
    }
  ): Promise<NotepadEntry> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new NotepadValidationError('Invalid revision');
    const value = validate(input);
    const now = this.now();
    const updateValue: {
      title: string | null;
      body: string;
      tags: string[];
      pinned?: boolean;
      expiresAt?: string | null;
    } = { title: value.title, body: value.body, tags: value.tags };
    if (input.pinned !== undefined) updateValue.pinned = input.pinned;
    if (input.expiration !== undefined && input.expiration !== 'keep')
      updateValue.expiresAt = notepadExpiresAt(input.expiration, now);
    const result = await this.repository.update({
      ownerIdentityId,
      id,
      expectedRevision,
      value: updateValue,
      now,
    });
    if (result === 'missing') throw new NotepadNotFoundError('Note not found');
    if (result === 'conflict') throw new NotepadConflictError('Note changed in another session');
    return result;
  }

  async delete(ownerIdentityId: IdentityId, id: string, expectedRevision: number): Promise<void> {
    const result = await this.repository.delete(ownerIdentityId, id, expectedRevision);
    if (result === 'missing') throw new NotepadNotFoundError('Note not found');
    if (result === 'conflict') throw new NotepadConflictError('Note changed in another session');
  }

  purgeExpired(): Promise<number> {
    return this.repository.purgeExpired(this.now());
  }
}

function validate(input: Pick<NotepadEntryWriteInput, 'title' | 'body' | 'tags'>): {
  title: string | null;
  body: string;
  tags: string[];
} {
  const title = input.title?.trim() || null;
  if ((title?.length ?? 0) > NOTEPAD_LIMITS.titleCharacters)
    throw new NotepadValidationError('Note title must be at most 255 characters');
  if (!input.body.trim()) throw new NotepadValidationError('Note body is required');
  if (new TextEncoder().encode(input.body).byteLength > NOTEPAD_LIMITS.bodyUtf8Bytes)
    throw new NotepadValidationError('Note body must be at most 64 KiB UTF-8');
  return { title, body: input.body, tags: normalizeNotepadTags(input.tags ?? []) };
}
