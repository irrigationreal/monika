import type {
  AccessRuleAction,
  AccessRuleEffect,
  AccessRulePrincipalKind,
  AccessRuleScopeKind,
  ForumVisibility,
  RobotMode
} from '@irrigationreal/codex-forum-core';
import type { ForumThemeKey } from './themes';

export interface ForumLastPostDto {
  postId: string;
  topicId: string;
  topicTitle: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface RecentPostDto {
  postId: string;
  topicId: string;
  topicTitle: string;
  forumId: string;
  forumName: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface ForumLeaderDto {
  identityId: string;
  displayName: string;
  kind: 'human' | 'robot' | 'persona' | 'webhook' | 'system' | 'admin';
  avatarUrl: string | null;
  postCount: number;
}

export interface ForumLeadersResponseDto {
  leaders: ForumLeaderDto[];
}

export interface ModelInfoDto {
  id: string;
  family: string;
  label?: string | null;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  defaultReasoning?: string | null;
  contextWindowTokens?: number | null;
}

export interface ModelCatalogDto {
  items: ModelInfoDto[];
  updatedAt: string;
}

export interface ForumDto {
  id: string;
  tenantId?: string | null;
  parentForumId?: string | null;
  category?: string | null;
  name: string;
  description?: string | null;
  status: 'active' | 'archived';
  visibility: ForumVisibility;
  archivedAt?: string | null;
  threadCount: number;
  postCount: number;
  lastPost: ForumLastPostDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAuthorDto {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
}

export interface ChatCategoryDto {
  id: string;
  name: string;
  description?: string | null;
  visibility: ForumVisibility;
  roomCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRoomDto {
  id: string;
  categoryId: string;
  name: string;
  status: 'open' | 'locked' | 'archived';
  visibility: ForumVisibility;
  messageCount: number;
  lastMessageAt?: string | null;
  lastMessageAuthorName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDto {
  id: string;
  roomId: string;
  author: ChatAuthorDto;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  expiresAt?: string | null;
  attachments: AttachmentDto[];
}

export interface ChatCategoryListDto {
  rootForumId: string;
  items: ChatCategoryDto[];
}

export interface ChatRoomListDto {
  categoryId: string;
  items: ChatRoomDto[];
}

export interface ChatMessagePageDto {
  roomId: string;
  items: ChatMessageDto[];
  hasMore: boolean;
  nextBefore?: string | null;
  nextAfter?: string | null;
}

export interface ChatPresenceDto {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  joinedAt: string;
}

export interface ChatPresenceStateDto {
  roomId: string;
  members: ChatPresenceDto[];
}

export interface ChatPresenceEventDto {
  roomId: string;
  member: ChatPresenceDto;
}

export interface ChatTypingDto {
  roomId: string;
  identityId: string;
  displayName: string;
  isTyping: boolean;
}

export interface TopicDto {
  id: string;
  forumId: string;
  tenantId?: string | null;
  title: string;
  status: 'open' | 'locked' | 'archived';
  /**
   * Controls if/how the robot responds in this thread.
   * - auto: respond to every post (default)
   * - mention: respond only when @robot is mentioned
   * - off: never respond
   */
  robotMode?: RobotMode;
  tags: string[];
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  postCount?: number;
  lastPostAuthorId?: string | null;
  lastPostAuthorName?: string | null;
  lastPostAt?: string | null;
}

export interface TopicMoveDto {
  id: string;
  topicId: string;
  fromForumId: string;
  toForumId: string;
  movedBy: string;
  movedAt: string;
  markerPostId?: string | null;
  needsReprompt: boolean;
}

export interface PostDto {
  id: string;
  topicId: string;
  tenantId?: string | null;
  parentPostId?: string | null;
  authorId: string;
  body: string;
  sourceMessageId?: string | null;
  /**
   * True when the post was created with "no robot response".
   * Silent posts are still visible in the thread, but do not trigger a robot turn.
   */
  silent?: boolean;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  reactionCounts?: ReactionCountDto[];
}

export interface ReactionCountDto {
  emoji: string;
  count: number;
}

export interface AttachmentDto {
  id: string;
  postId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface UserFileDto {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ApiKeyDto {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ImpersonationTokenDto {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  impersonatedIdentityId: string;
  impersonatedDisplayName: string;
  impersonatedAvatarUrl: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface IdentityDto {
  id: string;
  tenantId?: string | null;
  displayName: string;
  kind: 'human' | 'robot' | 'persona' | 'webhook' | 'system' | 'admin';
  parentIdentityId?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  signature?: string | null;
  /**
   * Theme preference for this identity.
   *
   * Note: public profile endpoints may omit this field; `/auth/me` must include it
   * so the web UI can apply the user's preference on login.
   */
  theme?: ForumThemeKey | null;
  postCount?: number;
  rank?: string;
  joinDate?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public-facing profile information for an identity.
 *
 * Notes:
 * - This endpoint is intended for logged-in viewers.
 * - Theme is included for "old school" profile vibes (it is not considered private).
 */
export type UserProfileDto = IdentityDto;

export interface UserPostHistoryItemDto {
  postId: string;
  topicId: string;
  topicTitle: string;
  forumId: string;
  forumName: string;
  createdAt: string;
  /**
   * A short, plain-text summary of the post body for display in profile history.
   */
  excerpt: string;
}

export interface UserPostHistoryResponseDto {
  page: number;
  pageSize: number;
  total: number;
  items: UserPostHistoryItemDto[];
}

export interface RobotPersonaDto {
  key: string;
  forumId: string;
  displayName: string;
  description: string | null;
  accentColor: string | null;
  avatarUrl: string | null;
  signature: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRobotPersonaDto extends RobotPersonaDto {
  identityId: string;
  soul: string | null;
}

export interface AdminForumDto {
  id: string;
  parentForumId?: string | null;
  category?: string | null;
  name: string;
  description: string | null;
  cwd: string | null;
  prePrompt: string | null;
  status?: 'active' | 'archived';
  visibility: ForumVisibility;
  archivedAt?: string | null;
  topicCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccessRuleDto {
  id: string;
  scopeKind: AccessRuleScopeKind;
  scopeId: string;
  principalKind: AccessRulePrincipalKind;
  principalId?: string | null;
  action: AccessRuleAction;
  effect: AccessRuleEffect;
  createdAt: string;
}

export interface AdminUserDto {
  id: string;
  displayName: string;
  username: string | null;
  kind: IdentityDto['kind'];
  avatarUrl: string | null;
  createdAt: string;
}

export interface InviteDto {
  id: string;
  code: string;
  createdBy: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface ExternalRefDto {
  id: string;
  surfaceId: string;
  surfaceKind: 'discord' | 'slack' | 'matrix' | 'web' | 'system' | 'forum';
  externalId: string;
  kind: 'forum' | 'topic' | 'post' | 'identity' | 'attachment' | 'reaction' | 'other';
  scope?: string | null;
  scopeKind?: 'workspace' | 'server' | 'space' | 'channel' | 'thread' | 'forum' | 'topic' | 'other' | null;
  mappedForumId?: string | null;
  mappedTopicId?: string | null;
  mappedPostId?: string | null;
  mappedIdentityId?: string | null;
}

export interface PlanDto {
  id: string;
  content: string;
  summary?: string | null;
  parentPostId?: string | null;
  visibility: 'public' | 'internal' | 'private';
  createdAt: string;
  updatedAt: string;
}

export interface ToolRunDto {
  id: string;
  tool: string;
  parentPostId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  command?: string | null;
  filesTouched?: string[] | null;
  outputSummary?: string | null;
  redactionsApplied: boolean;
  visibility: 'public' | 'internal' | 'private';
}

export interface RobotStateDto {
  topicId: string;
  sessionId: string;
  activity: 'idle' | 'thinking' | 'running_tools' | 'waiting' | 'error';
  model?: string | null;
  reasoningEffort?: string | null;
  lastUpdatedAt: string;
  currentPlan?: PlanDto | null;
  recentToolRuns: ToolRunDto[];
}

export interface RobotJobDto {
  topicId: string;
  topicTitle?: string | null;
  topicStatus?: string | null;
  forumId?: string | null;
  forumName?: string | null;
  sessionId: string;
  codexThreadId?: string | null;
  agentThreadId?: string | null;
  agentBackend?: string | null;
  activity: RobotStateDto['activity'];
  model?: string | null;
  reasoningEffort?: string | null;
  lastUpdatedAt: string;
  /**
   * Present when the server knows there is an active turn to interrupt.
   * (Useful for deploy/pause decisions.)
   */
  activeTurnId?: string | null;
  /**
   * Best-effort signal for whether the robot backend reports the thread as loaded.
   */
  threadLoaded?: boolean | null;
}

export interface RobotQueueItemDto {
  position: number;
  queuedAt: string;
  topicId: string;
  topicTitle?: string | null;
  forumId?: string | null;
  forumName?: string | null;
  parentPostId?: string | null;
  sessionId: string;
}

export interface RobotDashboardDto {
  jobs: RobotJobDto[];
  queue: RobotQueueItemDto[];
  settings?: {
    maxConcurrentTurns: number;
    activeTurnsCount: number;
  };
}

export interface RobotSettingsDto {
  maxConcurrentTurns: number;
}

export interface TamperPluginDto {
  key: string;
  label: string;
  description?: string | null;
  stages: string[];
  defaultDirection?: 'inbound' | 'outbound' | 'both';
  defaultOnlyFirstMessage?: boolean;
  defaultConfig?: Record<string, unknown> | null;
}

export interface TamperConfigDto {
  id: string;
  forumId?: string | null;
  pluginKey: string;
  enabled: boolean;
  priority: number;
  direction?: 'inbound' | 'outbound' | 'both' | null;
  onlyFirstMessage?: boolean | null;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TamperTrailEntryDto {
  pluginKey: string;
  pluginPriority: number;
  stage: string;
  direction: string;
  durationMs: number;
  inputText: string;
  outputText: string;
  changed: boolean;
  error?: string | null;
  notes?: Record<string, unknown>;
}

export interface TamperTestResultDto {
  inputText: string;
  outputText: string;
  tampered: boolean;
  trail: TamperTrailEntryDto[];
}

export interface RobotAutomationDto {
  id: string;
  name: string;
  forumId?: string | null;
  prompt: string;
  enabled: boolean;
  worker: 'echs';
  model?: string | null;
  reasoningEffort?: string | null;
  runMode: 'manual' | 'interval';
  intervalMinutes?: number | null;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RobotAutomationRunDto {
  id: string;
  automationId: string;
  worker: 'echs';
  model?: string | null;
  reasoningEffort?: string | null;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  outputSummary?: string | null;
  lastMessage?: string | null;
  logPath?: string | null;
}

export interface TopicAutoRunDto {
  topicId: string;
  enabled: boolean;
  context?: string | null;
  worker: 'echs';
  model?: string | null;
  reasoningEffort?: string | null;
  maxReplies: number;
  replyCount: number;
  status: string;
  lastRunAt?: string | null;
  lastReplyAt?: string | null;
  lastSummary?: string | null;
  lastNotes?: string | null;
  lastError?: string | null;
  steerMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SessionDto {
  id: string;
  topicId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'paused' | 'completed' | 'error';
}

export interface SessionMessageDto {
  id: string;
  sessionId: string;
  role: 'system' | 'assistant' | 'user' | 'tool';
  content: string;
  createdAt: string;
  visibility: 'public' | 'internal' | 'private';
}

export interface SessionInspectorDto {
  session: SessionDto;
  messages: SessionMessageDto[];
  toolRuns: ToolRunDto[];
  plans: PlanDto[];
  artifacts: { id: string; kind: string; label: string; visibility: 'public' | 'internal' | 'private' }[];
}

export interface AdminDeployStatusDto {
  enabled: boolean;
  scriptPath?: string | null;
  logPath?: string | null;
  running?: boolean | null;
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  commitSha?: string | null;
  deployOnFinishRequestedAt?: string | null;
  deployOnFinishLastCheckedAt?: string | null;
  deployOnFinishLastError?: string | null;
}

export interface AdminDeployResponseDto {
  ok: boolean;
  startedAt?: string | null;
  logPath?: string | null;
}

export interface AdminDeployOnFinishResponseDto {
  ok: boolean;
  requestedAt?: string | null;
}

export interface AdminCancelDeployOnFinishResponseDto {
  ok: boolean;
}

export interface AuthIdentityDto {
  id: string;
  displayName: string;
  kind: IdentityDto['kind'];
  parentIdentityId?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  signature?: string | null;
  theme?: ForumThemeKey | null;
  /**
   * Whether a robot-only email address is set for this account.
   * The email address itself is never returned to the web client.
   */
  hasPrivateEmail?: boolean;
}

export interface AuthUserDto {
  identity: AuthIdentityDto | null;
}

export interface IdentityPermissionsDto {
  permissions: string[];
}

export interface LoginResponseDto {
  token: string | null;
  refreshToken?: string | null;
  identity?: AuthIdentityDto;
  message?: string;
}

export interface RegisterResponseDto {
  identity: AuthIdentityDto;
  verifyUrl?: string;
  expiresAt?: string;
  emailSent?: boolean;
  token?: string;
  refreshToken?: string;
}

export interface VerifyResponseDto {
  token: string;
  refreshToken?: string;
  identity: AuthIdentityDto;
}

export interface InviteInfoDto {
  code: string;
  valid: boolean;
  message?: string;
  remainingUses?: number;
  expiresAt?: string | null;
}

export interface UpdatePrivateEmailResponseDto {
  ok: boolean;
  hasPrivateEmail: boolean;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponseDto {
  ok: boolean;
}

export interface ApiKeyListResponseDto {
  items: ApiKeyDto[];
}

export interface ApiKeyCreateResponseDto {
  apiKey: ApiKeyDto;
  token: string;
}

export interface ImpersonationTokenListResponseDto {
  items: ImpersonationTokenDto[];
}

export interface ImpersonationTokenCreateResponseDto {
  impersonationToken: ImpersonationTokenDto;
  token: string;
}

export interface DiscordChannelMappingDto {
  channelId: string;
  forumId: string;
  channelName?: string | null;
}

export interface DiscordBridgeStatusDto {
  configured?: boolean;
  connected: boolean;
  guildId?: string;
  guildName?: string;
  channelMappings: DiscordChannelMappingDto[];
  error?: string;
  message?: string;
}

export interface MatrixRoomMappingDto {
  roomId: string;
  forumId: string;
  roomName?: string | null;
}

export interface MatrixBridgeStatusDto {
  configured?: boolean;
  connected: boolean;
  homeserverUrl?: string;
  userId?: string;
  roomMappings: MatrixRoomMappingDto[];
  error?: string;
  message?: string;
}

export interface SearchResultsDto {
  topics: TopicDto[];
  posts: PostDto[];
}

export interface AdminSkillAvailabilityDto {
  forumId: string;
  forumName: string;
  configScope: 'forum' | 'global';
  promptEnhancerEnabled: boolean;
  personas: Array<{ key: string }>;
}

export interface AdminSkillDto {
  id: string;
  key: string;
  title: string;
  scope: 'system' | 'user';
  root: string;
  path: string;
  bytes: number;
  updatedAt: string | null;
  excerpt: string | null;
  availableIn: AdminSkillAvailabilityDto[];
}

export interface AdminSkillRootDto {
  root: string;
  exists: boolean;
  skillCount: number;
  usedByForumIds: string[];
}

export interface AdminSkillListResponseDto {
  generatedAt: string;
  promptEnhancerEnabledByDefault: boolean;
  defaultSkillsRoot: string;
  roots: AdminSkillRootDto[];
  items: AdminSkillDto[];
}

export interface NotificationDto {
  id: string;
  identityId: string;
  type: string;
  actorId?: string | null;
  topicId?: string | null;
  postId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  readAt?: string | null;
}

export interface TopicUnreadDto {
  topicId: string;
  identityId: string;
  lastReadPostId?: string | null;
  lastReadAt?: string | null;
  lastPostId?: string | null;
  lastPostAt?: string | null;
  unreadCount: number;
}

export interface TopicSubscriptionDto {
  topicId: string;
  identityId: string;
  mode: 'watching' | 'muted' | 'off';
  createdAt: string;
  updatedAt: string;
}
