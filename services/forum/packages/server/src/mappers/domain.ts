import type {
  Forum as CoreForum,
  Post as CorePost,
  Topic as CoreTopic,
  ForumLastPost,
  Identity,
  RobotMode,
} from '@irrigationreal/codex-forum-core';

export interface TopicReadModel extends CoreTopic {
  robotMode: RobotMode | null;
  createdByName?: string | null;
  postCount?: number;
  lastPostAuthorId?: string | null;
  lastPostAuthorName?: string | null;
  lastPostAt?: string | null;
}

export interface ForumReadModel extends CoreForum {
  threadCount?: number;
  postCount?: number;
  lastPost?: ForumLastPost | null;
}

export interface ReactionCount {
  emoji: string;
  count: number;
}

export interface PostReadModel extends CorePost {
  silent: boolean;
  reactionCounts?: ReactionCount[];
}

export interface Attachment {
  id: string;
  postId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface IdentityReadModel extends Identity {
  postCount?: number;
  rank?: string;
  joinDate?: string;
  hasPrivateEmail?: boolean;
}

export interface UserPostHistoryItem {
  postId: string;
  topicId: string;
  topicTitle: string;
  forumId: string;
  forumName: string;
  createdAt: string;
  excerpt: string;
}

export interface RobotPersona {
  key: string;
  forumId: string;
  identityId: string;
  displayName: string;
  description: string | null;
  accentColor: string | null;
  avatarUrl: string | null;
  signature: string | null;
  soul: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  content: string;
  summary: string | null;
  parentPostId: string | null;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRun {
  id: string;
  tool: string;
  parentPostId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  command: string | null;
  filesTouched: string[] | null;
  outputSummary: string | null;
  redactionsApplied: boolean;
  visibility: string;
}

export interface TopicAutoRun {
  topicId: string;
  enabled: boolean;
  context: string | null;
  worker: string;
  model: string | null;
  reasoningEffort: string | null;
  maxReplies: number;
  replyCount: number;
  status: string;
  lastRunAt: string | null;
  lastReplyAt: string | null;
  lastSummary: string | null;
  lastNotes: string | null;
  lastError: string | null;
  steerMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Session {
  id: string;
  topicId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  visibility: string;
}

export interface SessionInspector {
  session: Session;
  messages: SessionMessage[];
  toolRuns: ToolRun[];
  plans: Plan[];
  artifacts: { id: string; kind: string; label: string; visibility: string }[];
}

export interface Invite {
  id: string;
  code: string;
  createdBy: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}
