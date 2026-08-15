import { z } from 'zod';

import {
  AccessRuleActionValues,
  AccessRuleEffectValues,
  AccessRulePrincipalKindValues,
  AccessRuleScopeKindValues,
  AnalyticsAudienceValues,
  AnalyticsBucketValues,
  ForumVisibilityValues,
  MessageDraftContextValues,
  NotepadContentFormatValues,
  NotepadExpirationPresetValues,
  MessageTemplateContextValues,
  MessageTemplateForumScopeValues,
  MessageTemplateScopeValues,
  RobotModeValues,
} from '@irrigationreal/codex-forum-core';

import { RegistrationModeValues } from './dto';
import { PageRequestSchema, PageResponseSchema } from './pagination';
import { ForumThemeKeySchema } from './themes';

import type {
  AccessRuleDto,
  AdminAnalyticsDto,
  AdminCancelDeployOnFinishResponseDto,
  AdminDeployOnFinishResponseDto,
  AdminDeployResponseDto,
  AdminDeployStatusDto,
  AdminForumDto,
  AdminRobotPersonaDto,
  AdminSkillAvailabilityDto,
  AdminSkillDto,
  AdminSkillListResponseDto,
  AdminSkillRootDto,
  AdminUserDto,
  ApiKeyCreateResponseDto,
  ApiKeyDto,
  ApiKeyListResponseDto,
  AttachmentDto,
  AuthIdentityDto,
  AuthUserDto,
  ChatAuthorDto,
  ChatCategoryDto,
  ChatCategoryListDto,
  ChatMessageDto,
  ChatPresenceDto,
  ChatPresenceEventDto,
  ChatPresenceStateDto,
  ChatRoomDto,
  ChatRoomListDto,
  ChatTypingDto,
  CompactionOperationDto,
  TopicCompactionStateDto,
  CreateCompactionRequestDto,
  CreateForkRequestDto,
  DiscordBridgeStatusDto,
  DiscordChannelMappingDto,
  ExternalRefDto,
  ForkBoundaryDto,
  ForkOperationDto,
  TopicForkStateDto,
  ForumDto,
  ForumLastPostDto,
  IdentityDto,
  IdentityPermissionsDto,
  ImpersonationTokenCreateResponseDto,
  ImpersonationTokenDto,
  ImpersonationTokenListResponseDto,
  InviteDto,
  InviteInfoDto,
  LoginResponseDto,
  MatrixBridgeStatusDto,
  MatrixRoomMappingDto,
  MessageDraftDto,
  MessageDraftListResponseDto,
  MessageDraftResponseDto,
  NotepadEntryDto,
  NotepadEntryResponseDto,
  NotepadListResponseDto,
  MessageTemplateDto,
  MessageTemplateListResponseDto,
  ModelCatalogDto,
  ModelInfoDto,
  NotificationDto,
  PiSessionDiagnosticsDto,
  PlanDto,
  PostDto,
  ReactionCountDto,
  RecentPostDto,
  RegisterResponseDto,
  RegistrationModeDto,
  RobotAutomationDto,
  RobotAutomationRunDto,
  RobotDashboardDto,
  RobotJobDto,
  RobotPersonaDto,
  RobotQueueItemDto,
  RobotSettingsDto,
  RobotStateDto,
  RobotStopResultDto,
  RobotSubagentRunDto,
  SearchResultsDto,
  SessionDto,
  SessionInspectorDto,
  SessionMessageDto,
  TamperConfigDto,
  TamperPluginDto,
  TamperTestResultDto,
  TamperTrailEntryDto,
  ToolRunDto,
  TopicAttachmentsDto,
  TopicAutoRunDto,
  TopicDto,
  TopicLineageDto,
  TopicMoveDto,
  TopicOperationalEventDto,
  TopicSubscriptionDto,
  TopicUnreadDto,
  UpdatePrivateEmailResponseDto,
  UpdateQuickReplyPreferenceResponseDto,
  UserFileDto,
  UserPostHistoryItemDto,
  UserPostHistoryResponseDto,
  UserProfileDto,
  VerifyResponseDto,
} from './dto';
import type {
  AdminAccessRuleRequest,
  AdminCreateForumRequest,
  AdminCreatePersonaRequest,
  AdminCreateRobotAutomationRequest,
  AdminCreateTamperRequest,
  AdminCreateUserRequest,
  AdminMoveTopicRequest,
  AdminTestTamperRequest,
  AdminUpdateForumRequest,
  AdminUpdatePersonaRequest,
  AdminUpdateRobotAutomationRequest,
  AdminUpdateRobotSettingsRequest,
  AdminUpdateTamperRequest,
  AdminUpdateUserRequest,
  AttachmentChunkedStartRequest,
  ChatTypingRequest,
  CreateApiKeyRequest,
  CreateChatCategoryRequest,
  CreateChatMessageRequest,
  CreateChatRoomRequest,
  CreateForumRequest,
  CreateImpersonationTokenRequest,
  CreateInviteRequest,
  CreatePostRequest,
  CreateTopicRequest,
  DiscordMapChannelRequest,
  DiscordSendRequest,
  ListForumsRequest,
  LoginRequest,
  MatrixMapRoomRequest,
  MatrixSendRequest,
  MessageDraftWriteRequest,
  NotepadEntryUpdateRequest,
  NotepadEntryWriteRequest,
  MessageTemplateReorderRequest,
  MessageTemplateUpdateRequest,
  MessageTemplateWriteRequest,
  MoveTopicRequest,
  RegisterRequest,
  UpdateIdentityRequest,
  UpdatePrivateEmailRequest,
  UpdateQuickReplyPreferenceRequest,
  UpdateTopicStatusRequest,
  UpdateTopicTagsRequest,
  UpdateTopicTitleRequest,
} from './http';
import type { PageRequest, PageResponse } from './pagination';

const nullableString = z.string().nullable();
const optionalNullableString = z.string().nullable().optional();
const optionalNullableStringNoUndefined = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .pipe(z.string().nullable());

export const ForumStatusSchema = z.enum(['active', 'archived']);
export const ForumVisibilitySchema = z.enum(ForumVisibilityValues);
export const TopicStatusSchema = z.enum(['open', 'locked', 'archived']);
export const RobotModeSchema = z.enum(RobotModeValues);
export const IdentityKindSchema = z.enum(['human', 'robot', 'persona', 'webhook', 'system', 'admin']);
export const AccessRuleScopeKindSchema = z.enum(AccessRuleScopeKindValues);
export const AccessRulePrincipalKindSchema = z.enum(AccessRulePrincipalKindValues);
export const AccessRuleActionSchema = z.enum(AccessRuleActionValues);
export const AccessRuleEffectSchema = z.enum(AccessRuleEffectValues);
export const PlanVisibilitySchema = z.enum(['public', 'internal', 'private']);
export const ToolRunVisibilitySchema = z.enum(['public', 'internal', 'private']);
export const RobotActivitySchema = z.enum(['idle', 'thinking', 'running_tools', 'waiting', 'stopping', 'stopped', 'uncertain', 'error']);
export const RobotAutomationWorkerSchema = z.enum(['echs']);
export const RobotAutomationRunModeSchema = z.enum(['manual', 'interval']);
export const TopicAutoRunStatusSchema = z.enum(['idle', 'running', 'stopped', 'error']);
export const RegistrationModeSchema = z.enum(RegistrationModeValues);

export const ForumLastPostDtoSchema: z.ZodType<ForumLastPostDto> = z.object({
  postId: z.string(),
  topicId: z.string(),
  topicTitle: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});

export const RecentPostDtoSchema: z.ZodType<RecentPostDto> = z.object({
  postId: z.string(),
  topicId: z.string(),
  topicTitle: z.string(),
  forumId: z.string(),
  forumName: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const ModelInfoDtoSchema: z.ZodType<ModelInfoDto> = z.object({
  id: z.string(),
  family: z.string(),
  label: optionalNullableString,
  supportsReasoning: z.boolean().optional(),
  supportedThinkingLevels: z.array(z.string()).optional(),
  supportsTools: z.boolean().optional(),
  defaultReasoning: optionalNullableString,
  contextWindowTokens: z.number().nullable().optional(),
});

export const ModelCatalogDtoSchema: z.ZodType<ModelCatalogDto> = z.object({
  items: z.array(ModelInfoDtoSchema),
  updatedAt: z.string(),
});

export const ForumDtoSchema: z.ZodType<ForumDto> = z.object({
  id: z.string(),
  tenantId: optionalNullableString,
  parentForumId: optionalNullableString,
  category: optionalNullableString,
  name: z.string(),
  description: optionalNullableString,
  status: ForumStatusSchema,
  visibility: ForumVisibilitySchema,
  archivedAt: optionalNullableString,
  threadCount: z.number(),
  postCount: z.number(),
  lastPost: ForumLastPostDtoSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TopicLineageDtoSchema: z.ZodType<TopicLineageDto> = z.object({
  kind: z.enum(['handoff', 'delegate', 'sleep', 'parent']),
  parentTopicId: optionalNullableString,
});

export const TopicDtoSchema: z.ZodType<TopicDto> = z.object({
  id: z.string(),
  forumId: z.string(),
  tenantId: optionalNullableString,
  title: z.string(),
  status: TopicStatusSchema,
  robotMode: RobotModeSchema.optional(),
  autoCompactEnabled: z.boolean(),
  autoCompactRevision: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  createdBy: z.string(),
  createdByName: optionalNullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
  postCount: z.number().optional(),
  lastPostAuthorId: optionalNullableString,
  lastPostAuthorName: optionalNullableString,
  lastPostAt: optionalNullableString,
  lineage: TopicLineageDtoSchema.nullable().optional(),
});

export const TopicMoveDtoSchema: z.ZodType<TopicMoveDto> = z.object({
  id: z.string(),
  topicId: z.string(),
  fromForumId: z.string(),
  toForumId: z.string(),
  movedBy: z.string(),
  movedAt: z.string(),
  markerPostId: optionalNullableString,
  needsReprompt: z.boolean(),
  silent: z.boolean(),
});

export const ReactionCountDtoSchema: z.ZodType<ReactionCountDto> = z.object({
  emoji: z.string(),
  count: z.number(),
});

export const PostDtoSchema: z.ZodType<PostDto> = z.object({
  id: z.string(),
  topicId: z.string(),
  tenantId: optionalNullableString,
  parentPostId: optionalNullableString,
  authorId: z.string(),
  body: z.string(),
  sourceMessageId: optionalNullableString,
  silent: z.boolean().optional(),
  followUp: z.boolean().optional(),
  createdAt: z.string(),
  editedAt: optionalNullableString,
  deletedAt: optionalNullableString,
  reactionCounts: z.array(ReactionCountDtoSchema).optional(),
});

export const AttachmentDtoSchema: z.ZodType<AttachmentDto> = z.object({
  id: z.string(),
  postId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});

export const TopicAttachmentsDtoSchema: z.ZodType<TopicAttachmentsDto> = z.object({
  itemsByPostId: z.record(z.string(), z.array(AttachmentDtoSchema)),
});

export const ChatAuthorDtoSchema: z.ZodType<ChatAuthorDto> = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: optionalNullableString,
});

export const ChatCategoryDtoSchema: z.ZodType<ChatCategoryDto> = z.object({
  id: z.string(),
  name: z.string(),
  description: optionalNullableString,
  visibility: ForumVisibilitySchema,
  roomCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ChatRoomDtoSchema: z.ZodType<ChatRoomDto> = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  status: TopicStatusSchema,
  visibility: ForumVisibilitySchema,
  messageCount: z.number(),
  lastMessageAt: optionalNullableString,
  lastMessageAuthorName: optionalNullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ChatMessageDtoSchema: z.ZodType<ChatMessageDto> = z.object({
  id: z.string(),
  roomId: z.string(),
  author: ChatAuthorDtoSchema,
  body: z.string(),
  createdAt: z.string(),
  editedAt: optionalNullableString,
  expiresAt: optionalNullableString,
  attachments: z.array(AttachmentDtoSchema),
});

export const ChatCategoryListDtoSchema: z.ZodType<ChatCategoryListDto> = z.object({
  rootForumId: z.string(),
  items: z.array(ChatCategoryDtoSchema),
});

export const ChatRoomListDtoSchema: z.ZodType<ChatRoomListDto> = z.object({
  categoryId: z.string(),
  items: z.array(ChatRoomDtoSchema),
});

export const ChatMessagePageDtoSchema = z.object({
  roomId: z.string(),
  items: z.array(ChatMessageDtoSchema),
  hasMore: z.boolean(),
  nextBefore: optionalNullableStringNoUndefined,
  nextAfter: optionalNullableString.optional(),
});

export const ChatPresenceDtoSchema: z.ZodType<ChatPresenceDto> = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: optionalNullableString,
  joinedAt: z.string(),
});

export const ChatPresenceStateDtoSchema: z.ZodType<ChatPresenceStateDto> = z.object({
  roomId: z.string(),
  members: z.array(ChatPresenceDtoSchema),
});

export const ChatPresenceEventDtoSchema: z.ZodType<ChatPresenceEventDto> = z.object({
  roomId: z.string(),
  member: ChatPresenceDtoSchema,
});

export const ChatTypingDtoSchema: z.ZodType<ChatTypingDto> = z.object({
  roomId: z.string(),
  identityId: z.string(),
  displayName: z.string(),
  isTyping: z.boolean(),
});

export const UserFileDtoSchema: z.ZodType<UserFileDto> = z.object({
  id: z.string(),
  ownerId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});

export const ApiKeyDtoSchema: z.ZodType<ApiKeyDto> = z.object({
  id: z.string(),
  label: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: nullableString,
  expiresAt: nullableString,
  createdAt: z.string(),
  revokedAt: nullableString,
});

export const ImpersonationTokenDtoSchema: z.ZodType<ImpersonationTokenDto> = z.object({
  id: z.string(),
  label: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  impersonatedIdentityId: z.string(),
  impersonatedDisplayName: z.string(),
  impersonatedAvatarUrl: nullableString,
  lastUsedAt: nullableString,
  expiresAt: nullableString,
  createdAt: z.string(),
  revokedAt: nullableString,
});

export const IdentityDtoSchema: z.ZodType<IdentityDto> = z.object({
  id: z.string(),
  tenantId: optionalNullableString,
  displayName: z.string(),
  kind: IdentityKindSchema,
  parentIdentityId: optionalNullableString,
  avatarUrl: optionalNullableString,
  location: optionalNullableString,
  signature: optionalNullableString,
  theme: ForumThemeKeySchema.nullable().optional(),
  postCount: z.number().optional(),
  rank: z.string().optional(),
  joinDate: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UserProfileDtoSchema: z.ZodType<UserProfileDto> = IdentityDtoSchema;

export const UserPostHistoryItemDtoSchema: z.ZodType<UserPostHistoryItemDto> = z.object({
  postId: z.string(),
  topicId: z.string(),
  topicTitle: z.string(),
  forumId: z.string(),
  forumName: z.string(),
  createdAt: z.string(),
  excerpt: z.string(),
});

export const UserPostHistoryResponseDtoSchema: z.ZodType<UserPostHistoryResponseDto> = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(UserPostHistoryItemDtoSchema),
});

export const NotificationDtoSchema: z.ZodType<NotificationDto> = z.object({
  id: z.string(),
  identityId: z.string(),
  type: z.string(),
  actorId: optionalNullableString,
  topicId: optionalNullableString,
  postId: optionalNullableString,
  payload: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  readAt: optionalNullableString,
});

export const TopicUnreadDtoSchema: z.ZodType<TopicUnreadDto> = z.object({
  topicId: z.string(),
  identityId: z.string(),
  lastReadPostId: optionalNullableString,
  lastReadAt: optionalNullableString,
  lastPostId: optionalNullableString,
  lastPostAt: optionalNullableString,
  unreadCount: z.number(),
});

export const TopicSubscriptionDtoSchema: z.ZodType<TopicSubscriptionDto> = z.object({
  topicId: z.string(),
  identityId: z.string(),
  mode: z.enum(['watching', 'muted', 'off']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const RobotPersonaDtoSchema = z.object({
  key: z.string(),
  forumId: z.string(),
  displayName: z.string(),
  description: nullableString,
  accentColor: nullableString,
  avatarUrl: nullableString,
  signature: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<RobotPersonaDto>;

export const AdminRobotPersonaDtoSchema = RobotPersonaDtoSchema.extend({
  identityId: z.string(),
  soul: nullableString,
}) satisfies z.ZodType<AdminRobotPersonaDto>;

export const AdminForumDtoSchema: z.ZodType<AdminForumDto> = z.object({
  id: z.string(),
  parentForumId: optionalNullableString,
  category: optionalNullableString,
  name: z.string(),
  description: nullableString,
  cwd: nullableString,
  prePrompt: nullableString,
  status: ForumStatusSchema.optional(),
  visibility: ForumVisibilitySchema,
  archivedAt: optionalNullableString,
  topicCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AccessRuleDtoSchema: z.ZodType<AccessRuleDto> = z.object({
  id: z.string(),
  scopeKind: AccessRuleScopeKindSchema,
  scopeId: z.string(),
  principalKind: AccessRulePrincipalKindSchema,
  principalId: optionalNullableString,
  action: AccessRuleActionSchema,
  effect: AccessRuleEffectSchema,
  createdAt: z.string(),
});

export const AdminUserDtoSchema: z.ZodType<AdminUserDto> = z.object({
  id: z.string(),
  displayName: z.string(),
  username: nullableString,
  kind: IdentityKindSchema,
  avatarUrl: nullableString,
  createdAt: z.string(),
});

export const InviteDtoSchema: z.ZodType<InviteDto> = z.object({
  id: z.string(),
  code: z.string(),
  createdBy: z.string(),
  maxUses: z.number(),
  uses: z.number(),
  expiresAt: nullableString,
  createdAt: z.string(),
});

export const ExternalRefDtoSchema: z.ZodType<ExternalRefDto> = z.object({
  id: z.string(),
  surfaceId: z.string(),
  surfaceKind: z.enum(['discord', 'slack', 'matrix', 'web', 'system', 'forum']),
  externalId: z.string(),
  kind: z.enum(['forum', 'topic', 'post', 'identity', 'attachment', 'reaction', 'other']),
  scope: optionalNullableString,
  scopeKind: z
    .enum(['workspace', 'server', 'space', 'channel', 'thread', 'forum', 'topic', 'other'])
    .nullable()
    .optional(),
  mappedForumId: optionalNullableString,
  mappedTopicId: optionalNullableString,
  mappedPostId: optionalNullableString,
  mappedIdentityId: optionalNullableString,
});

export const PlanDtoSchema: z.ZodType<PlanDto> = z.object({
  id: z.string(),
  content: z.string(),
  summary: optionalNullableString,
  parentPostId: optionalNullableString,
  reasoningCheckpoints: z.array(z.number()).nullable().optional(),
  visibility: PlanVisibilitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ToolRunDtoSchema: z.ZodType<ToolRunDto> = z.object({
  id: z.string(),
  tool: z.string(),
  parentPostId: optionalNullableString,
  startedAt: z.string(),
  finishedAt: optionalNullableString,
  exitCode: z.number().nullable().optional(),
  command: optionalNullableString,
  filesTouched: z.array(z.string()).nullable().optional(),
  outputSummary: optionalNullableString,
  redactionsApplied: z.boolean(),
  visibility: ToolRunVisibilitySchema,
});

export const TopicOperationalEventDtoSchema: z.ZodType<TopicOperationalEventDto> = z.object({
  id: z.string(),
  topicId: z.string(),
  anchorPostId: z.string().nullable(),
  type: z.enum(['turn_error', 'compaction']),
  category: z.enum(['assistant', 'maintenance']),
  status: z.enum(['failed', 'succeeded']),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  sourceKind: z.enum(['echs_turn', 'compaction_operation']),
  sourceId: z.string(),
  createdAt: z.string(),
});

export const CreateCompactionRequestSchema: z.ZodType<CreateCompactionRequestDto> = z.object({
  operationId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._~-]+$/, 'operationId contains invalid characters'),
  confirmation: z.literal('COMPACT'),
  customInstructions: z.string().max(20_000).nullable(),
  recoveryPrompt: z.string().trim().min(1).max(100_000),
});

export const CompactionOperationDtoSchema: z.ZodType<CompactionOperationDto> = z.object({
  id: z.string(),
  topicId: z.string(),
  sessionId: z.string(),
  initiatedBy: z.string(),
  expectedLeafId: z.string(),
  customInstructions: z.string().nullable(),
  recoveryPrompt: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  eventId: z.string().nullable(),
  recoveryPostId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const TopicCompactionStateDtoSchema: z.ZodType<TopicCompactionStateDto> = z.object({
  active: CompactionOperationDtoSchema.nullable(),
  latest: CompactionOperationDtoSchema.nullable(),
  checkpointDispatch: z
    .object({
      status: z.enum(['pending', 'dispatching', 'dispatched', 'failed', 'superseded', 'abandoned']),
      errorMessage: z.string().nullable(),
    })
    .nullable(),
});

export const ForkBoundaryDtoSchema: z.ZodType<ForkBoundaryDto> = z.object({
  postId: z.string(),
  postNumber: z.number().int().positive(),
  excerpt: z.string(),
  body: z.string(),
});

export const CreateForkRequestSchema: z.ZodType<CreateForkRequestDto> = z.object({
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'operationId contains invalid characters'),
  boundaryPostId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  openingBody: z.string().trim().min(1).max(100_000),
});

export const ForkOperationDtoSchema: z.ZodType<ForkOperationDto> = z.object({
  id: z.string(),
  sourceTopicId: z.string(),
  boundaryPostId: z.string(),
  status: z.enum(['pending', 'running', 'needs_manual_review', 'succeeded', 'failed']),
  childTopicId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const TopicForkStateDtoSchema: z.ZodType<TopicForkStateDto> = z.object({
  active: ForkOperationDtoSchema.nullable(),
  latest: ForkOperationDtoSchema.nullable(),
});

export const SessionContextDtoSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  contextWindowTokens: z.number().nullable(),
  usedTokens: z.number().nullable(),
  remainingTokens: z.number().nullable(),
  percent: z.number().nullable(),
  exact: z.boolean(),
  source: z.string(),
  asOfPiMessageId: z.string().nullable(),
  leafEntryId: z.string().nullable().optional(),
});

export const RobotStateDtoSchema: z.ZodType<RobotStateDto> = z.object({
  topicId: z.string(),
  sessionId: z.string(),
  activity: RobotActivitySchema,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  lastUpdatedAt: z.string(),
  lastTurnError: z.object({
    message: z.string(),
    at: z.string(),
    postId: optionalNullableString,
    turnId: optionalNullableString
  }).nullable().optional(),
  currentPlan: PlanDtoSchema.nullable().optional(),
  context: SessionContextDtoSchema.nullable().optional(),
  recentToolRuns: z.array(ToolRunDtoSchema)
});

export const RobotStopResultDtoSchema: z.ZodType<RobotStopResultDto> = z.object({
  ok: z.boolean(),
  operationId: z.string(),
  generation: z.number().int().nonnegative(),
  state: z.enum(['stopping', 'stopped', 'uncertain']),
  targets: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  effectsUnknownCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  message: z.string(),
});

export const RobotJobDtoSchema: z.ZodType<RobotJobDto> = z.object({
  topicId: z.string(),
  topicTitle: optionalNullableString,
  topicStatus: optionalNullableString,
  forumId: optionalNullableString,
  forumName: optionalNullableString,
  sessionId: z.string(),
  codexThreadId: optionalNullableString,
  agentThreadId: optionalNullableString,
  agentBackend: optionalNullableString,
  activity: RobotActivitySchema,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  lastUpdatedAt: z.string(),
  activeTurnId: optionalNullableString,
  threadLoaded: z.boolean().nullable().optional(),
});

export const RobotQueueItemDtoSchema: z.ZodType<RobotQueueItemDto> = z.object({
  position: z.number(),
  queuedAt: z.string(),
  topicId: z.string(),
  topicTitle: optionalNullableString,
  forumId: optionalNullableString,
  forumName: optionalNullableString,
  parentPostId: optionalNullableString,
  sessionId: z.string(),
});

export const RobotSubagentRunDtoSchema: z.ZodType<RobotSubagentRunDto> = z.object({
  runId: z.string(),
  state: z.string(),
  executionState: z.enum(['active', 'terminal', 'interrupted', 'uncertain', 'quarantined']),
  outcomeState: optionalNullableString,
  effectsState: z.enum(['none', 'confirmed', 'unknown']).nullable().optional(),
  deliveryState: optionalNullableString,
  executionTarget: z.union([
    z.object({ kind: z.literal('local') }),
    z.object({ kind: z.literal('ssh'), name: z.string() })
  ]).nullable().optional(),
  blocking: z.boolean(),
  reason: optionalNullableString,
  parentSessionId: optionalNullableString,
  topicId: optionalNullableString,
  topicTitle: optionalNullableString,
  postId: optionalNullableString,
  startedAt: optionalNullableString,
  updatedAt: optionalNullableString
});

export const RobotDashboardDtoSchema: z.ZodType<RobotDashboardDto> = z.object({
  jobs: z.array(RobotJobDtoSchema),
  queue: z.array(RobotQueueItemDtoSchema),
  subagents: z.object({
    activeCount: z.number(),
    uncertainCount: z.number(),
    effectsUnknownCount: z.number(),
    runs: z.array(RobotSubagentRunDtoSchema),
    groups: z.object({
      blockers: z.array(RobotSubagentRunDtoSchema),
      pendingDelivery: z.array(RobotSubagentRunDtoSchema),
      history: z.array(RobotSubagentRunDtoSchema)
    }),
    omitted: z.number(),
    blockerCount: z.number(),
    omittedBlockerCount: z.number(),
    available: z.boolean(),
    error: optionalNullableString,
    retention: z.object({
      available: z.boolean(),
      generatedAt: optionalNullableString,
      retentionDays: z.number(),
      counts: z.object({ protected: z.number(), waiting: z.number(), eligible: z.number(), compacted: z.number(), error: z.number() }),
      trackedRemovableBytes: z.number(),
      eligibleBytes: z.number(),
      omitted: z.number(),
      running: z.boolean(),
      lastError: optionalNullableString
    }).optional()
  }).optional(),
  settings: z
    .object({
      maxConcurrentTurns: z.number(),
      activeTurnsCount: z.number()
    })
    .optional()
});

export const RobotSettingsDtoSchema: z.ZodType<RobotSettingsDto> = z.object({
  maxConcurrentTurns: z.number()
});

const AnalyticsToolDtoSchema = z.object({
  operation: z.string(),
  backend: z.string(),
  calls: z.number(),
  failures: z.number(),
  failureRate: z.number(),
  outcomes: z.record(z.string(), z.number()),
});

const AnalyticsErrorClusterDtoSchema = z.object({
  source: z.enum(['tool', 'provider', 'subagent']),
  category: z.string(),
  operation: optionalNullableString,
  affectedTurns: z.number(),
});

export const AdminAnalyticsDtoSchema: z.ZodType<AdminAnalyticsDto> = z.object({
  generatedAt: z.string(),
  window: z.object({ from: z.string(), to: z.string(), bucket: z.enum(AnalyticsBucketValues) }),
  selectedForumId: optionalNullableString,
  forums: z.array(z.object({ id: z.string(), name: z.string() })),
  vocabulary: z.object({
    algorithmVersion: z.literal(1),
    groups: z.array(
      z.object({
        forumId: z.string(),
        forumName: z.string(),
        audience: z.enum(AnalyticsAudienceValues),
        postCount: z.number(),
        terms: z.array(
          z.object({
            term: z.string(),
            score: z.number(),
            count: z.number(),
            documentCount: z.number(),
          })
        ),
      })
    ),
  }),
  runtime: z.object({
    available: z.boolean(),
    warning: optionalNullableString,
    metrics: z
      .object({
        generatedAt: z.string().nullable(),
        build: z.object({ commit: z.string().nullable(), createdAt: z.string().nullable() }),
        coverage: z.record(z.number()),
        usage: z.object({
          successfulResponses: z.number(),
          medianTokens: z.number().nullable(),
          byModel: z.array(
            z.object({
              vendor: z.string(),
              model: z.string(),
              responses: z.number(),
              totalTokens: z.number(),
              medianTokens: z.number().nullable(),
            })
          ),
        }),
        tools: z.object({ worst: AnalyticsToolDtoSchema.nullable(), rows: z.array(AnalyticsToolDtoSchema) }),
        errors: z.object({
          top: AnalyticsErrorClusterDtoSchema.nullable(),
          rows: z.array(AnalyticsErrorClusterDtoSchema),
        }),
        waiting: z.object({ count: z.number(), p95Ms: z.number().nullable(), excluded: z.number() }),
        delegation: z.object({
          successful: z.number(),
          unsuccessful: z.number(),
          unsuccessfulRate: z.number().nullable(),
          unknown: z.number(),
          byProfileMode: z.array(
            z.object({
              profile: z.string(),
              mode: z.string(),
              successful: z.number(),
              unsuccessful: z.number(),
              unsuccessfulRate: z.number().nullable(),
            })
          ),
        }),
        modelUsageOverTime: z.array(
          z.object({
            bucket: z.string(),
            bucketEnd: z.string(),
            observedFrom: z.string(),
            observedTo: z.string(),
            isPartial: z.boolean(),
            vendor: z.string(),
            responses: z.number(),
            totalTokens: z.number(),
          })
        ),
      })
      .nullable()
      .optional(),
  }),
});

export const AdminAnalyticsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  bucket: z.enum(AnalyticsBucketValues).default('day'),
  forumId: z.string().min(1).optional(),
});

export const TamperPluginDtoSchema: z.ZodType<TamperPluginDto> = z.object({
  key: z.string(),
  label: z.string(),
  description: optionalNullableString,
  stages: z.array(z.string()),
  defaultDirection: z.enum(['inbound', 'outbound', 'both']).optional(),
  defaultOnlyFirstMessage: z.boolean().optional(),
  defaultConfig: z.record(z.unknown()).nullable().optional(),
});

export const TamperConfigDtoSchema: z.ZodType<TamperConfigDto> = z.object({
  id: z.string(),
  forumId: optionalNullableString,
  pluginKey: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  direction: z.enum(['inbound', 'outbound', 'both']).nullable().optional(),
  onlyFirstMessage: z.boolean().nullable().optional(),
  config: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TamperTrailEntryDtoSchema: z.ZodType<TamperTrailEntryDto> = z.object({
  pluginKey: z.string(),
  pluginPriority: z.number(),
  stage: z.string(),
  direction: z.string(),
  durationMs: z.number(),
  inputText: z.string(),
  outputText: z.string(),
  changed: z.boolean(),
  error: optionalNullableString,
  notes: z.record(z.unknown()).optional(),
});

export const TamperTestResultDtoSchema: z.ZodType<TamperTestResultDto> = z.object({
  inputText: z.string(),
  outputText: z.string(),
  tampered: z.boolean(),
  trail: z.array(TamperTrailEntryDtoSchema),
});

export const RobotAutomationDtoSchema: z.ZodType<RobotAutomationDto> = z.object({
  id: z.string(),
  name: z.string(),
  forumId: optionalNullableString,
  prompt: z.string(),
  enabled: z.boolean(),
  worker: RobotAutomationWorkerSchema,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  runMode: RobotAutomationRunModeSchema,
  intervalMinutes: z.number().nullable().optional(),
  lastRunAt: optionalNullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const RobotAutomationRunDtoSchema: z.ZodType<RobotAutomationRunDto> = z.object({
  id: z.string(),
  automationId: z.string(),
  worker: RobotAutomationWorkerSchema,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  status: z.string(),
  startedAt: z.string(),
  finishedAt: optionalNullableString,
  exitCode: z.number().nullable().optional(),
  outputSummary: optionalNullableString,
  lastMessage: optionalNullableString,
  logPath: optionalNullableString,
});

export const TopicAutoRunDtoSchema: z.ZodType<TopicAutoRunDto> = z.object({
  topicId: z.string(),
  enabled: z.boolean(),
  context: optionalNullableString,
  worker: RobotAutomationWorkerSchema,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  maxReplies: z.number().int(),
  replyCount: z.number().int(),
  status: TopicAutoRunStatusSchema,
  lastRunAt: optionalNullableString,
  lastReplyAt: optionalNullableString,
  lastSummary: optionalNullableString,
  lastNotes: optionalNullableString,
  lastError: optionalNullableString,
  steerMessage: optionalNullableString,
  createdAt: optionalNullableString,
  updatedAt: optionalNullableString,
});

export const PiSessionDiagnosticsDtoSchema: z.ZodType<PiSessionDiagnosticsDto> = z.object({
  id: z.string(),
  path: z.string(),
  cwd: optionalNullableString,
  parentId: optionalNullableString,
  parentPath: optionalNullableString,
  lineageKind: optionalNullableString,
  lineageSource: optionalNullableString,
  importedAt: z.string(),
  lastImportRunId: optionalNullableString,
});

export const SessionDtoSchema: z.ZodType<SessionDto> = z.object({
  id: z.string(),
  topicId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['active', 'paused', 'completed', 'error']),
  piSession: PiSessionDiagnosticsDtoSchema.nullable().optional(),
});

export const SessionMessageDtoSchema: z.ZodType<SessionMessageDto> = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['system', 'assistant', 'user', 'tool']),
  content: z.string(),
  createdAt: z.string(),
  visibility: PlanVisibilitySchema,
});

export const SessionInspectorDtoSchema: z.ZodType<SessionInspectorDto> = z.object({
  session: SessionDtoSchema,
  messages: z.array(SessionMessageDtoSchema),
  toolRuns: z.array(ToolRunDtoSchema),
  plans: z.array(PlanDtoSchema),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      label: z.string(),
      visibility: PlanVisibilitySchema,
    })
  ),
});

export const AdminDeployStatusDtoSchema: z.ZodType<AdminDeployStatusDto> = z.object({
  enabled: z.boolean(),
  scriptPath: optionalNullableString,
  logPath: optionalNullableString,
  running: z.boolean().nullable().optional(),
  lastStartedAt: optionalNullableString,
  lastFinishedAt: optionalNullableString,
  lastExitCode: z.number().nullable().optional(),
  lastError: optionalNullableString,
  commitSha: optionalNullableString,
  deployOnFinishRequestedAt: optionalNullableString,
  deployOnFinishLastCheckedAt: optionalNullableString,
  deployOnFinishLastError: optionalNullableString,
});

export const AdminDeployResponseDtoSchema: z.ZodType<AdminDeployResponseDto> = z.object({
  ok: z.boolean(),
  startedAt: optionalNullableString,
  logPath: optionalNullableString,
});

export const AdminDeployOnFinishResponseDtoSchema: z.ZodType<AdminDeployOnFinishResponseDto> = z.object({
  ok: z.boolean(),
  requestedAt: optionalNullableString,
});

export const AdminCancelDeployOnFinishResponseDtoSchema: z.ZodType<AdminCancelDeployOnFinishResponseDto> = z.object({
  ok: z.boolean(),
});

export const AuthIdentityDtoSchema: z.ZodType<AuthIdentityDto> = z.object({
  id: z.string(),
  displayName: z.string(),
  username: optionalNullableString,
  kind: IdentityKindSchema,
  parentIdentityId: optionalNullableString,
  avatarUrl: optionalNullableString,
  location: optionalNullableString,
  signature: optionalNullableString,
  theme: ForumThemeKeySchema.nullable().optional(),
  hasPrivateEmail: z.boolean().optional(),
  hasPassword: z.boolean().optional(),
  quickReplyDockedByDefault: z.boolean().optional(),
});

export const RegistrationModeDtoSchema: z.ZodType<RegistrationModeDto> = z.object({
  mode: RegistrationModeSchema,
  registrationEnabled: z.boolean(),
  inviteRegistrationEnabled: z.boolean(),
  publicRegistrationEnabled: z.boolean(),
  passwordLoginEnabled: z.boolean(),
});

export const AuthUserDtoSchema: z.ZodType<AuthUserDto> = z.object({
  identity: AuthIdentityDtoSchema.nullable(),
});

export const IdentityPermissionsDtoSchema: z.ZodType<IdentityPermissionsDto> = z.object({
  permissions: z.array(z.string()),
});

export const LoginResponseDtoSchema: z.ZodType<LoginResponseDto> = z.object({
  identity: AuthIdentityDtoSchema.optional(),
  message: z.string().optional(),
});

export const RegisterResponseDtoSchema: z.ZodType<RegisterResponseDto> = z.object({
  identity: AuthIdentityDtoSchema,
  verifyUrl: z.string().optional(),
  expiresAt: z.string().optional(),
  emailSent: z.boolean().optional(),
});

export const VerifyResponseDtoSchema: z.ZodType<VerifyResponseDto> = z.object({
  identity: AuthIdentityDtoSchema,
});

export const EmptyJsonRequestSchema = z.object({}).strict();
export const WebAuthnOptionsResponseDtoSchema = z.object({
  challengeId: z.string(),
  options: z.record(z.unknown()),
});
export const WebAuthnCredentialDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  transports: z.array(z.string()),
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: optionalNullableString,
});
export const WebAuthnCredentialListResponseDtoSchema = z.object({ items: z.array(WebAuthnCredentialDtoSchema) });
export const WebAuthnLoginResponseDtoSchema = z.object({ identity: AuthIdentityDtoSchema });
export const WebAuthnVerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  response: z.record(z.unknown()),
});
export const WebAuthnRegistrationVerifyRequestSchema = WebAuthnVerifyRequestSchema.extend({
  name: z.string().min(1).max(100),
});
export const PasswordCredentialSchema = z.string().min(8).max(1024);
export const CreatePasswordRequestSchema = z.object({ newPassword: PasswordCredentialSchema });

export const InviteInfoDtoSchema: z.ZodType<InviteInfoDto> = z.object({
  code: z.string(),
  valid: z.boolean(),
  message: z.string().optional(),
  remainingUses: z.number().optional(),
  expiresAt: optionalNullableString,
});

export const UpdatePrivateEmailResponseDtoSchema: z.ZodType<UpdatePrivateEmailResponseDto> = z.object({
  ok: z.boolean(),
  hasPrivateEmail: z.boolean(),
});

export const UpdateQuickReplyPreferenceResponseDtoSchema: z.ZodType<UpdateQuickReplyPreferenceResponseDto> = z.object({
  ok: z.boolean(),
  quickReplyDockedByDefault: z.boolean(),
});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(1024),
});

export const ChangePasswordResponseDtoSchema = z.object({
  ok: z.boolean(),
});

export const ApiKeyListResponseDtoSchema: z.ZodType<ApiKeyListResponseDto> = z.object({
  items: z.array(ApiKeyDtoSchema),
});

export const ApiKeyCreateResponseDtoSchema: z.ZodType<ApiKeyCreateResponseDto> = z.object({
  apiKey: ApiKeyDtoSchema,
  token: z.string(),
});

export const ImpersonationTokenListResponseDtoSchema: z.ZodType<ImpersonationTokenListResponseDto> = z.object({
  items: z.array(ImpersonationTokenDtoSchema),
});

export const ImpersonationTokenCreateResponseDtoSchema: z.ZodType<ImpersonationTokenCreateResponseDto> = z.object({
  impersonationToken: ImpersonationTokenDtoSchema,
  token: z.string(),
});

export const DiscordChannelMappingDtoSchema: z.ZodType<DiscordChannelMappingDto> = z.object({
  channelId: z.string(),
  forumId: z.string(),
  channelName: optionalNullableString,
});

export const DiscordBridgeStatusDtoSchema: z.ZodType<DiscordBridgeStatusDto> = z.object({
  configured: z.boolean().optional(),
  connected: z.boolean(),
  guildId: z.string().optional(),
  guildName: z.string().optional(),
  channelMappings: z.array(DiscordChannelMappingDtoSchema),
  error: z.string().optional(),
  message: z.string().optional(),
});

export const MatrixRoomMappingDtoSchema: z.ZodType<MatrixRoomMappingDto> = z.object({
  roomId: z.string(),
  forumId: z.string(),
  roomName: optionalNullableString,
});

export const MatrixBridgeStatusDtoSchema: z.ZodType<MatrixBridgeStatusDto> = z.object({
  configured: z.boolean().optional(),
  connected: z.boolean(),
  homeserverUrl: z.string().optional(),
  userId: z.string().optional(),
  roomMappings: z.array(MatrixRoomMappingDtoSchema),
  error: z.string().optional(),
  message: z.string().optional(),
});

export const SearchResultsDtoSchema: z.ZodType<SearchResultsDto> = z.object({
  topics: z.array(TopicDtoSchema),
  posts: z.array(PostDtoSchema),
});

export const AdminSkillAvailabilityDtoSchema: z.ZodType<AdminSkillAvailabilityDto> = z.object({
  forumId: z.string(),
  forumName: z.string(),
  configScope: z.enum(['forum', 'global']),
  promptEnhancerEnabled: z.boolean(),
  personas: z.array(z.object({ key: z.string() })),
});

export const AdminSkillDtoSchema: z.ZodType<AdminSkillDto> = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  scope: z.enum(['system', 'user']),
  root: z.string(),
  path: z.string(),
  bytes: z.number(),
  updatedAt: nullableString,
  excerpt: nullableString,
  availableIn: z.array(AdminSkillAvailabilityDtoSchema),
});

export const AdminSkillRootDtoSchema: z.ZodType<AdminSkillRootDto> = z.object({
  root: z.string(),
  exists: z.boolean(),
  skillCount: z.number(),
  usedByForumIds: z.array(z.string()),
});

export const AdminSkillListResponseDtoSchema: z.ZodType<AdminSkillListResponseDto> = z.object({
  generatedAt: z.string(),
  promptEnhancerEnabledByDefault: z.boolean(),
  defaultSkillsRoot: z.string(),
  roots: z.array(AdminSkillRootDtoSchema),
  items: z.array(AdminSkillDtoSchema),
});

export const CreateForumRequestSchema: z.ZodType<CreateForumRequest> = z.object({
  name: z.string().min(1),
  description: optionalNullableString,
  parentForumId: optionalNullableString,
  category: optionalNullableString,
  visibility: ForumVisibilitySchema.optional(),
});

export const ListForumsRequestSchema: z.ZodType<ListForumsRequest> = z.object({
  parentForumId: optionalNullableString,
  status: ForumStatusSchema.optional(),
  includeArchived: z.boolean().optional(),
});

const DraftReferenceRequestSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();

export const CreateTopicRequestSchema: z.ZodType<CreateTopicRequest> = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  attachmentsPending: z.boolean().optional(),
  robotMode: RobotModeSchema.optional(),
  autoCompactEnabled: z.boolean().optional(),
  silent: z.boolean().optional(),
  draft: DraftReferenceRequestSchema.optional()
});

export const CreatePostRequestSchema: z.ZodType<CreatePostRequest> = z.object({
  body: z.string().min(1),
  parentPostId: optionalNullableString,
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  attachmentsPending: z.boolean().optional(),
  autoCompactEnabled: z.boolean().optional(),
  autoCompactRevision: z.number().int().nonnegative().optional(),
  silent: z.boolean().optional(),
  draft: DraftReferenceRequestSchema.optional()
});

export const LoginRequestSchema: z.ZodType<LoginRequest> = z.object({
  username: z
    .string({ required_error: 'username and password are required' })
    .min(1, 'username and password are required')
    .max(100),
  password: z
    .string({ required_error: 'username and password are required' })
    .min(1, 'username and password are required')
    .max(1024),
});

export const RegisterRequestSchema: z.ZodType<RegisterRequest> = z.object({
  displayName: z.string({ required_error: 'displayName is required' }).min(1, 'displayName is required').max(100),
  username: z.string().min(1).max(100).optional(),
  password: z.string().min(1).max(1024).optional(),
  email: z.string().min(1).max(320).optional(),
  inviteCode: z.string().min(1).max(256).optional(),
});

export const NotepadExpirationPresetSchema = z.enum(NotepadExpirationPresetValues);
export const NotepadDraftOptionsSchema = z.object({
  tags: z.array(z.string()).max(20),
  expiration: NotepadExpirationPresetSchema,
});
export const MessageDraftContextSchema = z.enum(MessageDraftContextValues);
export const MessageDraftDtoSchema: z.ZodType<MessageDraftDto> = z.object({
  id: z.string(),
  context: MessageDraftContextSchema,
  forumId: nullableString,
  topicId: nullableString,
  title: nullableString,
  body: z.string(),
  options: NotepadDraftOptionsSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  destinationName: nullableString,
  canContinue: z.boolean(),
});
export const MessageDraftResponseDtoSchema: z.ZodType<MessageDraftResponseDto> = z.object({
  draft: MessageDraftDtoSchema.nullable(),
});
export const MessageDraftListResponseDtoSchema: z.ZodType<MessageDraftListResponseDto> = z.object({
  drafts: z.array(MessageDraftDtoSchema),
});
export const MessageDraftWriteRequestSchema: z.ZodType<MessageDraftWriteRequest> = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().max(255).nullable().optional(),
    body: z.string(),
    options: NotepadDraftOptionsSchema.nullable().optional(),
  })
  .strict();

export const NotepadEntryDtoSchema: z.ZodType<NotepadEntryDto> = z.object({
  id: z.string(),
  contentFormat: z.enum(NotepadContentFormatValues),
  title: nullableString,
  body: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: nullableString,
});
export const NotepadEntryResponseDtoSchema: z.ZodType<NotepadEntryResponseDto> = z.object({ entry: NotepadEntryDtoSchema });
export const NotepadListResponseDtoSchema: z.ZodType<NotepadListResponseDto> = z.object({
  entries: z.array(NotepadEntryDtoSchema),
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().nonnegative() })),
  nextCursor: nullableString,
});
const NotepadBaseWriteSchema = z.object({
  title: z.string().max(255).nullable().optional(),
  body: z.string(),
  tags: z.array(z.string()).max(20).optional(),
  expiration: NotepadExpirationPresetSchema.optional(),
});
export const NotepadEntryWriteRequestSchema: z.ZodType<NotepadEntryWriteRequest> = NotepadBaseWriteSchema.extend({
  draft: z.object({ id: z.string(), revision: z.number().int().positive() }),
}).strict();
export const NotepadEntryUpdateRequestSchema: z.ZodType<NotepadEntryUpdateRequest> = NotepadBaseWriteSchema.extend({
  expectedRevision: z.number().int().positive(),
  expiration: z.union([NotepadExpirationPresetSchema, z.literal('keep')]).optional(),
  pinned: z.boolean().optional(),
}).strict();
export const NotepadListQuerySchema = z.object({
  q: z.string().max(500).optional(),
  tags: z.string().max(1000).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
export const NotepadDeleteQuerySchema = z.object({ revision: z.coerce.number().int().positive() }).strict();

export const MessageDraftRevisionQuerySchema = z
  .object({
    revision: z.coerce.number().int().positive(),
  })
  .strict();

export const MessageTemplateContextSchema = z.enum(MessageTemplateContextValues);
export const MessageTemplateScopeSchema = z.enum(MessageTemplateScopeValues);
export const MessageTemplateForumScopeSchema = z.enum(MessageTemplateForumScopeValues);

export const MessageTemplateDtoSchema: z.ZodType<MessageTemplateDto> = z.object({
  id: z.string(),
  scope: MessageTemplateScopeSchema,
  name: z.string(),
  category: nullableString,
  body: z.string(),
  threadTitle: nullableString,
  forumScope: MessageTemplateForumScopeSchema,
  forumIds: z.array(z.string()),
  contexts: z.array(MessageTemplateContextSchema),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const MessageTemplateListResponseDtoSchema: z.ZodType<MessageTemplateListResponseDto> = z.object({
  templates: z.array(MessageTemplateDtoSchema),
});

const messageTemplateWriteRequestObjectSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => value.trim().length > 0, 'Name is required'),
  category: z.string().max(40).nullable().optional(),
  body: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'Body is required'),
  threadTitle: z.string().max(255).nullable().optional(),
  forumScope: MessageTemplateForumScopeSchema,
  forumIds: z.array(z.string().min(1)),
  contexts: z.array(MessageTemplateContextSchema).min(1),
  enabled: z.boolean(),
});
function validateMessageTemplateForumScope(
  value: Pick<MessageTemplateWriteRequest, 'forumScope' | 'forumIds'>,
  context: z.RefinementCtx
): void {
  if (value.forumScope === 'selected' && value.forumIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['forumIds'], message: 'Select at least one forum' });
  }
  if (value.forumScope === 'all' && value.forumIds.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forumIds'],
      message: 'All-forum templates cannot include forum ids',
    });
  }
}
export const MessageTemplateWriteRequestSchema: z.ZodType<MessageTemplateWriteRequest> =
  messageTemplateWriteRequestObjectSchema.superRefine(validateMessageTemplateForumScope);
export const MessageTemplateUpdateRequestSchema: z.ZodType<MessageTemplateUpdateRequest> =
  messageTemplateWriteRequestObjectSchema
    .extend({ revision: z.number().int().positive() })
    .superRefine(validateMessageTemplateForumScope);

export const MessageTemplateReorderRequestSchema: z.ZodType<MessageTemplateReorderRequest> = z.object({
  items: z.array(z.object({ id: z.string(), revision: z.number().int().positive() })).min(1),
});
export const MessageTemplateEffectiveQuerySchema = z.object({
  context: MessageTemplateContextSchema,
  forumId: z.string().min(1),
});
export const MessageTemplateRevisionQuerySchema = z.object({
  revision: z.coerce.number().int().positive(),
});

export const UpdatePrivateEmailRequestSchema: z.ZodType<UpdatePrivateEmailRequest> = z.object({
  emailAddress: z.string({ required_error: 'emailAddress is required (string or null)' }).nullable(),
});

export const UpdateQuickReplyPreferenceRequestSchema: z.ZodType<UpdateQuickReplyPreferenceRequest> = z.object({
  quickReplyDockedByDefault: z.boolean(),
});

export const CreateApiKeyRequestSchema: z.ZodType<CreateApiKeyRequest> = z.object({
  label: z.string({ required_error: 'label is required' }).trim().min(1, 'label is required'),
  scopes: z.array(z.string()).optional(),
  expiresAt: optionalNullableString,
});

export const CreateImpersonationTokenRequestSchema: z.ZodType<CreateImpersonationTokenRequest> = z.object({
  label: z.string({ required_error: 'label is required' }).trim().min(1, 'label is required'),
  displayName: z.string().trim().min(1).optional(),
  avatarUrl: optionalNullableString,
  scopes: z.array(z.string()).optional(),
  expiresAt: optionalNullableString,
  impersonatedIdentityId: optionalNullableString,
});

export const UpdateIdentityRequestSchema: z.ZodType<UpdateIdentityRequest> = z
  .object({
    displayName: z.string().optional(),
    avatarUrl: optionalNullableString,
    location: optionalNullableString,
    signature: optionalNullableString,
    theme: ForumThemeKeySchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.avatarUrl !== undefined ||
      value.location !== undefined ||
      value.signature !== undefined ||
      value.theme !== undefined,
    {
      message: 'At least one field to update is required',
    }
  );

export const UpdateTopicStatusRequestSchema: z.ZodType<UpdateTopicStatusRequest> = z.object({
  status: TopicStatusSchema,
});

export const UpdateTopicTitleRequestSchema: z.ZodType<UpdateTopicTitleRequest> = z.object({
  title: z.string().min(1),
});

export const UpdateTopicTagsRequestSchema: z.ZodType<UpdateTopicTagsRequest> = z
  .object({
    sticky: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((value) => value.sticky !== undefined || value.tags !== undefined, {
    message: 'sticky or tags is required',
  });

export const MoveTopicRequestSchema: z.ZodType<MoveTopicRequest> = z.object({
  forumId: z.string(),
  silent: z.boolean().optional(),
});

export const CreateInviteRequestSchema: z.ZodType<CreateInviteRequest> = z.object({
  maxUses: z.coerce.number().int().positive().optional(),
  expiresInDays: z.coerce.number().int().positive().optional(),
});

export const AttachmentChunkedStartRequestSchema: z.ZodType<AttachmentChunkedStartRequest> = z.object({
  filename: z
    .string({ required_error: 'filename and sizeBytes are required' })
    .min(1, 'filename and sizeBytes are required'),
  mimeType: z.string().optional(),
  sizeBytes: z.coerce
    .number({ required_error: 'filename and sizeBytes are required' })
    .positive('sizeBytes must be a positive number'),
});

export const CreateChatCategoryRequestSchema: z.ZodType<CreateChatCategoryRequest> = z.object({
  name: z.string({ required_error: 'name is required' }).min(1, 'name is required'),
  description: optionalNullableString,
  visibility: ForumVisibilitySchema.optional(),
});

export const CreateChatRoomRequestSchema: z.ZodType<CreateChatRoomRequest> = z.object({
  categoryId: z.string({ required_error: 'categoryId is required' }).min(1, 'categoryId is required'),
  name: z.string({ required_error: 'name is required' }).min(1, 'name is required'),
  topic: optionalNullableString,
});

export const CreateChatMessageRequestSchema: z.ZodType<CreateChatMessageRequest> = z.object({
  body: z.string({ required_error: 'body is required' }).min(1, 'body is required'),
  expiresInSeconds: z.coerce.number().int().positive().optional(),
});

export const ChatTypingRequestSchema: z.ZodType<ChatTypingRequest> = z.object({
  isTyping: z.boolean(),
});

export const DiscordMapChannelRequestSchema: z.ZodType<DiscordMapChannelRequest> = z.object({
  channelId: z.string({ required_error: 'channelId is required' }).min(1, 'channelId is required'),
  forumId: z.string().optional(),
});

export const DiscordSendRequestSchema: z.ZodType<DiscordSendRequest> = z.object({
  threadId: z
    .string({ required_error: 'threadId and content are required' })
    .min(1, 'threadId and content are required'),
  content: z
    .string({ required_error: 'threadId and content are required' })
    .min(1, 'threadId and content are required'),
  authorName: z.string().optional(),
});

export const MatrixMapRoomRequestSchema: z.ZodType<MatrixMapRoomRequest> = z.object({
  roomId: z.string({ required_error: 'roomId is required' }).min(1, 'roomId is required'),
  forumId: z.string().optional(),
});

export const MatrixSendRequestSchema: z.ZodType<MatrixSendRequest> = z.object({
  roomId: z.string({ required_error: 'roomId and content are required' }).min(1, 'roomId and content are required'),
  threadId: z.string().optional(),
  content: z.string({ required_error: 'roomId and content are required' }).min(1, 'roomId and content are required'),
  authorName: z.string().optional(),
});

export const AdminCreateUserRequestSchema: z.ZodType<AdminCreateUserRequest> = z.object({
  displayName: z
    .string({ required_error: 'displayName, username, and password are required' })
    .min(1, 'displayName, username, and password are required'),
  username: z
    .string({ required_error: 'displayName, username, and password are required' })
    .min(1, 'displayName, username, and password are required'),
  password: PasswordCredentialSchema,
  kind: z.string().optional(),
});

export const AdminUpdateUserRequestSchema: z.ZodType<AdminUpdateUserRequest> = z.object({
  displayName: z.string().optional(),
  kind: z.string().optional(),
  password: PasswordCredentialSchema.optional(),
});

export const AdminCreateForumRequestSchema: z.ZodType<AdminCreateForumRequest> = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required'),
  description: optionalNullableString,
  cwd: optionalNullableString,
  prePrompt: optionalNullableString,
  parentForumId: optionalNullableString,
  category: optionalNullableString,
  status: ForumStatusSchema.optional(),
  visibility: ForumVisibilitySchema.optional(),
});

export const AdminUpdateForumRequestSchema: z.ZodType<AdminUpdateForumRequest> = z.object({
  name: z.string().optional(),
  description: optionalNullableString,
  cwd: optionalNullableString,
  prePrompt: optionalNullableString,
  parentForumId: optionalNullableString,
  category: optionalNullableString,
  status: ForumStatusSchema.optional(),
  visibility: ForumVisibilitySchema.optional(),
  archivedAt: optionalNullableString,
});

export const AdminAccessRuleRequestSchema: z.ZodType<AdminAccessRuleRequest> = z.object({
  principalKind: AccessRulePrincipalKindSchema,
  principalId: optionalNullableString,
  action: AccessRuleActionSchema,
  effect: AccessRuleEffectSchema,
});

export const AdminMoveTopicRequestSchema: z.ZodType<AdminMoveTopicRequest> = z.object({
  forumId: z.string({ required_error: 'forumId is required' }).min(1, 'forumId is required'),
  silent: z.boolean().optional(),
});

export const AdminCreatePersonaRequestSchema: z.ZodType<AdminCreatePersonaRequest> = z.object({
  key: z
    .string({ required_error: 'key and displayName are required' })
    .trim()
    .min(1, 'key and displayName are required'),
  displayName: z
    .string({ required_error: 'key and displayName are required' })
    .trim()
    .min(1, 'key and displayName are required'),
  description: optionalNullableString,
  accentColor: optionalNullableString,
  avatarUrl: optionalNullableString,
  signature: optionalNullableString,
  soul: optionalNullableString,
});

export const AdminUpdatePersonaRequestSchema: z.ZodType<AdminUpdatePersonaRequest> = z.object({
  displayName: z.string().optional(),
  description: optionalNullableString,
  accentColor: optionalNullableString,
  avatarUrl: optionalNullableString,
  signature: optionalNullableString,
  soul: optionalNullableString,
});

export const AdminCreateTamperRequestSchema: z.ZodType<AdminCreateTamperRequest> = z.object({
  forumId: optionalNullableString,
  pluginKey: z.string({ required_error: 'pluginKey is required' }).min(1, 'pluginKey is required'),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().optional(),
  direction: optionalNullableString,
  onlyFirstMessage: z.boolean().nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
});

export const AdminUpdateTamperRequestSchema: z.ZodType<AdminUpdateTamperRequest> = z.object({
  forumId: optionalNullableString,
  enabled: z.boolean().optional(),
  priority: z.coerce.number().optional(),
  direction: optionalNullableString,
  onlyFirstMessage: z.boolean().nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
});

export const AdminTestTamperRequestSchema: z.ZodType<AdminTestTamperRequest> = z.object({
  text: z.string({ required_error: 'text is required' }).trim().min(1, 'text is required'),
  forumId: optionalNullableString,
  stage: z.string().optional(),
  direction: z.string().optional(),
  pluginKey: optionalNullableString,
  pluginConfig: z.record(z.unknown()).nullable().optional(),
  onlyPlugin: z.boolean().optional(),
  isFirstMessage: z.boolean().optional(),
});

export const AdminCreateRobotAutomationRequestSchema: z.ZodType<AdminCreateRobotAutomationRequest> = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required'),
  forumId: optionalNullableString,
  prompt: z.string({ required_error: 'prompt is required' }).trim().min(1, 'prompt is required'),
  enabled: z.boolean().optional(),
  worker: z.enum(['echs'], { required_error: 'worker must be echs' }),
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  runMode: z.enum(['manual', 'interval']).optional(),
  intervalMinutes: z.union([z.coerce.number().int().min(1, 'intervalMinutes must be at least 1'), z.null()]).optional(),
});

export const AdminUpdateRobotAutomationRequestSchema: z.ZodType<AdminUpdateRobotAutomationRequest> = z.object({
  name: z.string().optional(),
  forumId: optionalNullableString,
  prompt: z.string().optional(),
  enabled: z.boolean().optional(),
  worker: z.enum(['echs']).optional(),
  model: optionalNullableString,
  reasoningEffort: optionalNullableString,
  runMode: z.enum(['manual', 'interval']).optional(),
  intervalMinutes: z.union([z.coerce.number().int().min(1, 'intervalMinutes must be at least 1'), z.null()]).optional(),
});

export const AdminUpdateRobotSettingsRequestSchema = z.object({
  maxConcurrentTurns: z.coerce.number().int().optional(),
}) satisfies z.ZodType<AdminUpdateRobotSettingsRequest>;

export const PageRequestDtoSchema: z.ZodType<PageRequest> = PageRequestSchema;
export const PageResponseForumDtoSchema: z.ZodType<PageResponse<ForumDto>> = PageResponseSchema(ForumDtoSchema);
export const PageResponseTopicDtoSchema: z.ZodType<PageResponse<TopicDto>> = PageResponseSchema(TopicDtoSchema);
export const PageResponsePostDtoSchema: z.ZodType<PageResponse<PostDto>> = PageResponseSchema(PostDtoSchema);
export const PageResponseIdentityDtoSchema: z.ZodType<PageResponse<IdentityDto>> =
  PageResponseSchema(IdentityDtoSchema);
