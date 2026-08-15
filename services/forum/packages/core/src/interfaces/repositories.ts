import type { AccessRule, AccessRuleScopeKind } from '../domain/access';
import type { Forum, ForumStatus, IdentityPrivate, IdentityPublic, Post, Topic } from '../domain/entities';
import type { ForumCoreEvent } from '../domain/events';
import type {
  EventCursor,
  EventId,
  EventSequence,
  ExternalId,
  ExternalRefId,
  ForumId,
  IdentityId,
  PostId,
  SurfaceCursor,
  SurfaceId,
  TopicId,
} from '../domain/ids';
import type { MessageDraft, MessageDraftWriteInput } from '../domain/messageDrafts';
import type {
  MessageTemplate,
  MessageTemplateContext,
  MessageTemplateScope,
  MessageTemplateWriteInput,
} from '../domain/messageTemplates';
import type { NotepadEntry, NotepadTagSummary } from '../domain/notepad';
import type { ExternalRef, ExternalRefKind } from '../domain/surfaces';

export interface ForumListOptions {
  parentForumId?: ForumId | null;
  status?: ForumStatus;
  includeArchived?: boolean;
}

export interface ForumRepository {
  getById(id: ForumId): Promise<Forum | null>;
  list(options?: ForumListOptions): Promise<Forum[]>;
  create(forum: Forum): Promise<void>;
  update(forum: Forum): Promise<void>;
}

export interface TopicRepository {
  getById(id: TopicId): Promise<Topic | null>;
  listByForum(forumId: ForumId, page?: number, pageSize?: number): Promise<Topic[]>;
  create(topic: Topic): Promise<void>;
  update(topic: Topic): Promise<void>;
}

export interface PostRepository {
  getById(id: PostId): Promise<Post | null>;
  listByTopic(topicId: TopicId, page?: number, pageSize?: number): Promise<Post[]>;
  create(post: Post): Promise<void>;
  update(post: Post): Promise<void>;
  delete(postId: PostId): Promise<void>;
}

export interface IdentityRepository {
  getById(id: IdentityId): Promise<IdentityPrivate | null>;
  listByTopic(topicId: TopicId, page?: number, pageSize?: number): Promise<IdentityPublic[]>;
  create(identity: IdentityPrivate): Promise<void>;
  update(identity: IdentityPrivate): Promise<void>;
}

export interface MessageDraftRepository {
  getById(ownerIdentityId: IdentityId, id: string, now: string): Promise<MessageDraft | null>;
  getReply(ownerIdentityId: IdentityId, topicId: TopicId, now: string): Promise<MessageDraft | null>;
  listOwner(ownerIdentityId: IdentityId, now: string): Promise<MessageDraft[]>;
  listNewThreadByForum(ownerIdentityId: IdentityId, forumId: ForumId, now: string): Promise<MessageDraft[]>;
  save(input: {
    draft: MessageDraft;
    expectedRevision: number;
    value: MessageDraftWriteInput;
    now: string;
    quota: number;
  }): Promise<MessageDraft | 'conflict' | 'quota'>;
  delete(
    ownerIdentityId: IdentityId,
    id: string,
    expectedRevision?: number
  ): Promise<'deleted' | 'missing' | 'conflict'>;
  purgeExpired(now: string): Promise<number>;
}

export interface NotepadRepository {
  list(
    ownerIdentityId: IdentityId,
    input: { query?: string; tags: string[]; cursor?: string; limit: number }
  ): Promise<{ entries: NotepadEntry[]; nextCursor: string | null }>;
  get(ownerIdentityId: IdentityId, id: string): Promise<NotepadEntry | null>;
  tags(ownerIdentityId: IdentityId): Promise<NotepadTagSummary[]>;
  create(input: {
    entry: NotepadEntry;
    draft?: { id: string; revision: number };
    quota: number;
    now: string;
  }): Promise<NotepadEntry | 'conflict' | 'quota'>;
  update(input: {
    ownerIdentityId: IdentityId;
    id: string;
    expectedRevision: number;
    value: {
      title: string | null;
      body: string;
      tags: string[];
      pinned?: boolean;
      expiresAt?: string | null;
    };
    now: string;
  }): Promise<NotepadEntry | 'missing' | 'conflict'>;
  delete(
    ownerIdentityId: IdentityId,
    id: string,
    expectedRevision: number
  ): Promise<'deleted' | 'missing' | 'conflict'>;
  purgeExpired(now: string): Promise<number>;
}

export interface MessageTemplateRepository {
  listPersonal(ownerIdentityId: IdentityId): Promise<MessageTemplate[]>;
  listSystem(): Promise<MessageTemplate[]>;
  listEffective(input: {
    identityId: IdentityId;
    context: MessageTemplateContext;
    forumId: ForumId;
    includePersonal: boolean;
  }): Promise<MessageTemplate[]>;
  create(input: MessageTemplate, quota: number): Promise<MessageTemplate>;
  update(input: {
    id: string;
    scope: MessageTemplateScope;
    ownerIdentityId: IdentityId | null;
    expectedRevision: number;
    actorId: IdentityId;
    value: MessageTemplateWriteInput;
  }): Promise<MessageTemplate | 'missing' | 'conflict'>;
  delete(input: {
    id: string;
    scope: MessageTemplateScope;
    ownerIdentityId: IdentityId | null;
    expectedRevision: number;
  }): Promise<'deleted' | 'missing' | 'conflict'>;
  reorder(input: {
    scope: MessageTemplateScope;
    ownerIdentityId: IdentityId | null;
    actorId: IdentityId;
    items: { id: string; revision: number }[];
  }): Promise<MessageTemplate[] | 'missing' | 'conflict' | 'invalid'>;
}

export interface ExternalRefRepository {
  getById(id: ExternalRefId): Promise<ExternalRef | null>;
  getByExternal(surfaceId: SurfaceId, externalId: ExternalId, kind?: ExternalRefKind): Promise<ExternalRef | null>;
  listByTopic(topicId: TopicId): Promise<ExternalRef[]>;
  create(ref: ExternalRef): Promise<void>;
  update(ref: ExternalRef): Promise<void>;
}

export interface AccessRuleRepository {
  listByScope(scopeKind: AccessRuleScopeKind, scopeId: string): Promise<AccessRule[]>;
  upsert(rule: AccessRule): Promise<AccessRule>;
  delete(ruleId: string): Promise<boolean>;
}

export interface EventAppendResult {
  id: EventId;
  sequence: EventSequence;
  cursor: EventCursor;
}

export interface EventStore {
  append(event: ForumCoreEvent): Promise<EventAppendResult>;
  getSince(cursor?: EventCursor, sinceTime?: string): AsyncIterable<ForumCoreEvent>;
}

export interface ProjectionStore {
  rebuild(): Promise<void>;
  isHealthy(): Promise<boolean>;
}

export interface SurfaceCursorStore {
  getCursor(surfaceId: SurfaceId): Promise<SurfaceCursor | null>;
  setCursor(surfaceId: SurfaceId, cursor: SurfaceCursor): Promise<void>;
}

export interface IdempotencyStore {
  has(surface: SurfaceId, externalEventId: ExternalId): Promise<boolean>;
  mark(surface: SurfaceId, externalEventId: ExternalId, eventId: EventId): Promise<void>;
}
