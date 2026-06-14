import type {
  ExternalRef,
  SurfaceEvent,
  SurfaceKind
} from '@irrigationreal/codex-forum-core';
import type { ForumId, IdentityId, PostId, SurfaceId, TopicId } from '@irrigationreal/codex-forum-core';

export interface SurfaceEventBatch<TEvent extends SurfaceEvent = SurfaceEvent> {
  events: TEvent[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface SurfaceCapabilities {
  canCreateTopic: boolean;
  canCreatePost: boolean;
  canEditPost: boolean;
  canDeletePost: boolean;
  canUpdateTopic: boolean;
  supportsThreads: boolean;
  supportsAttachments: boolean;
  supportsReactions: boolean;
}

export interface SurfaceInboundAdapter<TEvent extends SurfaceEvent = SurfaceEvent> {
  readonly surface: SurfaceKind;
  readonly surfaceId: SurfaceId;
  readonly capabilities: SurfaceCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(cursor?: string | null): Promise<SurfaceEventBatch<TEvent>>;
  ack?(event: TEvent): Promise<void>;
  listForums?(): Promise<ExternalRef[]>;
  listTopics?(forumRef: ExternalRef, page?: number, pageSize?: number): Promise<ExternalRef[]>;
}

export interface SurfaceOutboundAdapter {
  readonly surface: SurfaceKind;
  readonly surfaceId: SurfaceId;
  readonly capabilities: SurfaceCapabilities;
  createTopic(forumId: ForumId, title: string, body: string, authorId: IdentityId): Promise<ExternalRef>;
  createPost(
    topicId: TopicId,
    body: string,
    authorId: IdentityId,
    parentPostId?: PostId | null
  ): Promise<ExternalRef>;
  updatePost?(postId: PostId, body: string): Promise<ExternalRef>;
  deletePost?(postId: PostId): Promise<void>;
  updateTopic?(topicId: TopicId, title: string): Promise<ExternalRef>;
}

export type SurfaceAdapter<TEvent extends SurfaceEvent = SurfaceEvent> =
  & SurfaceInboundAdapter<TEvent>
  & SurfaceOutboundAdapter;
