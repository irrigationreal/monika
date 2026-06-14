import type { EventId, EventSequence, ExternalId, SurfaceId, ForumId, TopicId, PostId, IdentityId } from './ids';
import type { TopicStatus } from './entities';
import type { ExternalRef, SurfaceKind } from './surfaces';

export interface EventSource {
  surfaceId: SurfaceId;
  surfaceKind: SurfaceKind;
  externalEventId?: ExternalId | null;
  externalRef?: ExternalRef | null;
}

export interface EventEnvelope<TType extends string, TPayload> {
  id: EventId;
  type: TType;
  sequence: EventSequence;
  occurredAt: string;
  ingestedAt: string;
  source: EventSource;
  actorId?: IdentityId | null;
  actorExternalRef?: ExternalRef | null;
  payload: TPayload;
  metadata?: Record<string, unknown>;
}

export type ForumEvent =
  | EventEnvelope<'forum.created', { forumId: ForumId; name: string; description?: string | null }>
  | EventEnvelope<'forum.renamed', { forumId: ForumId; name: string }>
  | EventEnvelope<'forum.updated', { forumId: ForumId; description?: string | null }>;

export type TopicEvent =
  | EventEnvelope<
      'topic.created',
      { topicId: TopicId; forumId: ForumId; title: string; createdBy: IdentityId; firstPostId: PostId }
    >
  | EventEnvelope<'topic.renamed', { topicId: TopicId; title: string }>
  | EventEnvelope<'topic.tagged', { topicId: TopicId; tags: string[] }>
  | EventEnvelope<'topic.status.changed', { topicId: TopicId; status: TopicStatus }>;

export type PostEvent =
  | EventEnvelope<'post.created', { postId: PostId; topicId: TopicId; authorId: IdentityId }>
  | EventEnvelope<'post.edited', { postId: PostId; topicId: TopicId }>
  | EventEnvelope<'post.deleted', { postId: PostId; topicId: TopicId }>;

export type IdentityEvent = EventEnvelope<'identity.synced', { identityId: IdentityId; displayName: string }>;

export type ForumCoreEvent = ForumEvent | TopicEvent | PostEvent | IdentityEvent;
