import type {
  ExternalId,
  ExternalRefId,
  ForumId,
  IdentityId,
  PostId,
  SurfaceId,
  TopicId
} from './ids';

export type SurfaceKind = 'discord' | 'slack' | 'matrix' | 'web' | 'system' | 'forum';

export type ExternalRefKind =
  | 'forum'
  | 'topic'
  | 'post'
  | 'identity'
  | 'attachment'
  | 'reaction'
  | 'other';

export type ExternalScopeKind =
  | 'workspace'
  | 'server'
  | 'space'
  | 'channel'
  | 'thread'
  | 'forum'
  | 'topic'
  | 'other';

export interface ExternalRef {
  id: ExternalRefId;
  surfaceId: SurfaceId;
  surfaceKind: SurfaceKind;
  externalId: ExternalId;
  kind: ExternalRefKind;
  scope?: string | null;
  scopeKind?: ExternalScopeKind | null;
  mappedForumId?: ForumId | null;
  mappedTopicId?: TopicId | null;
  mappedPostId?: PostId | null;
  mappedIdentityId?: IdentityId | null;
}

export type SurfaceEventType =
  | 'forum.created'
  | 'forum.updated'
  | 'topic.created'
  | 'topic.renamed'
  | 'topic.tagged'
  | 'topic.status.changed'
  | 'post.created'
  | 'post.edited'
  | 'post.deleted'
  | 'identity.synced'
  | 'attachment.added'
  | 'reaction.added'
  | 'reaction.removed'
  | 'other';

export interface SurfaceEventPayloadBase {
  type: SurfaceEventType;
}

export interface SurfaceForumPayload extends SurfaceEventPayloadBase {
  type: 'forum.created' | 'forum.updated';
  title?: string | null;
  description?: string | null;
}

export interface SurfaceTopicPayload extends SurfaceEventPayloadBase {
  type: 'topic.created' | 'topic.renamed' | 'topic.tagged' | 'topic.status.changed';
  title?: string | null;
  tags?: string[];
  status?: 'open' | 'locked' | 'archived';
  body?: string | null;
}

export interface SurfacePostPayload extends SurfaceEventPayloadBase {
  type: 'post.created' | 'post.edited' | 'post.deleted';
  body?: string | null;
  parentExternalId?: ExternalId | null;
}

export interface SurfaceIdentityPayload extends SurfaceEventPayloadBase {
  type: 'identity.synced';
  displayName?: string | null;
}

export interface SurfaceAttachmentPayload extends SurfaceEventPayloadBase {
  type: 'attachment.added';
  url?: string | null;
  filename?: string | null;
  sizeBytes?: number | null;
}

export interface SurfaceReactionPayload extends SurfaceEventPayloadBase {
  type: 'reaction.added' | 'reaction.removed';
  emoji?: string | null;
}

export interface SurfaceGenericPayload extends SurfaceEventPayloadBase {
  type: 'other';
  data?: Record<string, unknown>;
}

export type SurfaceEventPayload =
  | SurfaceForumPayload
  | SurfaceTopicPayload
  | SurfacePostPayload
  | SurfaceIdentityPayload
  | SurfaceAttachmentPayload
  | SurfaceReactionPayload
  | SurfaceGenericPayload;

export interface SurfaceEventEnvelope<TPayload extends SurfaceEventPayload = SurfaceEventPayload> {
  surfaceId: SurfaceId;
  surfaceKind: SurfaceKind;
  externalEventId?: ExternalId | null;
  cursor?: string | null;
  occurredAt: string;
  receivedAt: string;
  actor?: ExternalRef | null;
  subject: ExternalRef;
  payload: TPayload;
  metadata?: Record<string, unknown>;
}

export type SurfaceEvent = SurfaceEventEnvelope;
