import type { Forum, Topic, Post, IdentityPublic, IdentityPrivate, ForumStatus } from '../domain/entities';
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
  TopicId
} from '../domain/ids';
import type { ForumCoreEvent } from '../domain/events';
import type { ExternalRef, ExternalRefKind } from '../domain/surfaces';
import type { AccessRule, AccessRuleScopeKind } from '../domain/access';

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