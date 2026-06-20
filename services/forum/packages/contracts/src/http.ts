import type {
  ExternalRefDto,
  ForumDto,
  IdentityDto,
  PostDto,
  RobotStateDto,
  SessionDto,
  SessionInspectorDto,
  TopicDto
} from './dto';
import type { ForumThemeKey } from './themes';
import type { PageResponse } from './pagination';

export interface CreateForumRequest {
  name: string;
  description?: string | null;
  parentForumId?: string | null;
  category?: string | null;
  visibility?: 'public' | 'members' | 'admin';
}

export interface ListForumsRequest {
  parentForumId?: string | null;
  status?: 'active' | 'archived';
  includeArchived?: boolean;
}

export interface CreateTopicRequest {
  title: string;
  body: string;
  model?: string | null;
  reasoningEffort?: string | null;
  /**
   * When true, the server will create the topic/post without dispatching a robot turn.
   * Call the post dispatch endpoint once attachments finish uploading.
   */
  attachmentsPending?: boolean;
  /**
   * Controls how (or if) the robot responds in the new thread.
   * - auto: respond to every post (default)
   * - mention: respond only when @robot is mentioned
   * - off: never respond
   */
  robotMode?: 'auto' | 'mention' | 'off';
  /**
   * When true, the forum will store the post but will not dispatch a robot turn for it.
   * A subsequent non-silent post will include these silent posts as catch-up context once.
   */
  silent?: boolean;
}

export interface CreatePostRequest {
  body: string;
  parentPostId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /**
   * When true, the server will create the post without dispatching a robot turn.
   * Call the post dispatch endpoint once attachments finish uploading.
   */
  attachmentsPending?: boolean;
  /**
   * When true, the forum will store the post but will not dispatch a robot turn for it.
   * A subsequent non-silent post will include these silent posts as catch-up context once.
   */
  silent?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  displayName: string;
  username?: string;
  password?: string;
  email?: string;
  inviteCode?: string;
}

export interface UpdatePrivateEmailRequest {
  emailAddress: string | null;
}

export interface CreateApiKeyRequest {
  label: string;
  scopes?: string[];
  expiresAt?: string | null;
}

export interface CreateImpersonationTokenRequest {
  label: string;
  displayName?: string;
  avatarUrl?: string | null;
  scopes?: string[];
  expiresAt?: string | null;
  impersonatedIdentityId?: string | null;
}

export interface UpdateIdentityRequest {
  displayName?: string;
  avatarUrl?: string | null;
  location?: string | null;
  signature?: string | null;
  theme?: ForumThemeKey | null;
}

export interface UpdateTopicStatusRequest {
  status: 'open' | 'locked' | 'archived';
}

export interface UpdateTopicTitleRequest {
  title: string;
}

export interface UpdateTopicTagsRequest {
  sticky?: boolean;
  tags?: string[];
}

export interface MoveTopicRequest {
  forumId: string;
  silent?: boolean | undefined;
}

export interface CreateInviteRequest {
  maxUses?: number;
  expiresInDays?: number;
}

export interface AttachmentChunkedStartRequest {
  filename: string;
  mimeType?: string;
  sizeBytes: number;
}

export interface CreateChatCategoryRequest {
  name: string;
  description?: string | null;
  visibility?: 'public' | 'members' | 'admin';
}

export interface CreateChatRoomRequest {
  categoryId: string;
  name: string;
  topic?: string | null;
}

export interface CreateChatMessageRequest {
  body: string;
  expiresInSeconds?: number;
}

export interface ChatTypingRequest {
  isTyping: boolean;
}

export interface DiscordMapChannelRequest {
  channelId: string;
  forumId?: string;
}

export interface DiscordSendRequest {
  threadId: string;
  content: string;
  authorName?: string;
}

export interface MatrixMapRoomRequest {
  roomId: string;
  forumId?: string;
}

export interface MatrixSendRequest {
  roomId: string;
  threadId?: string;
  content: string;
  authorName?: string;
}

export interface AdminCreateUserRequest {
  displayName: string;
  username: string;
  password: string;
  kind?: string;
}

export interface AdminUpdateUserRequest {
  displayName?: string;
  kind?: string;
  password?: string;
}

export interface AdminCreateForumRequest {
  name: string;
  description?: string | null;
  cwd?: string | null;
  prePrompt?: string | null;
  parentForumId?: string | null;
  category?: string | null;
  status?: 'active' | 'archived';
  visibility?: 'public' | 'members' | 'admin';
}

export interface AdminUpdateForumRequest {
  name?: string;
  description?: string | null;
  cwd?: string | null;
  prePrompt?: string | null;
  parentForumId?: string | null;
  category?: string | null;
  status?: 'active' | 'archived';
  visibility?: 'public' | 'members' | 'admin';
  archivedAt?: string | null;
}

export interface AdminAccessRuleRequest {
  principalKind: 'all' | 'logged_in' | 'identity' | 'role';
  principalId?: string | null;
  action: 'view' | 'post' | 'topic.create' | 'moderate';
  effect: 'allow' | 'deny';
}

export interface AdminMoveTopicRequest {
  forumId: string;
  silent?: boolean | undefined;
}

export interface AdminCreatePersonaRequest {
  key: string;
  displayName: string;
  description?: string | null;
  accentColor?: string | null;
  avatarUrl?: string | null;
  signature?: string | null;
  soul?: string | null;
}

export interface AdminUpdatePersonaRequest {
  displayName?: string;
  description?: string | null;
  accentColor?: string | null;
  avatarUrl?: string | null;
  signature?: string | null;
  soul?: string | null;
}

export interface AdminCreateTamperRequest {
  forumId?: string | null;
  pluginKey: string;
  enabled?: boolean;
  priority?: number;
  direction?: string | null;
  onlyFirstMessage?: boolean | null;
  config?: Record<string, unknown> | null;
}

export interface AdminUpdateTamperRequest {
  forumId?: string | null;
  enabled?: boolean;
  priority?: number;
  direction?: string | null;
  onlyFirstMessage?: boolean | null;
  config?: Record<string, unknown> | null;
}

export interface AdminTestTamperRequest {
  text: string;
  forumId?: string | null;
  stage?: string;
  direction?: string;
  pluginKey?: string | null;
  pluginConfig?: Record<string, unknown> | null;
  onlyPlugin?: boolean;
  isFirstMessage?: boolean;
}

export interface AdminCreateRobotAutomationRequest {
  name: string;
  forumId?: string | null;
  prompt: string;
  enabled?: boolean;
  worker?: 'echs';
  model?: string | null;
  reasoningEffort?: string | null;
  runMode?: 'manual' | 'interval';
  intervalMinutes?: number | null;
}

export interface AdminUpdateRobotAutomationRequest {
  name?: string;
  forumId?: string | null;
  prompt?: string;
  enabled?: boolean;
  worker?: 'echs';
  model?: string | null;
  reasoningEffort?: string | null;
  runMode?: 'manual' | 'interval';
  intervalMinutes?: number | null;
}

export interface AdminUpdateRobotSettingsRequest {
  maxConcurrentTurns?: number;
}

export interface ForumApi {
  listForums(req?: ListForumsRequest): Promise<ForumDto[]>;
  createForum(req: CreateForumRequest): Promise<ForumDto>;
  listTopics(forumId: string, page?: number, pageSize?: number): Promise<PageResponse<TopicDto>>;
  createTopic(forumId: string, req: CreateTopicRequest): Promise<TopicDto>;
  getTopic(topicId: string): Promise<TopicDto>;
  listPosts(topicId: string, page?: number, pageSize?: number): Promise<PageResponse<PostDto>>;
  createPost(topicId: string, req: CreatePostRequest): Promise<PostDto>;
  getRobotState(topicId: string): Promise<RobotStateDto>;
  listIdentities(topicId: string, page?: number, pageSize?: number): Promise<PageResponse<IdentityDto>>;
  getIdentity(identityId: string): Promise<IdentityDto>;
  listExternalRefs(topicId: string): Promise<ExternalRefDto[]>;
  getSessionByTopic(topicId: string): Promise<SessionDto | null>;
  getSession(sessionId: string): Promise<SessionDto | null>;
  getSessionInspector(sessionId: string): Promise<SessionInspectorDto>;
}

export interface ForumStreamApi {
  subscribeRobotState(topicId: string): AsyncIterable<RobotStateDto>;
}
