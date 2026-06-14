import type { SurfaceEventEnvelope } from '@irrigationreal/codex-forum-core';
import type { ExternalId } from '@irrigationreal/codex-forum-core';
import type { SurfaceAdapter } from './surface';

export type SlackEntityType = 'workspace' | 'channel' | 'thread' | 'message' | 'user';

export interface SlackEventBase {
  workspaceId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  authorId?: string | null;
  entityType: SlackEntityType;
}

export interface SlackForumEventPayload extends SlackEventBase {
  type: 'forum.created' | 'forum.updated';
  title?: string | null;
  description?: string | null;
}

export interface SlackTopicEventPayload extends SlackEventBase {
  type: 'topic.created' | 'topic.renamed' | 'topic.tagged' | 'topic.status.changed';
  title?: string | null;
  tags?: string[];
  status?: 'open' | 'locked' | 'archived';
  body?: string | null;
}

export interface SlackPostEventPayload extends SlackEventBase {
  type: 'post.created' | 'post.edited' | 'post.deleted';
  body?: string | null;
  parentMessageTs?: ExternalId | null;
}

export interface SlackIdentityEventPayload extends SlackEventBase {
  type: 'identity.synced';
  displayName?: string | null;
}

export type SlackEventPayload =
  | SlackForumEventPayload
  | SlackTopicEventPayload
  | SlackPostEventPayload
  | SlackIdentityEventPayload;

export type SlackSurfaceEvent = SurfaceEventEnvelope<SlackEventPayload>;

export interface SlackAdapter extends SurfaceAdapter<SlackSurfaceEvent> {
  readonly surface: 'slack';
}
