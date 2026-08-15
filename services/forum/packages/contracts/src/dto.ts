import type {
  AccessRuleAction,
  AccessRuleEffect,
  AccessRulePrincipalKind,
  AccessRuleScopeKind,
  AnalyticsAudience,
  AnalyticsBucket,
  ForkOperationStatus,
  ForumVisibility,
  MessageDraftContext,
  MessageTemplateContext,
  MessageTemplateForumScope,
  MessageTemplateScope,
  NotepadContentFormat,
  NotepadDraftOptions,
  RobotActivity,
  RobotMode,
  WebAuthnCredential,
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
  supportedThinkingLevels?: string[];
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

export interface TopicLineageDto {
  kind: 'handoff' | 'fork' | 'delegate' | 'sleep' | 'parent';
  parentTopicId?: string | null;
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
  /** Shared, default-off policy for Pi native parent-session auto-compaction. */
  autoCompactEnabled: boolean;
  autoCompactRevision: number;
  tags: string[];
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  postCount?: number;
  lastPostAuthorId?: string | null;
  lastPostAuthorName?: string | null;
  lastPostAt?: string | null;
  /** Public-safe semantic lineage. Canonical Pi identifiers and paths are admin-only session diagnostics. */
  lineage?: TopicLineageDto | null;
}

export interface TopicMoveDto {
  id: string;
  topicId: string;
  fromForumId: string;
  toForumId: string;
  movedBy: string;
  movedAt: string;
  markerPostId?: string | null | undefined;
  needsReprompt: boolean;
  silent: boolean;
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
  /** True only for an explicitly projected subagent/follow-up assistant utterance. */
  followUp?: boolean;
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
  deletedAt?: string | null;
}

export interface TopicAttachmentsDto {
  itemsByPostId: Record<string, AttachmentDto[]>;
}

export interface UserFilePostAssociationDto {
  id: string;
  postId: string;
  topicId: string;
  topicTitle: string;
  postNumber: number;
  filename: string;
  mimeType: string;
  deletedAt: string | null;
}

export interface UserFileDto {
  id: string;
  ownerId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  standalone: boolean;
  visibility: 'private' | 'members' | 'public' | null;
  expiresAt: string | null;
  revision: number;
  blobState: 'staging' | 'ready' | 'gc_pending' | 'missing';
  associations: UserFilePostAssociationDto[];
  createdAt: string;
  updatedAt: string;
  deduplicated?: boolean;
}

export interface UserFileListResponseDto {
  items: UserFileDto[];
  nextCursor: string | null;
}

export interface MessageDraftDto {
  id: string;
  context: MessageDraftContext;
  forumId: string | null;
  topicId: string | null;
  title: string | null;
  body: string;
  options: NotepadDraftOptions | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  destinationName: string | null;
  canContinue: boolean;
}

export interface MessageDraftResponseDto {
  draft: MessageDraftDto | null;
}
export interface MessageDraftListResponseDto {
  drafts: MessageDraftDto[];
}

export interface NotepadEntryDto {
  id: string;
  contentFormat: NotepadContentFormat;
  title: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
export interface NotepadTagDto {
  tag: string;
  count: number;
}
export interface NotepadListResponseDto {
  entries: NotepadEntryDto[];
  tags: NotepadTagDto[];
  nextCursor: string | null;
}
export interface NotepadEntryResponseDto {
  entry: NotepadEntryDto;
}

export interface MessageTemplateDto {
  id: string;
  scope: MessageTemplateScope;
  name: string;
  category: string | null;
  body: string;
  threadTitle: string | null;
  forumScope: MessageTemplateForumScope;
  forumIds: string[];
  contexts: MessageTemplateContext[];
  enabled: boolean;
  sortOrder: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplateListResponseDto {
  templates: MessageTemplateDto[];
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
  reasoningCheckpoints?: number[] | null;
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

export interface TopicOperationalEventDto {
  id: string;
  topicId: string;
  anchorPostId: string | null;
  type: 'turn_error' | 'compaction';
  category: 'assistant' | 'maintenance';
  status: 'failed' | 'succeeded';
  summary: string;
  /** Authenticated viewers only; null is a deliberate public redaction. */
  detail: Record<string, unknown> | null;
  sourceKind: 'echs_turn' | 'compaction_operation';
  sourceId: string;
  createdAt: string;
}

export interface CreateCompactionRequestDto {
  operationId: string;
  confirmation: 'COMPACT';
  customInstructions: string | null;
  recoveryPrompt: string;
}

export interface CompactionOperationDto {
  id: string;
  topicId: string;
  sessionId: string;
  initiatedBy: string;
  expectedLeafId: string;
  customInstructions: string | null;
  recoveryPrompt: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  eventId: string | null;
  recoveryPostId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CompactionCheckpointDispatchDto {
  status: 'pending' | 'dispatching' | 'dispatched' | 'failed' | 'superseded' | 'abandoned';
  errorMessage: string | null;
}

export interface TopicCompactionStateDto {
  active: CompactionOperationDto | null;
  latest: CompactionOperationDto | null;
  checkpointDispatch: CompactionCheckpointDispatchDto | null;
}

export interface ForkBoundaryDto {
  postId: string;
  postNumber: number;
  excerpt: string;
  body: string;
}

export interface CreateForkRequestDto {
  operationId: string;
  boundaryPostId: string;
  title: string;
  openingBody: string;
}

export interface ForkOperationDto {
  id: string;
  sourceTopicId: string;
  boundaryPostId: string;
  status: ForkOperationStatus;
  childTopicId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TopicForkStateDto {
  active: ForkOperationDto | null;
  latest: ForkOperationDto | null;
}

/** Best available Pi context-usage snapshot for one canonical session. */
export interface SessionContextDto {
  model: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  contextWindowTokens: number | null;
  usedTokens: number | null;
  remainingTokens: number | null;
  percent: number | null;
  exact: boolean;
  source: string;
  asOfPiMessageId: string | null;
  leafEntryId?: string | null;
}

export interface RobotStateDto {
  topicId: string;
  sessionId: string;
  activity: RobotActivity;
  model?: string | null;
  reasoningEffort?: string | null;
  lastUpdatedAt: string;
  lastTurnError?: {
    message: string;
    at: string;
    postId?: string | null;
    turnId?: string | null;
  } | null;
  currentPlan?: PlanDto | null;
  /** Initial context snapshot. Live updates arrive independently over SSE. */
  context?: SessionContextDto | null;
  recentToolRuns: ToolRunDto[];
}

export interface RobotStopResultDto {
  ok: boolean;
  operationId: string;
  generation: number;
  state: 'stopping' | 'stopped' | 'uncertain';
  targets: number;
  unresolvedCount: number;
  effectsUnknownCount: number;
  errorCount: number;
  message: string;
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

export interface RobotSubagentRunDto {
  runId: string;
  state: string;
  executionState: 'active' | 'terminal' | 'interrupted' | 'uncertain' | 'quarantined';
  outcomeState?: string | null;
  effectsState?: 'none' | 'confirmed' | 'unknown' | null;
  deliveryState?: string | null;
  executionTarget?: { kind: 'local' } | { kind: 'ssh'; name: string } | null;
  blocking: boolean;
  reason?: string | null;
  parentSessionId?: string | null;
  topicId?: string | null;
  topicTitle?: string | null;
  postId?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
}

export interface RobotDashboardDto {
  jobs: RobotJobDto[];
  queue: RobotQueueItemDto[];
  subagents?: {
    activeCount: number;
    uncertainCount: number;
    effectsUnknownCount: number;
    runs: RobotSubagentRunDto[];
    groups: {
      blockers: RobotSubagentRunDto[];
      pendingDelivery: RobotSubagentRunDto[];
      history: RobotSubagentRunDto[];
    };
    omitted: number;
    blockerCount: number;
    omittedBlockerCount: number;
    available: boolean;
    error?: string | null;
    retention?: {
      available: boolean;
      generatedAt?: string | null;
      retentionDays: number;
      counts: { protected: number; waiting: number; eligible: number; compacted: number; error: number };
      trackedRemovableBytes: number;
      eligibleBytes: number;
      omitted: number;
      running: boolean;
      lastError?: string | null;
    };
  };
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

export interface PiSessionDiagnosticsDto {
  id: string;
  path: string;
  cwd?: string | null;
  parentId?: string | null;
  parentPath?: string | null;
  lineageKind?: string | null;
  lineageSource?: string | null;
  importedAt: string;
  lastImportRunId?: string | null;
}

export interface SessionDto {
  id: string;
  topicId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'paused' | 'completed' | 'error';
  /** Canonical Pi storage diagnostics. Present only on admin-authorized session endpoints. */
  piSession?: PiSessionDiagnosticsDto | null;
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

export interface PiSyncAnomalyDto {
  id: string;
  piSessionId: string;
  piMessageId: string;
  topicId: string;
  sessionId: string;
  topicTitle: string | null;
  role: string | null;
  status: string;
  reason: string;
  preview: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string | null;
  nextRetryAt: string | null;
  retryCount: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  postId: string | null;
}

export interface PiSyncHealthDto {
  enabled: boolean;
  running: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunError: string | null;
  lastRunStats: { sessionsChecked: number; postsImported: number; anomaliesProcessed: number } | null;
  counts: Record<string, number>;
  anomalies: PiSyncAnomalyDto[];
}

export interface PiSyncRunResponseDto {
  ok: boolean;
  message: string;
  sessionsChecked: number;
  postsImported: number;
  anomaliesProcessed: number;
}

export interface PiSyncBackfillResponseDto {
  ok: boolean;
  postId?: string;
  message: string;
}

export interface AdminCancelDeployOnFinishResponseDto {
  ok: boolean;
}

export interface AuthIdentityDto {
  id: string;
  displayName: string;
  username?: string | null;
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
  hasPassword?: boolean;
  /** Private account preference; returned only from authenticated self endpoints. */
  quickReplyDockedByDefault?: boolean;
}

export const RegistrationModeValues = ['disabled', 'invite-only', 'public'] as const;
export type RegistrationMode = (typeof RegistrationModeValues)[number];

export interface RegistrationModeDto {
  mode: RegistrationMode;
  registrationEnabled: boolean;
  inviteRegistrationEnabled: boolean;
  publicRegistrationEnabled: boolean;
  passwordLoginEnabled: boolean;
}

export interface AuthUserDto {
  identity: AuthIdentityDto | null;
}

export interface IdentityPermissionsDto {
  permissions: string[];
}

export interface LoginResponseDto {
  identity?: AuthIdentityDto;
  message?: string;
}

export interface RegisterResponseDto {
  identity: AuthIdentityDto;
  verifyUrl?: string;
  expiresAt?: string;
  emailSent?: boolean;
}

export interface VerifyResponseDto {
  identity: AuthIdentityDto;
}

export interface WebAuthnCredentialDto {
  id: string;
  name: string;
  transports: string[];
  deviceType: WebAuthnCredential['deviceType'];
  backedUp: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface WebAuthnOptionsResponseDto {
  challengeId: string;
  options: Record<string, unknown>;
}

export interface WebAuthnCredentialListResponseDto {
  items: WebAuthnCredentialDto[];
}

export interface WebAuthnLoginResponseDto {
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

export interface UpdateQuickReplyPreferenceResponseDto {
  ok: boolean;
  quickReplyDockedByDefault: boolean;
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
export type AnalyticsBucketDto = AnalyticsBucket;

export interface AnalyticsForumOptionDto {
  id: string;
  name: string;
}

export interface AnalyticsVocabularyTermDto {
  term: string;
  score: number;
  count: number;
  documentCount: number;
}

export interface AnalyticsVocabularyGroupDto {
  forumId: string;
  forumName: string;
  audience: AnalyticsAudience;
  postCount: number;
  terms: AnalyticsVocabularyTermDto[];
}

export interface AnalyticsUsageModelDto {
  vendor: string;
  model: string;
  responses: number;
  totalTokens: number;
  medianTokens: number | null;
}

export interface AnalyticsToolDto {
  operation: string;
  backend: string;
  calls: number;
  failures: number;
  failureRate: number;
  outcomes: Record<string, number>;
}

export interface AnalyticsErrorClusterDto {
  source: 'tool' | 'provider' | 'subagent';
  category: string;
  operation?: string | null;
  affectedTurns: number;
}

export interface AnalyticsDelegationBreakdownDto {
  profile: string;
  mode: string;
  successful: number;
  unsuccessful: number;
  unsuccessfulRate: number | null;
}

export interface AnalyticsModelUsagePointDto {
  bucket: string;
  bucketEnd: string;
  observedFrom: string;
  observedTo: string;
  isPartial: boolean;
  vendor: string;
  responses: number;
  totalTokens: number;
}

export interface AnalyticsRuntimeMetricsDto {
  generatedAt: string | null;
  build: { commit: string | null; createdAt: string | null };
  coverage: Record<string, number>;
  usage: {
    successfulResponses: number;
    medianTokens: number | null;
    byModel: AnalyticsUsageModelDto[];
  };
  tools: {
    worst: AnalyticsToolDto | null;
    rows: AnalyticsToolDto[];
  };
  errors: {
    top: AnalyticsErrorClusterDto | null;
    rows: AnalyticsErrorClusterDto[];
  };
  waiting: {
    count: number;
    p95Ms: number | null;
    excluded: number;
  };
  delegation: {
    successful: number;
    unsuccessful: number;
    unsuccessfulRate: number | null;
    unknown: number;
    byProfileMode: AnalyticsDelegationBreakdownDto[];
  };
  modelUsageOverTime: AnalyticsModelUsagePointDto[];
}

export interface AdminAnalyticsDto {
  generatedAt: string;
  window: { from: string; to: string; bucket: AnalyticsBucketDto };
  selectedForumId?: string | null;
  forums: AnalyticsForumOptionDto[];
  vocabulary: {
    algorithmVersion: 1;
    groups: AnalyticsVocabularyGroupDto[];
  };
  runtime: {
    available: boolean;
    warning?: string | null;
    metrics?: AnalyticsRuntimeMetricsDto | null;
  };
}
