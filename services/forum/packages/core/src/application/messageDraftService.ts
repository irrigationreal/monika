import {
  MESSAGE_DRAFT_LIMITS,
  MessageDraftConflictError,
  MessageDraftNotFoundError,
  MessageDraftQuotaError,
  MessageDraftValidationError,
} from '../domain/messageDrafts';

import type { ForumId, IdentityId, TopicId } from '../domain/ids';
import type { MessageDraft, MessageDraftWriteInput } from '../domain/messageDrafts';
import type { MessageDraftRepository } from '../interfaces/repositories';

const RETENTION_MS = MESSAGE_DRAFT_LIMITS.retentionDays * 24 * 60 * 60 * 1000;

export class MessageDraftService {
  constructor(
    private readonly repository: MessageDraftRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  get(ownerIdentityId: IdentityId, id: string): Promise<MessageDraft | null> {
    return this.repository.getById(ownerIdentityId, id, this.now());
  }
  getReply(ownerIdentityId: IdentityId, topicId: TopicId): Promise<MessageDraft | null> {
    return this.repository.getReply(ownerIdentityId, topicId, this.now());
  }
  list(ownerIdentityId: IdentityId): Promise<MessageDraft[]> {
    return this.repository.listOwner(ownerIdentityId, this.now());
  }
  listNewThreadByForum(ownerIdentityId: IdentityId, forumId: ForumId): Promise<MessageDraft[]> {
    return this.repository.listNewThreadByForum(ownerIdentityId, forumId, this.now());
  }

  saveReply(
    ownerIdentityId: IdentityId,
    topicId: TopicId,
    expectedRevision: number,
    value: MessageDraftWriteInput
  ): Promise<MessageDraft> {
    return this.save(ownerIdentityId, 'reply', null, topicId, expectedRevision, value);
  }
  saveNewThread(
    ownerIdentityId: IdentityId,
    forumId: ForumId,
    expectedRevision: number,
    value: MessageDraftWriteInput,
    id?: string
  ): Promise<MessageDraft> {
    return this.save(ownerIdentityId, 'new_thread', forumId, null, expectedRevision, value, id);
  }

  async delete(ownerIdentityId: IdentityId, id: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined) validateRevision(expectedRevision, false);
    const result = await this.repository.delete(ownerIdentityId, id, expectedRevision);
    if (result === 'missing') throw new MessageDraftNotFoundError('Draft not found');
    if (result === 'conflict') throw new MessageDraftConflictError('Draft changed in another session');
  }

  purgeExpired(): Promise<number> {
    return this.repository.purgeExpired(this.now());
  }

  private async save(
    ownerIdentityId: IdentityId,
    context: MessageDraft['context'],
    forumId: ForumId | null,
    topicId: TopicId | null,
    expectedRevision: number,
    input: MessageDraftWriteInput,
    requestedId?: string
  ): Promise<MessageDraft> {
    validateRevision(expectedRevision, true);
    const value = validate(context, input);
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + RETENTION_MS).toISOString();
    const draft: MessageDraft = {
      id: requestedId ?? this.id(),
      ownerIdentityId,
      context,
      forumId,
      topicId,
      title: context === 'new_thread' ? (value.title ?? null) : null,
      body: value.body,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    const result = await this.repository.save({
      draft,
      expectedRevision,
      value,
      now,
      quota: MESSAGE_DRAFT_LIMITS.activePerIdentity,
    });
    if (result === 'conflict') throw new MessageDraftConflictError('Draft changed in another session');
    if (result === 'quota')
      throw new MessageDraftQuotaError(`Draft quota of ${String(MESSAGE_DRAFT_LIMITS.activePerIdentity)} reached`);
    return result;
  }
}

function validateRevision(revision: number, allowZero: boolean): void {
  if (!Number.isInteger(revision) || revision < (allowZero ? 0 : 1))
    throw new MessageDraftValidationError('Invalid draft revision');
}
function validate(context: MessageDraft['context'], input: MessageDraftWriteInput): MessageDraftWriteInput {
  const title = input.title ?? null;
  if (context === 'reply' && title != null) throw new MessageDraftValidationError('Reply drafts cannot have titles');
  if ((title?.length ?? 0) > MESSAGE_DRAFT_LIMITS.titleCharacters)
    throw new MessageDraftValidationError('Draft title must be at most 255 characters');
  if (new TextEncoder().encode(input.body).byteLength > MESSAGE_DRAFT_LIMITS.bodyUtf8Bytes)
    throw new MessageDraftValidationError('Draft body must be at most 64 KiB UTF-8');
  if (!input.body.trim() && !(context === 'new_thread' && title?.trim()))
    throw new MessageDraftValidationError('Blank drafts are not stored');
  return { title, body: input.body };
}
