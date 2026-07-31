import type { ForumId, IdentityId, PostId, TenantId, TopicId } from './ids';

export type TopicStatus = 'open' | 'locked' | 'archived';
export type ForumStatus = 'active' | 'archived';
export type IdentityKind = 'human' | 'robot' | 'persona' | 'webhook' | 'system' | 'admin';

export const ForumVisibilityValues = ['public', 'members', 'admin'] as const;
export type ForumVisibility = (typeof ForumVisibilityValues)[number];

export const RobotModeValues = ['auto', 'mention', 'off'] as const;
export type RobotMode = (typeof RobotModeValues)[number];

export interface Forum {
  id: ForumId;
  tenantId?: TenantId | null;
  parentForumId?: ForumId | null;
  category?: string | null;
  name: string;
  description?: string | null;
  cwd?: string | null;
  prePrompt?: string | null;
  status: ForumStatus;
  visibility: ForumVisibility;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Topic {
  id: TopicId;
  forumId: ForumId;
  tenantId?: TenantId | null;
  title: string;
  status: TopicStatus;
  robotMode?: RobotMode | null;
  /** Whether Pi may automatically compact this canonical parent session. */
  autoCompactEnabled?: boolean;
  /** Optimistic revision for the shared thread setting. */
  autoCompactRevision?: number;
  tags: string[];
  createdBy: IdentityId;
  createdAt: string;
  updatedAt: string;
}

export interface Post {
  id: PostId;
  topicId: TopicId;
  tenantId?: TenantId | null;
  parentPostId?: PostId | null;
  authorId: IdentityId;
  body: string;
  sourceMessageId?: string | null;
  silent?: boolean;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
}

export interface IdentityPublic {
  id: IdentityId;
  tenantId?: TenantId | null;
  displayName: string;
  kind: IdentityKind;
  parentIdentityId?: IdentityId | null;
  avatarUrl?: string | null;
  location?: string | null;
  signature?: string | null;
  theme?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityPrivate extends IdentityPublic {
  username?: string | null;
  passwordHash?: string | null;
  privateEmail?: string | null;
}

export type Identity = IdentityPublic;
export interface ForumLastPost {
  postId: PostId;
  topicId: TopicId;
  topicTitle: string;
  authorId: IdentityId;
  authorName: string;
  createdAt: string;
}

export interface ForumStats {
  threadCount: number;
  postCount: number;
  lastPost: ForumLastPost | null;
}

export interface TopicStats {
  postCount: number;
  lastPostAuthorId: IdentityId | null;
  lastPostAuthorName: string | null;
  lastPostAt: string | null;
}
