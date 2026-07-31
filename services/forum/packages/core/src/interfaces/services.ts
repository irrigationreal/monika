import type { Forum, ForumStatus, ForumVisibility, IdentityPublic, Post, RobotMode, Topic } from '../domain/entities';
import type {
  EventId,
  ExternalId,
  ForumId,
  IdentityId,
  PostId,
  SessionId,
  SurfaceId,
  TenantId,
  TopicId,
} from '../domain/ids';
import type { SurfaceEvent } from '../domain/surfaces';
import type { RobotState } from '../state/robot';
import type { ForumListOptions } from './repositories';

export interface CreateForumInput {
  name: string;
  description?: string | null;
  parentForumId?: ForumId | null;
  category?: string | null;
  visibility?: ForumVisibility;
  status?: ForumStatus;
  cwd?: string | null;
  prePrompt?: string | null;
  tenantId?: TenantId | null;
}

export interface CreateTopicInput {
  forumId: ForumId;
  title: string;
  body: string;
  authorId: IdentityId;
  robotMode?: RobotMode | null;
  autoCompactEnabled?: boolean;
  silent?: boolean;
  attachmentsPending?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
  tenantId?: TenantId | null;
}

export interface CreatePostInput {
  topicId: TopicId;
  body: string;
  authorId: IdentityId;
  parentPostId?: PostId | null;
  sourceMessageId?: string | null;
  autoCompactEnabled?: boolean;
  autoCompactRevision?: number;
  silent?: boolean;
  attachmentsPending?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
  tenantId?: TenantId | null;
}

export interface ForumService {
  listForums(options?: ForumListOptions): Promise<Forum[]>;
  getForum(id: ForumId): Promise<Forum | null>;
  createForum(input: CreateForumInput): Promise<Forum>;
}

export interface TopicCreationResult {
  topic: Topic;
  post: Post;
}

export interface TopicService {
  listTopics(forumId: ForumId, page?: number, pageSize?: number): Promise<Topic[]>;
  getTopic(topicId: TopicId): Promise<Topic | null>;
  createTopic(input: CreateTopicInput): Promise<TopicCreationResult>;
}

export interface PostCreationResult {
  post: Post;
}

export interface PostService {
  listPosts(topicId: TopicId, page?: number, pageSize?: number): Promise<Post[]>;
  createPost(input: CreatePostInput): Promise<PostCreationResult>;
}

export interface IdentityService {
  getIdentity(id: IdentityId): Promise<IdentityPublic | null>;
  listIdentities(topicId: TopicId, page?: number, pageSize?: number): Promise<IdentityPublic[]>;
}

export interface SessionRoutingContext {
  surfaceId?: SurfaceId | null;
  externalTopicId?: ExternalId | null;
  externalPostId?: ExternalId | null;
  mode?: 'reply' | 'sync';
  replyVisibility?: 'public' | 'internal' | 'private';
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface SessionOrchestrator {
  startSessionForTopic(topicId: TopicId, firstPostId: PostId, context?: SessionRoutingContext): Promise<SessionId>;
  enqueueTurn(topicId: TopicId, postId: PostId, context?: SessionRoutingContext): Promise<void>;
}

export interface SurfaceIngestResult {
  accepted: boolean;
  reason?: string;
  eventId?: EventId;
  topicId?: TopicId;
  postId?: PostId;
  sessionId?: SessionId;
}

export interface SurfaceEventIngestor {
  ingest(event: SurfaceEvent): Promise<SurfaceIngestResult>;
}

export interface StateInspector {
  getRobotState(topicId: TopicId): Promise<RobotState | null>;
  watchRobotState(topicId: TopicId): AsyncIterable<RobotState>;
}
