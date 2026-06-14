import type { SurfaceEventEnvelope } from '@irrigationreal/codex-forum-core';
import type { ExternalId } from '@irrigationreal/codex-forum-core';
import type { SurfaceAdapter } from './surface';

export type WebEntityType = 'forum' | 'topic' | 'post' | 'identity';

export interface WebEventBase {
  forumId?: string | null;
  topicId?: string | null;
  postId?: string | null;
  authorId?: string | null;
  entityType: WebEntityType;
}

export interface WebForumEventPayload extends WebEventBase {
  type: 'forum.created' | 'forum.updated';
  title?: string | null;
  description?: string | null;
}

export interface WebTopicEventPayload extends WebEventBase {
  type: 'topic.created' | 'topic.renamed' | 'topic.tagged' | 'topic.status.changed';
  title?: string | null;
  tags?: string[];
  status?: 'open' | 'locked' | 'archived';
  body?: string | null;
}

export interface WebPostEventPayload extends WebEventBase {
  type: 'post.created' | 'post.edited' | 'post.deleted';
  body?: string | null;
  parentPostId?: ExternalId | null;
}

export interface WebIdentityEventPayload extends WebEventBase {
  type: 'identity.synced';
  displayName?: string | null;
}

export type WebEventPayload =
  | WebForumEventPayload
  | WebTopicEventPayload
  | WebPostEventPayload
  | WebIdentityEventPayload;

export type WebSurfaceEvent = SurfaceEventEnvelope<WebEventPayload>;

export interface WebAdapter extends SurfaceAdapter<WebSurfaceEvent> {
  readonly surface: 'web';
}
