import {
  MESSAGE_TEMPLATE_LIMITS,
  MessageTemplateConflictError,
  MessageTemplateNotFoundError,
  MessageTemplateQuotaError,
  MessageTemplateValidationError,
} from '../domain/messageTemplates';

import type { ForumId, IdentityId } from '../domain/ids';
import type {
  MessageTemplate,
  MessageTemplateContext,
  MessageTemplateScope,
  MessageTemplateWriteInput,
} from '../domain/messageTemplates';
import type { MessageTemplateRepository } from '../interfaces/repositories';

export class MessageTemplateService {
  constructor(
    private readonly repository: MessageTemplateRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  listPersonal(ownerIdentityId: IdentityId): Promise<MessageTemplate[]> {
    return this.repository.listPersonal(ownerIdentityId);
  }

  listSystem(): Promise<MessageTemplate[]> {
    return this.repository.listSystem();
  }

  listEffective(input: {
    identityId: IdentityId;
    context: MessageTemplateContext;
    forumId: ForumId;
    includePersonal?: boolean;
  }): Promise<MessageTemplate[]> {
    return this.repository.listEffective({ ...input, includePersonal: input.includePersonal !== false });
  }

  async createPersonal(ownerIdentityId: IdentityId, input: MessageTemplateWriteInput): Promise<MessageTemplate> {
    return this.create('personal', ownerIdentityId, ownerIdentityId, input, MESSAGE_TEMPLATE_LIMITS.personalCount);
  }

  async createSystem(actorId: IdentityId, input: MessageTemplateWriteInput): Promise<MessageTemplate> {
    return this.create('system', null, actorId, input, MESSAGE_TEMPLATE_LIMITS.systemCount);
  }

  async updatePersonal(
    ownerIdentityId: IdentityId,
    id: string,
    revision: number,
    input: MessageTemplateWriteInput
  ): Promise<MessageTemplate> {
    return this.update('personal', ownerIdentityId, ownerIdentityId, id, revision, input);
  }

  async updateSystem(
    actorId: IdentityId,
    id: string,
    revision: number,
    input: MessageTemplateWriteInput
  ): Promise<MessageTemplate> {
    return this.update('system', null, actorId, id, revision, input);
  }

  async deletePersonal(ownerIdentityId: IdentityId, id: string, revision: number): Promise<void> {
    return this.delete('personal', ownerIdentityId, id, revision);
  }

  async deleteSystem(id: string, revision: number): Promise<void> {
    return this.delete('system', null, id, revision);
  }

  async reorderPersonal(
    ownerIdentityId: IdentityId,
    items: { id: string; revision: number }[]
  ): Promise<MessageTemplate[]> {
    return this.reorder('personal', ownerIdentityId, ownerIdentityId, items);
  }

  async reorderSystem(actorId: IdentityId, items: { id: string; revision: number }[]): Promise<MessageTemplate[]> {
    return this.reorder('system', null, actorId, items);
  }

  private async create(
    scope: MessageTemplateScope,
    ownerIdentityId: IdentityId | null,
    actorId: IdentityId,
    input: MessageTemplateWriteInput,
    quota: number
  ): Promise<MessageTemplate> {
    const value = validate(input);
    const now = this.now();
    try {
      return await this.repository.create(
        {
          id: this.id(),
          scope,
          ownerIdentityId,
          name: value.name,
          category: value.category ?? null,
          body: value.body,
          threadTitle: value.threadTitle ?? null,
          forumScope: value.forumScope,
          forumIds: value.forumIds,
          contexts: value.contexts,
          enabled: value.enabled,
          sortOrder: 0,
          revision: 1,
          createdBy: actorId,
          updatedBy: actorId,
          createdAt: now,
          updatedAt: now,
        },
        quota
      );
    } catch (error) {
      if (error instanceof MessageTemplateQuotaError) throw error;
      throw error;
    }
  }

  private async update(
    scope: MessageTemplateScope,
    ownerIdentityId: IdentityId | null,
    actorId: IdentityId,
    id: string,
    revision: number,
    input: MessageTemplateWriteInput
  ): Promise<MessageTemplate> {
    validateRevision(revision);
    const result = await this.repository.update({
      id,
      scope,
      ownerIdentityId,
      expectedRevision: revision,
      actorId,
      value: validate(input),
    });
    if (result === 'missing') throw new MessageTemplateNotFoundError('Message template not found');
    if (result === 'conflict') throw new MessageTemplateConflictError('Message template changed in another session');
    return result;
  }

  private async delete(
    scope: MessageTemplateScope,
    ownerIdentityId: IdentityId | null,
    id: string,
    revision: number
  ): Promise<void> {
    validateRevision(revision);
    const result = await this.repository.delete({ id, scope, ownerIdentityId, expectedRevision: revision });
    if (result === 'missing') throw new MessageTemplateNotFoundError('Message template not found');
    if (result === 'conflict') throw new MessageTemplateConflictError('Message template changed in another session');
  }

  private async reorder(
    scope: MessageTemplateScope,
    ownerIdentityId: IdentityId | null,
    actorId: IdentityId,
    items: { id: string; revision: number }[]
  ): Promise<MessageTemplate[]> {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new MessageTemplateValidationError('Duplicate template id');
    items.forEach((item) => {
      validateRevision(item.revision);
    });
    const result = await this.repository.reorder({ scope, ownerIdentityId, actorId, items });
    if (result === 'missing') throw new MessageTemplateNotFoundError('Message template not found');
    if (result === 'conflict') throw new MessageTemplateConflictError('Message template changed in another session');
    if (result === 'invalid')
      throw new MessageTemplateValidationError('Reorder must include every message template exactly once');
    return result;
  }
}

function validateRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) throw new MessageTemplateValidationError('Invalid revision');
}

function validate(input: MessageTemplateWriteInput): MessageTemplateWriteInput {
  const name = input.name.trim();
  const category = trimOptional(input.category);
  const threadTitle = trimOptional(input.threadTitle);
  if (!name || name.length > MESSAGE_TEMPLATE_LIMITS.nameCharacters)
    throw new MessageTemplateValidationError('Name must be 1-80 characters');
  if (category && category.length > MESSAGE_TEMPLATE_LIMITS.categoryCharacters)
    throw new MessageTemplateValidationError('Category must be at most 40 characters');
  if (!input.body.trim()) throw new MessageTemplateValidationError('Body is required');
  if (new TextEncoder().encode(input.body).byteLength > MESSAGE_TEMPLATE_LIMITS.bodyUtf8Bytes)
    throw new MessageTemplateValidationError('Body must be at most 64 KiB UTF-8');
  if (threadTitle && threadTitle.length > MESSAGE_TEMPLATE_LIMITS.threadTitleCharacters)
    throw new MessageTemplateValidationError('Thread title must be at most 255 characters');
  const contexts = [...new Set(input.contexts)];
  if (!contexts.length) throw new MessageTemplateValidationError('At least one valid context is required');
  const forumIds = [...new Set(input.forumIds)];
  if (input.forumScope === 'selected' && forumIds.length === 0)
    throw new MessageTemplateValidationError('Select at least one forum');
  if (input.forumScope === 'all' && forumIds.length > 0)
    throw new MessageTemplateValidationError('All-forum templates cannot include forum ids');
  return {
    name,
    category,
    body: input.body,
    threadTitle,
    forumScope: input.forumScope,
    forumIds,
    contexts,
    enabled: input.enabled,
  };
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed;
}
