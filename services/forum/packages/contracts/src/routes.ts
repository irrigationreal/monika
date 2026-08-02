import { z } from 'zod';
import * as schemas from './schemas';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteRequest = {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: {
    schema: z.ZodTypeAny;
    contentType?: string;
  };
};

export type RouteResponse = {
  schema: z.ZodTypeAny;
  statusCode?: number;
  contentType?: string;
  description?: string;
};

export type ApiRoute = {
  method: HttpMethod;
  path: string;
  summary: string;
  tags?: string[];
  request?: RouteRequest;
  response: RouteResponse;
};

const okSchema = z.object({ ok: z.boolean() });
const okMessageSchema = okSchema.extend({ message: z.string().optional() });
// Unused helper schema (kept commented out to avoid noUnusedLocals failures).
// const okCountSchema = okSchema.extend({ count: z.number().optional() });
const okReadCountSchema = okSchema.extend({ readCount: z.number() });
const okDispatchedSchema = okSchema.extend({
  dispatched: z.boolean(),
  post: schemas.PostDtoSchema
});

const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    items: z.array(item)
  });

const itemsSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item)
  });

const stringParam = (name: string) => z.object({ [name]: z.string() });
const paginationQuerySchema = z.object({
  page: z.number().optional(),
  pageSize: z.number().optional()
});

const fileUploadSchema = z.object({
  file: z.string()
});

const chunkUploadSchema = z.object({
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number()
});

const chunkUploadResponseSchema = z.object({
  ok: z.boolean(),
  index: z.number()
});

const chunkIndexQuerySchema = z.object({
  index: z.number()
});

const listForumsQuerySchema = schemas.ListForumsRequestSchema;

const listTopicsQuerySchema = z.object({
  since: z.string().optional(),
  page: z.number().optional(),
  pageSize: z.number().optional()
});

const listPostsQuerySchema = z.object({
  page: z.number().optional(),
  pageSize: z.number().optional(),
  include: z.string().optional()
});

const listIdentitiesQuerySchema = paginationQuerySchema;

const listNotificationsQuerySchema = z.object({
  page: z.number().optional(),
  pageSize: z.number().optional(),
  unreadOnly: z.boolean().optional()
});

const robotStateQuerySchema = z.object({
  view: z.enum(['summary', 'full', 'detailed']).optional(),
  include: z.string().optional()
});

const recentPostsQuerySchema = z.object({
  limit: z.number().optional()
});

const searchQuerySchema = z.object({
  q: z.string(),
  scope: z.enum(['all', 'topics', 'posts']).optional(),
  forumId: z.string().optional(),
  limit: z.number().min(1).max(100).optional()
});

const attachmentContentSchema = z.string();

const avatarUploadResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string(),
  message: z.string()
});

const discordConnectResponseSchema = z.object({
  ok: z.boolean(),
  status: schemas.DiscordBridgeStatusDtoSchema.optional()
});

const discordMapResponseSchema = z.object({
  ok: z.boolean(),
  mapping: z.object({
    channelId: z.string(),
    forumId: z.string()
  })
});

const matrixConnectResponseSchema = z.object({
  ok: z.boolean(),
  status: schemas.MatrixBridgeStatusDtoSchema.optional()
});

const matrixMapResponseSchema = z.object({
  ok: z.boolean(),
  mapping: z.object({
    roomId: z.string(),
    forumId: z.string()
  })
});

const notificationListSchema = pageSchema(schemas.NotificationDtoSchema);

const topicAccessRuleResponseSchema = itemsSchema(schemas.AccessRuleDtoSchema);

const forumAccessRuleResponseSchema = itemsSchema(schemas.AccessRuleDtoSchema);

const robotAutomationListSchema = itemsSchema(schemas.RobotAutomationDtoSchema);

const robotAutomationRunListSchema = itemsSchema(schemas.RobotAutomationRunDtoSchema);

const tamperPluginsResponseSchema = itemsSchema(schemas.TamperPluginDtoSchema);

const tamperConfigsResponseSchema = itemsSchema(schemas.TamperConfigDtoSchema);

const topicPersonaResponseSchema = itemsSchema(schemas.RobotPersonaDtoSchema);

const adminForumPersonaResponseSchema = itemsSchema(schemas.AdminRobotPersonaDtoSchema);

const adminForumListSchema = itemsSchema(schemas.AdminForumDtoSchema);

const adminSkillListSchema = schemas.AdminSkillListResponseDtoSchema;

const recentPostsResponseSchema = z.array(schemas.RecentPostDtoSchema);

const reactionListSchema = z.array(
  z.object({
    id: z.string(),
    postId: z.string(),
    identityId: z.string(),
    emoji: z.string(),
    createdAt: z.string()
  })
);

const reactionCountsSchema = z.array(
  z.object({
    emoji: z.string(),
    count: z.number()
  })
);

const notificationPatchSchema = z.object({
  readAt: z.string().nullable().optional()
});

const topicReadSchema = z.object({
  lastReadPostId: z.string().optional().nullable(),
  lastReadAt: z.string().optional().nullable()
});

const topicSubscriptionSchema = z.object({
  mode: z.enum(['watching', 'muted', 'off'])
});

const createInviteSchema = schemas.CreateInviteRequestSchema;

const createForumAccessRuleSchema = z.object({
  principalKind: z.enum(['all', 'logged_in', 'identity', 'role']),
  principalId: z.string().nullable().optional(),
  action: z.enum(['view', 'post', 'topic.create', 'moderate']),
  effect: z.enum(['allow', 'deny'])
});

const createTopicAccessRuleSchema = createForumAccessRuleSchema;

const moveTopicSchema = schemas.MoveTopicRequestSchema;

const automationCreateSchema = z.object({
  forumId: z.string().optional().nullable(),
  topicId: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  worker: z.string().optional(),
  model: z.string().optional().nullable(),
  reasoningEffort: z.string().optional().nullable(),
  maxReplies: z.number().optional(),
  scheduleCron: z.string().optional().nullable(),
  context: z.string().optional().nullable(),
  prompt: z.string().optional().nullable()
});

const automationUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  worker: z.string().optional(),
  model: z.string().optional().nullable(),
  reasoningEffort: z.string().optional().nullable(),
  maxReplies: z.number().optional(),
  scheduleCron: z.string().optional().nullable(),
  context: z.string().optional().nullable(),
  prompt: z.string().optional().nullable()
});

const robotSettingsSchema = z.object({
  maxConcurrentTurns: z.number()
});

const createTamperConfigSchema = z.object({
  forumId: z.string().optional().nullable(),
  pluginKey: z.string(),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  direction: z.enum(['inbound', 'outbound', 'both']).optional(),
  onlyFirstMessage: z.boolean().optional(),
  config: z.record(z.unknown()).nullable().optional()
});

const updateTamperConfigSchema = z.object({
  forumId: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  direction: z.enum(['inbound', 'outbound', 'both']).optional(),
  onlyFirstMessage: z.boolean().optional(),
  config: z.record(z.unknown()).nullable().optional()
});

const tamperTestSchema = z.object({
  text: z.string(),
  forumId: z.string().optional().nullable(),
  stage: z.string().optional(),
  direction: z.string().optional(),
  pluginKey: z.string().optional().nullable(),
  pluginConfig: z.record(z.unknown()).optional().nullable(),
  onlyPlugin: z.boolean().optional(),
  isFirstMessage: z.boolean().optional()
});

const adminUserCreateSchema = z.object({
  displayName: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  kind: z.string().optional()
});

const adminUserUpdateSchema = z.object({
  displayName: z.string().optional(),
  kind: z.string().optional(),
  password: z.string().optional()
});

const adminForumCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional().nullable(),
  cwd: z.string().optional().nullable(),
  prePrompt: z.string().optional().nullable(),
  parentForumId: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  status: z.enum(['active', 'archived']).optional(),
  visibility: z.enum(['public', 'members', 'admin']).optional()
});

const adminForumUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional().nullable(),
  cwd: z.string().optional().nullable(),
  prePrompt: z.string().optional().nullable(),
  parentForumId: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  status: z.enum(['active', 'archived']).optional(),
  visibility: z.enum(['public', 'members', 'admin']).optional(),
  archivedAt: z.string().optional().nullable()
});

const adminPersonaCreateSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  description: z.string().optional().nullable(),
  accentColor: z.string().optional().nullable(),
  avatarUrl: z.string().optional().nullable(),
  signature: z.string().optional().nullable(),
  soul: z.string().optional().nullable()
});

const adminPersonaUpdateSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional().nullable(),
  accentColor: z.string().optional().nullable(),
  avatarUrl: z.string().optional().nullable(),
  signature: z.string().optional().nullable(),
  soul: z.string().optional().nullable()
});

const webhookCreateSchema = z.object({
  url: z.string(),
  secret: z.string(),
  events: z.array(z.string())
});

const webhookUpdateSchema = z.object({
  url: z.string().optional(),
  secret: z.string().optional(),
  events: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});

const webhookResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const webhookListSchema = z.array(webhookResponseSchema);

const tenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string()
});

const tenantListSchema = z.array(tenantSchema);

const tenantCreateSchema = z.object({
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.unknown()).optional()
});

const tenantUpdateSchema = z.object({
  name: z.string().optional(),
  settings: z.record(z.unknown()).optional()
});

const roleSchema = z.object({
  id: z.string(),
  tenantId: z.string().nullable().optional(),
  name: z.string(),
  permissions: z.array(z.string()),
  createdAt: z.string()
});

const roleListSchema = z.array(roleSchema);

const roleCreateSchema = z.object({
  name: z.string(),
  tenantId: z.string().optional().nullable(),
  permissions: z.array(z.string()).optional()
});

const roleUpdateSchema = z.object({
  name: z.string().optional(),
  permissions: z.array(z.string()).optional()
});

const identityRoleListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    tenantId: z.string().nullable().optional(),
    permissions: z.array(z.string()),
    createdAt: z.string()
  })
);

const identityRoleUpdateSchema = z.object({
  roleId: z.string(),
  tenantId: z.string().optional().nullable()
});

const identityPermissionListSchema = schemas.IdentityPermissionsDtoSchema;

const accessRuleDeleteSchema = okSchema;

const deployOnFinishSchema = schemas.AdminDeployOnFinishResponseDtoSchema;

const deployCancelSchema = schemas.AdminCancelDeployOnFinishResponseDtoSchema;

const deployStatusSchema = schemas.AdminDeployStatusDtoSchema;

const deployResponseSchema = schemas.AdminDeployResponseDtoSchema;

const topicAutoRunUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  context: z.string().optional().nullable(),
  worker: z.enum(['echs']).optional(),
  model: z.string().optional().nullable(),
  reasoningEffort: z.string().optional().nullable(),
  maxReplies: z.number().optional().nullable(),
  resetCount: z.boolean().optional(),
  steerMessage: z.string().optional().nullable()
});

const autoRunRunSchema = z.object({
  steerMessage: z.string().optional().nullable()
});

const postDispatchSchema = z.object({
  model: z.string().optional().nullable(),
  reasoningEffort: z.string().optional().nullable()
});

const updatePostSchema = z.object({
  body: z.string()
});

const updateTopicStickySchema = z.object({
  sticky: z.boolean().optional(),
  tags: z.array(z.string()).optional()
});

const updateTopicTitleSchema = schemas.UpdateTopicTitleRequestSchema;

const updateTopicStatusSchema = schemas.UpdateTopicStatusRequestSchema;

const updateIdentitySchema = schemas.UpdateIdentityRequestSchema;
const messageTemplateWriteSchema = schemas.MessageTemplateWriteRequestSchema;
const messageTemplateUpdateSchema = schemas.MessageTemplateUpdateRequestSchema;
const messageTemplateReorderSchema = schemas.MessageTemplateReorderRequestSchema;
const messageTemplateEffectiveQuerySchema = schemas.MessageTemplateEffectiveQuerySchema;
const messageTemplateDeleteQuerySchema = schemas.MessageTemplateRevisionQuerySchema;
const okResponseSchema = z.object({ ok: z.boolean() });

const createTopicSchema = schemas.CreateTopicRequestSchema;

const createPostSchema = schemas.CreatePostRequestSchema;

const createForumSchema = schemas.CreateForumRequestSchema;

const createApiKeySchema = schemas.CreateApiKeyRequestSchema;

const createImpersonationSchema = schemas.CreateImpersonationTokenRequestSchema;

const loginSchema = schemas.LoginRequestSchema;

const registerSchema = schemas.RegisterRequestSchema;

const updatePrivateEmailSchema = schemas.UpdatePrivateEmailRequestSchema;

const verifyResponseSchema = schemas.VerifyResponseDtoSchema;

const inviteInfoSchema = schemas.InviteInfoDtoSchema;

const topicMoveResponseSchema = z.object({
  topic: schemas.TopicDtoSchema,
  move: schemas.TopicMoveDtoSchema
});

const notificationResponseSchema = schemas.NotificationDtoSchema;

const subscriptionsResponseSchema = itemsSchema(schemas.TopicSubscriptionDtoSchema);

const searchResponseSchema = schemas.SearchResultsDtoSchema;

const userFilesResponseSchema = z.array(schemas.UserFileDtoSchema);

const attachmentsResponseSchema = z.array(schemas.AttachmentDtoSchema);

const topicAttachmentsResponseSchema = schemas.TopicAttachmentsDtoSchema;

const identityListResponseSchema = pageSchema(schemas.IdentityDtoSchema);

const postListResponseSchema = pageSchema(schemas.PostDtoSchema);

const topicListResponseSchema = pageSchema(schemas.TopicDtoSchema);

const adminUserListSchema = pageSchema(schemas.AdminUserDtoSchema);

const inviteListSchema = pageSchema(schemas.InviteDtoSchema);

const forumListSchema = z.array(schemas.ForumDtoSchema);

export const apiRoutes: ApiRoute[] = [
  // System
  {
    method: 'get',
    path: '/openapi.json',
    summary: 'Download OpenAPI spec',
    tags: ['system'],
    response: { schema: z.record(z.unknown()) }
  },
  {
    method: 'get',
    path: '/models',
    summary: 'List available models',
    tags: ['system'],
    response: { schema: schemas.ModelCatalogDtoSchema }
  },

  // Auth
  {
    method: 'post',
    path: '/auth/login',
    summary: 'Login',
    tags: ['auth'],
    request: { body: { schema: loginSchema } },
    response: { schema: schemas.LoginResponseDtoSchema }
  },
  {
    method: 'post',
    path: '/auth/logout',
    summary: 'Logout',
    tags: ['auth'],
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/auth/me',
    summary: 'Get current user',
    tags: ['auth'],
    response: { schema: schemas.AuthUserDtoSchema }
  },
  {
    method: 'get',
    path: '/auth/registration',
    summary: 'Get registration mode',
    tags: ['auth'],
    response: { schema: schemas.RegistrationModeDtoSchema }
  },
  {
    method: 'post',
    path: '/auth/register',
    summary: 'Register',
    tags: ['auth'],
    request: { body: { schema: registerSchema } },
    response: { schema: schemas.RegisterResponseDtoSchema }
  },
  {
    method: 'get',
    path: '/auth/verify/{token}',
    summary: 'Verify registration token',
    tags: ['auth'],
    request: { params: stringParam('token') },
    response: { schema: verifyResponseSchema }
  },
  {
    method: 'get',
    path: '/auth/invite/{code}',
    summary: 'Get invite info',
    tags: ['auth'],
    request: { params: stringParam('code') },
    response: { schema: inviteInfoSchema }
  },

  {
    method: 'post', path: '/auth/webauthn/login/options', summary: 'Begin usernameless passkey login', tags: ['auth'],
    response: { schema: schemas.WebAuthnOptionsResponseDtoSchema }
  },
  {
    method: 'post', path: '/auth/webauthn/login/verify', summary: 'Complete passkey login', tags: ['auth'],
    request: { body: { schema: schemas.WebAuthnVerifyRequestSchema } }, response: { schema: schemas.WebAuthnLoginResponseDtoSchema }
  },
  {
    method: 'get', path: '/me/webauthn/credentials', summary: 'List passkeys', tags: ['auth'],
    response: { schema: schemas.WebAuthnCredentialListResponseDtoSchema }
  },
  {
    method: 'post', path: '/me/webauthn/register/options', summary: 'Begin passkey enrollment', tags: ['auth'],
    response: { schema: schemas.WebAuthnOptionsResponseDtoSchema }
  },
  {
    method: 'post', path: '/me/webauthn/register/verify', summary: 'Complete passkey enrollment', tags: ['auth'],
    request: { body: { schema: schemas.WebAuthnRegistrationVerifyRequestSchema } }, response: { schema: schemas.WebAuthnCredentialDtoSchema }
  },
  {
    method: 'delete', path: '/me/webauthn/credentials/{credentialId}', summary: 'Remove a passkey', tags: ['auth'],
    request: { params: stringParam('credentialId') }, response: { schema: okSchema }
  },

  {
    method: 'patch',
    path: '/me/private-email',
    summary: 'Update private email',
    tags: ['auth'],
    request: { body: { schema: updatePrivateEmailSchema } },
    response: { schema: schemas.UpdatePrivateEmailResponseDtoSchema }
  },

  {
    method: 'post',
    path: '/me/password',
    summary: 'Change current user password',
    tags: ['auth'],
    request: { body: { schema: schemas.ChangePasswordRequestSchema } },
    response: { schema: schemas.ChangePasswordResponseDtoSchema }
  },
  {
    method: 'delete', path: '/me/password', summary: 'Remove current user password after passkey enrollment', tags: ['auth'],
    response: { schema: okSchema }
  },
  {
    method: 'post', path: '/me/password/create', summary: 'Create a password from a recent passkey session', tags: ['auth'],
    request: { body: { schema: schemas.CreatePasswordRequestSchema } }, response: { schema: okSchema }
  },

  // API keys
  {
    method: 'get',
    path: '/api-keys',
    summary: 'List API keys',
    tags: ['auth'],
    response: { schema: schemas.ApiKeyListResponseDtoSchema }
  },
  {
    method: 'post',
    path: '/api-keys',
    summary: 'Create API key',
    tags: ['auth'],
    request: { body: { schema: createApiKeySchema } },
    response: { schema: schemas.ApiKeyCreateResponseDtoSchema }
  },
  {
    method: 'delete',
    path: '/api-keys/{id}',
    summary: 'Revoke API key',
    tags: ['auth'],
    request: { params: stringParam('id') },
    response: { schema: okSchema }
  },

  // Impersonation tokens
  {
    method: 'get',
    path: '/impersonation-tokens',
    summary: 'List impersonation tokens',
    tags: ['auth'],
    response: { schema: schemas.ImpersonationTokenListResponseDtoSchema }
  },
  {
    method: 'post',
    path: '/impersonation-tokens',
    summary: 'Create impersonation token',
    tags: ['auth'],
    request: { body: { schema: createImpersonationSchema } },
    response: { schema: schemas.ImpersonationTokenCreateResponseDtoSchema }
  },
  {
    method: 'delete',
    path: '/impersonation-tokens/{id}',
    summary: 'Revoke impersonation token',
    tags: ['auth'],
    request: { params: stringParam('id') },
    response: { schema: okSchema }
  },

  // Invites (admin)
  {
    method: 'get',
    path: '/invites',
    summary: 'List invites',
    tags: ['admin'],
    request: { query: paginationQuerySchema },
    response: { schema: inviteListSchema }
  },
  {
    method: 'post',
    path: '/invites',
    summary: 'Create invite',
    tags: ['admin'],
    request: { body: { schema: createInviteSchema } },
    response: { schema: schemas.InviteDtoSchema }
  },
  {
    method: 'delete',
    path: '/invites/{inviteId}',
    summary: 'Delete invite',
    tags: ['admin'],
    request: { params: stringParam('inviteId') },
    response: { schema: okSchema }
  },

  // Forums + topics
  {
    method: 'get',
    path: '/forums',
    summary: 'List forums',
    tags: ['forums'],
    request: { query: listForumsQuerySchema },
    response: { schema: forumListSchema }
  },
  {
    method: 'post',
    path: '/forums',
    summary: 'Create forum',
    tags: ['forums'],
    request: { body: { schema: createForumSchema } },
    response: { schema: schemas.ForumDtoSchema }
  },
  {
    method: 'get',
    path: '/forums/{forumId}/topics',
    summary: 'List topics',
    tags: ['topics'],
    request: { params: stringParam('forumId'), query: listTopicsQuerySchema },
    response: { schema: topicListResponseSchema }
  },
  {
    method: 'post',
    path: '/forums/{forumId}/topics',
    summary: 'Create topic',
    tags: ['topics'],
    request: { params: stringParam('forumId'), body: { schema: createTopicSchema } },
    response: { schema: schemas.TopicDtoSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}',
    summary: 'Get topic',
    tags: ['topics'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.TopicDtoSchema }
  },
  {
    method: 'patch',
    path: '/topics/{topicId}/status',
    summary: 'Update topic status',
    tags: ['topics'],
    request: { params: stringParam('topicId'), body: { schema: updateTopicStatusSchema } },
    response: { schema: schemas.TopicDtoSchema }
  },
  {
    method: 'patch',
    path: '/topics/{topicId}',
    summary: 'Update topic title',
    tags: ['topics'],
    request: { params: stringParam('topicId'), body: { schema: updateTopicTitleSchema } },
    response: { schema: schemas.TopicDtoSchema }
  },
  {
    method: 'patch',
    path: '/topics/{topicId}/tags',
    summary: 'Update topic tags',
    tags: ['topics'],
    request: { params: stringParam('topicId'), body: { schema: updateTopicStickySchema } },
    response: { schema: schemas.TopicDtoSchema }
  },
  {
    method: 'delete',
    path: '/topics/{topicId}',
    summary: 'Delete topic',
    tags: ['topics'],
    request: { params: stringParam('topicId') },
    response: { schema: okSchema }
  },

  // Operational timeline and maintenance
  {
    method: 'get',
    path: '/topics/{topicId}/operational-events',
    summary: 'List durable topic operational events',
    tags: ['topics'],
    request: { params: stringParam('topicId') },
    response: { schema: itemsSchema(schemas.TopicOperationalEventDtoSchema) }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/compactions',
    summary: 'Get active and latest durable compaction state',
    tags: ['topics'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.TopicCompactionStateDtoSchema }
  },
  {
    method: 'post',
    path: '/topics/{topicId}/compactions',
    summary: 'Accept a durable compaction job for a linked idle Pi conversation',
    tags: ['topics'],
    request: { params: stringParam('topicId'), body: { schema: schemas.CreateCompactionRequestSchema } },
    response: { schema: schemas.CompactionOperationDtoSchema, statusCode: 202, description: 'Accepted' }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/compactions/{operationId}',
    summary: 'Get a durable compaction operation',
    tags: ['topics'],
    request: { params: z.object({ topicId: z.string(), operationId: z.string() }) },
    response: { schema: schemas.CompactionOperationDtoSchema }
  },
  {
    method: 'post',
    path: '/topics/{topicId}/compactions/{operationId}/retry-checkpoint',
    summary: 'Retry a terminally failed recovery-checkpoint dispatch',
    tags: ['topics'],
    request: { params: z.object({ topicId: z.string(), operationId: z.string() }) },
    response: { schema: schemas.TopicCompactionStateDtoSchema }
  },

  // Posts
  {
    method: 'get',
    path: '/topics/{topicId}/posts',
    summary: 'List posts',
    tags: ['posts'],
    request: { params: stringParam('topicId'), query: listPostsQuerySchema },
    response: { schema: postListResponseSchema }
  },
  {
    method: 'post',
    path: '/topics/{topicId}/posts',
    summary: 'Create post',
    tags: ['posts'],
    request: { params: stringParam('topicId'), body: { schema: createPostSchema } },
    response: { schema: schemas.PostDtoSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/dispatch',
    summary: 'Dispatch post to robot',
    tags: ['posts'],
    request: { params: stringParam('postId'), body: { schema: postDispatchSchema } },
    response: { schema: okDispatchedSchema }
  },
  {
    method: 'patch',
    path: '/posts/{postId}',
    summary: 'Update post',
    tags: ['posts'],
    request: { params: stringParam('postId'), body: { schema: updatePostSchema } },
    response: { schema: schemas.PostDtoSchema }
  },
  {
    method: 'delete',
    path: '/posts/{postId}',
    summary: 'Delete post',
    tags: ['posts'],
    request: { params: stringParam('postId') },
    response: { schema: schemas.PostDtoSchema }
  },

  // Reactions
  {
    method: 'post',
    path: '/posts/{postId}/reactions',
    summary: 'Add reaction',
    tags: ['reactions'],
    request: { params: stringParam('postId'), body: { schema: z.object({ emoji: z.string() }) } },
    response: { schema: okSchema }
  },
  {
    method: 'delete',
    path: '/posts/{postId}/reactions/{emoji}',
    summary: 'Remove reaction',
    tags: ['reactions'],
    request: { params: z.object({ postId: z.string(), emoji: z.string() }) },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/posts/{postId}/reactions',
    summary: 'List reactions',
    tags: ['reactions'],
    request: { params: stringParam('postId') },
    response: { schema: reactionListSchema }
  },
  {
    method: 'get',
    path: '/posts/{postId}/reactions/counts',
    summary: 'Reaction counts',
    tags: ['reactions'],
    request: { params: stringParam('postId') },
    response: { schema: reactionCountsSchema }
  },

  // Recent posts
  {
    method: 'get',
    path: '/posts/recent',
    summary: 'List recent posts',
    tags: ['posts'],
    request: { query: recentPostsQuerySchema },
    response: { schema: recentPostsResponseSchema }
  },

  // Search
  {
    method: 'get',
    path: '/search',
    summary: 'Search',
    tags: ['search'],
    request: { query: searchQuerySchema },
    response: { schema: searchResponseSchema }
  },

  // Identities + profiles
  {
    method: 'get',
    path: '/identities/{identityId}',
    summary: 'Get identity',
    tags: ['identities'],
    request: { params: stringParam('identityId') },
    response: { schema: schemas.IdentityDtoSchema }
  },
  {
    method: 'patch',
    path: '/identities/{identityId}',
    summary: 'Update identity',
    tags: ['identities'],
    request: { params: stringParam('identityId'), body: { schema: updateIdentitySchema } },
    response: { schema: schemas.IdentityDtoSchema }
  },
  {
    method: 'post',
    path: '/identities/{identityId}/avatar',
    summary: 'Upload avatar',
    tags: ['identities'],
    request: { params: stringParam('identityId'), body: { schema: fileUploadSchema, contentType: 'multipart/form-data' } },
    response: { schema: avatarUploadResponseSchema }
  },
  {
    method: 'get',
    path: '/profiles/{identityId}',
    summary: 'Get profile',
    tags: ['profiles'],
    request: { params: stringParam('identityId') },
    response: { schema: schemas.UserProfileDtoSchema }
  },
  {
    method: 'get',
    path: '/profiles/{identityId}/posts',
    summary: 'List profile posts',
    tags: ['profiles'],
    request: { params: stringParam('identityId'), query: paginationQuerySchema },
    response: { schema: schemas.UserPostHistoryResponseDtoSchema }
  },

  // Message templates
  {
    method: 'get', path: '/message-templates/effective', summary: 'List effective message templates', tags: ['message-templates'],
    request: { query: messageTemplateEffectiveQuerySchema }, response: { schema: schemas.MessageTemplateListResponseDtoSchema }
  },
  {
    method: 'get', path: '/message-templates/mine', summary: 'List personal message templates', tags: ['message-templates'],
    response: { schema: schemas.MessageTemplateListResponseDtoSchema }
  },
  {
    method: 'post', path: '/message-templates', summary: 'Create personal message template', tags: ['message-templates'],
    request: { body: { schema: messageTemplateWriteSchema } }, response: { schema: schemas.MessageTemplateDtoSchema }
  },
  {
    method: 'patch', path: '/message-templates/{id}', summary: 'Update personal message template', tags: ['message-templates'],
    request: { params: stringParam('id'), body: { schema: messageTemplateUpdateSchema } }, response: { schema: schemas.MessageTemplateDtoSchema }
  },
  {
    method: 'delete', path: '/message-templates/{id}', summary: 'Delete personal message template', tags: ['message-templates'],
    request: { params: stringParam('id'), query: messageTemplateDeleteQuerySchema }, response: { schema: okResponseSchema }
  },
  {
    method: 'post', path: '/message-templates/reorder', summary: 'Reorder personal message templates', tags: ['message-templates'],
    request: { body: { schema: messageTemplateReorderSchema } }, response: { schema: schemas.MessageTemplateListResponseDtoSchema }
  },
  {
    method: 'get', path: '/admin/message-templates', summary: 'List system message templates', tags: ['admin', 'message-templates'],
    response: { schema: schemas.MessageTemplateListResponseDtoSchema }
  },
  {
    method: 'post', path: '/admin/message-templates', summary: 'Create system message template', tags: ['admin', 'message-templates'],
    request: { body: { schema: messageTemplateWriteSchema } }, response: { schema: schemas.MessageTemplateDtoSchema }
  },
  {
    method: 'patch', path: '/admin/message-templates/{id}', summary: 'Update system message template', tags: ['admin', 'message-templates'],
    request: { params: stringParam('id'), body: { schema: messageTemplateUpdateSchema } }, response: { schema: schemas.MessageTemplateDtoSchema }
  },
  {
    method: 'delete', path: '/admin/message-templates/{id}', summary: 'Delete system message template', tags: ['admin', 'message-templates'],
    request: { params: stringParam('id'), query: messageTemplateDeleteQuerySchema }, response: { schema: okResponseSchema }
  },
  {
    method: 'post', path: '/admin/message-templates/reorder', summary: 'Reorder system message templates', tags: ['admin', 'message-templates'],
    request: { body: { schema: messageTemplateReorderSchema } }, response: { schema: schemas.MessageTemplateListResponseDtoSchema }
  },
  // Topic extras
  {
    method: 'get',
    path: '/topics/{topicId}/identities',
    summary: 'List topic identities',
    tags: ['topics'],
    request: { params: stringParam('topicId'), query: listIdentitiesQuerySchema },
    response: { schema: identityListResponseSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/personas',
    summary: 'List topic personas',
    tags: ['topics'],
    request: { params: stringParam('topicId') },
    response: { schema: topicPersonaResponseSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/state',
    summary: 'Get robot state',
    tags: ['robot'],
    request: { params: stringParam('topicId'), query: robotStateQuerySchema },
    response: { schema: schemas.RobotStateDtoSchema.nullable() }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/auto-run',
    summary: 'Get auto-run state',
    tags: ['robot'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.TopicAutoRunDtoSchema }
  },
  {
    method: 'patch',
    path: '/topics/{topicId}/auto-run',
    summary: 'Update auto-run state',
    tags: ['robot'],
    request: { params: stringParam('topicId'), body: { schema: topicAutoRunUpdateSchema } },
    response: { schema: schemas.TopicAutoRunDtoSchema }
  },
  {
    method: 'post',
    path: '/topics/{topicId}/auto-run/run',
    summary: 'Run auto-run',
    tags: ['robot'],
    request: { params: stringParam('topicId'), body: { schema: autoRunRunSchema } },
    response: { schema: okMessageSchema }
  },
  {
    method: 'post',
    path: '/topics/{topicId}/robot/interrupt',
    summary: 'Interrupt robot',
    tags: ['robot'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.RobotStopResultDtoSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/session',
    summary: 'Get session by topic',
    tags: ['robot'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.SessionDtoSchema.nullable() }
  },
  {
    method: 'get',
    path: '/sessions/{sessionId}/inspector',
    summary: 'Inspect session',
    tags: ['robot'],
    request: { params: stringParam('sessionId') },
    response: { schema: schemas.SessionInspectorDtoSchema }
  },

  // Notifications
  {
    method: 'get',
    path: '/notifications',
    summary: 'List notifications',
    tags: ['notifications'],
    request: { query: listNotificationsQuerySchema },
    response: { schema: notificationListSchema }
  },
  {
    method: 'patch',
    path: '/notifications/{id}',
    summary: 'Update notification',
    tags: ['notifications'],
    request: { params: stringParam('id'), body: { schema: notificationPatchSchema } },
    response: { schema: notificationResponseSchema }
  },
  {
    method: 'post',
    path: '/notifications/mark-all-read',
    summary: 'Mark all notifications read',
    tags: ['notifications'],
    response: { schema: okReadCountSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/unread',
    summary: 'Get topic unread state',
    tags: ['notifications'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.TopicUnreadDtoSchema }
  },
  {
    method: 'put',
    path: '/topics/{topicId}/read',
    summary: 'Mark topic read',
    tags: ['notifications'],
    request: { params: stringParam('topicId'), body: { schema: topicReadSchema } },
    response: { schema: schemas.TopicUnreadDtoSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/subscription',
    summary: 'Get topic subscription',
    tags: ['notifications'],
    request: { params: stringParam('topicId') },
    response: { schema: schemas.TopicSubscriptionDtoSchema }
  },
  {
    method: 'put',
    path: '/topics/{topicId}/subscription',
    summary: 'Update topic subscription',
    tags: ['notifications'],
    request: { params: stringParam('topicId'), body: { schema: topicSubscriptionSchema } },
    response: { schema: schemas.TopicSubscriptionDtoSchema }
  },
  {
    method: 'get',
    path: '/me/subscriptions',
    summary: 'List topic subscriptions',
    tags: ['notifications'],
    response: { schema: subscriptionsResponseSchema }
  },

  // Attachments & files
  {
    method: 'get',
    path: '/user-files',
    summary: 'List user files',
    tags: ['attachments'],
    response: { schema: userFilesResponseSchema }
  },
  {
    method: 'post',
    path: '/user-files',
    summary: 'Upload user file',
    tags: ['attachments'],
    request: { body: { schema: fileUploadSchema, contentType: 'multipart/form-data' } },
    response: { schema: schemas.UserFileDtoSchema }
  },
  {
    method: 'get',
    path: '/user-files/{fileId}',
    summary: 'Download user file',
    tags: ['attachments'],
    request: { params: stringParam('fileId') },
    response: { schema: attachmentContentSchema, contentType: 'application/octet-stream' }
  },
  {
    method: 'delete',
    path: '/user-files/{fileId}',
    summary: 'Delete user file',
    tags: ['attachments'],
    request: { params: stringParam('fileId') },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/topics/{topicId}/attachments',
    summary: 'List topic attachments grouped by post',
    tags: ['attachments'],
    request: { params: stringParam('topicId') },
    response: { schema: topicAttachmentsResponseSchema }
  },
  {
    method: 'get',
    path: '/posts/{postId}/attachments',
    summary: 'List post attachments',
    tags: ['attachments'],
    request: { params: stringParam('postId') },
    response: { schema: attachmentsResponseSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/attachments',
    summary: 'Upload post attachment',
    tags: ['attachments'],
    request: { params: stringParam('postId'), body: { schema: fileUploadSchema, contentType: 'multipart/form-data' } },
    response: { schema: schemas.AttachmentDtoSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/attachments/chunked/start',
    summary: 'Start chunked upload',
    tags: ['attachments'],
    request: { params: stringParam('postId'), body: { schema: chunkUploadSchema } },
    response: {
      schema: z.object({
        uploadId: z.string(),
        chunkBytes: z.number(),
        totalChunks: z.number()
      })
    }
  },
  {
    method: 'post',
    path: '/posts/{postId}/attachments/chunked/{uploadId}/chunk',
    summary: 'Upload chunk',
    tags: ['attachments'],
    request: {
      params: z.object({ postId: z.string(), uploadId: z.string() }),
      query: chunkIndexQuerySchema,
      body: { schema: fileUploadSchema, contentType: 'multipart/form-data' }
    },
    response: { schema: chunkUploadResponseSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/attachments/chunked/{uploadId}/complete',
    summary: 'Complete chunked upload',
    tags: ['attachments'],
    request: { params: z.object({ postId: z.string(), uploadId: z.string() }) },
    response: { schema: schemas.AttachmentDtoSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/attachments/chunked/{uploadId}/abort',
    summary: 'Abort chunked upload',
    tags: ['attachments'],
    request: { params: z.object({ postId: z.string(), uploadId: z.string() }) },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/attachments/{attachmentId}',
    summary: 'Download attachment',
    tags: ['attachments'],
    request: { params: stringParam('attachmentId') },
    response: { schema: attachmentContentSchema, contentType: 'application/octet-stream' }
  },
  {
    method: 'delete',
    path: '/attachments/{attachmentId}',
    summary: 'Delete attachment',
    tags: ['attachments'],
    request: { params: stringParam('attachmentId') },
    response: { schema: okSchema }
  },
  {
    method: 'post',
    path: '/posts/{postId}/tts',
    summary: 'Generate TTS attachment',
    tags: ['attachments'],
    request: { params: stringParam('postId') },
    response: { schema: schemas.AttachmentDtoSchema }
  },

  // Adapters
  {
    method: 'get',
    path: '/adapters/discord/status',
    summary: 'Discord status',
    tags: ['adapters'],
    response: { schema: schemas.DiscordBridgeStatusDtoSchema }
  },
  {
    method: 'post',
    path: '/adapters/discord/connect',
    summary: 'Connect Discord adapter',
    tags: ['adapters'],
    response: { schema: discordConnectResponseSchema }
  },
  {
    method: 'post',
    path: '/adapters/discord/disconnect',
    summary: 'Disconnect Discord adapter',
    tags: ['adapters'],
    response: { schema: okMessageSchema }
  },
  {
    method: 'post',
    path: '/adapters/discord/map',
    summary: 'Map Discord channel',
    tags: ['adapters'],
    request: { body: { schema: z.object({ channelId: z.string(), forumId: z.string().optional() }) } },
    response: { schema: discordMapResponseSchema }
  },
  {
    method: 'delete',
    path: '/adapters/discord/map/{channelId}',
    summary: 'Unmap Discord channel',
    tags: ['adapters'],
    request: { params: stringParam('channelId') },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/adapters/matrix/status',
    summary: 'Matrix status',
    tags: ['adapters'],
    response: { schema: schemas.MatrixBridgeStatusDtoSchema }
  },
  {
    method: 'post',
    path: '/adapters/matrix/connect',
    summary: 'Connect Matrix adapter',
    tags: ['adapters'],
    response: { schema: matrixConnectResponseSchema }
  },
  {
    method: 'post',
    path: '/adapters/matrix/disconnect',
    summary: 'Disconnect Matrix adapter',
    tags: ['adapters'],
    response: { schema: okMessageSchema }
  },
  {
    method: 'post',
    path: '/adapters/matrix/map',
    summary: 'Map Matrix room',
    tags: ['adapters'],
    request: { body: { schema: z.object({ roomId: z.string(), forumId: z.string().optional() }) } },
    response: { schema: matrixMapResponseSchema }
  },
  {
    method: 'delete',
    path: '/adapters/matrix/map/{roomId}',
    summary: 'Unmap Matrix room',
    tags: ['adapters'],
    request: { params: stringParam('roomId') },
    response: { schema: okSchema }
  },

  // Admin - users
  {
    method: 'get',
    path: '/admin/users',
    summary: 'List users',
    tags: ['admin'],
    request: { query: paginationQuerySchema },
    response: { schema: adminUserListSchema }
  },
  {
    method: 'post',
    path: '/admin/users',
    summary: 'Create user',
    tags: ['admin'],
    request: { body: { schema: adminUserCreateSchema } },
    response: { schema: schemas.AdminUserDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/users/{userId}',
    summary: 'Update user',
    tags: ['admin'],
    request: { params: stringParam('userId'), body: { schema: adminUserUpdateSchema } },
    response: { schema: schemas.AdminUserDtoSchema }
  },
  {
    method: 'delete',
    path: '/admin/users/{userId}',
    summary: 'Delete user',
    tags: ['admin'],
    request: { params: stringParam('userId') },
    response: { schema: okSchema }
  },

  // Admin - forums/personas/access
  {
    method: 'get',
    path: '/admin/forums',
    summary: 'List admin forums',
    tags: ['admin'],
    response: { schema: adminForumListSchema }
  },
  {
    method: 'post',
    path: '/admin/forums',
    summary: 'Create admin forum',
    tags: ['admin'],
    request: { body: { schema: adminForumCreateSchema } },
    response: { schema: schemas.AdminForumDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/forums/{forumId}',
    summary: 'Update admin forum',
    tags: ['admin'],
    request: { params: stringParam('forumId'), body: { schema: adminForumUpdateSchema } },
    response: { schema: schemas.AdminForumDtoSchema }
  },
  {
    method: 'delete',
    path: '/admin/forums/{forumId}',
    summary: 'Delete admin forum',
    tags: ['admin'],
    request: { params: stringParam('forumId') },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/admin/forums/{forumId}/personas',
    summary: 'List admin personas',
    tags: ['admin'],
    request: { params: stringParam('forumId') },
    response: { schema: adminForumPersonaResponseSchema }
  },
  {
    method: 'post',
    path: '/admin/forums/{forumId}/personas',
    summary: 'Create admin persona',
    tags: ['admin'],
    request: { params: stringParam('forumId'), body: { schema: adminPersonaCreateSchema } },
    response: { schema: schemas.AdminRobotPersonaDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/forums/{forumId}/personas/{key}',
    summary: 'Update admin persona',
    tags: ['admin'],
    request: { params: z.object({ forumId: z.string(), key: z.string() }), body: { schema: adminPersonaUpdateSchema } },
    response: { schema: schemas.AdminRobotPersonaDtoSchema }
  },
  {
    method: 'delete',
    path: '/admin/forums/{forumId}/personas/{key}',
    summary: 'Delete admin persona',
    tags: ['admin'],
    request: { params: z.object({ forumId: z.string(), key: z.string() }) },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/admin/forums/{forumId}/access',
    summary: 'List forum access rules',
    tags: ['admin'],
    request: { params: stringParam('forumId') },
    response: { schema: forumAccessRuleResponseSchema }
  },
  {
    method: 'post',
    path: '/admin/forums/{forumId}/access',
    summary: 'Create forum access rule',
    tags: ['admin'],
    request: { params: stringParam('forumId'), body: { schema: createForumAccessRuleSchema } },
    response: { schema: schemas.AccessRuleDtoSchema }
  },
  {
    method: 'get',
    path: '/admin/topics/{topicId}/access',
    summary: 'List topic access rules',
    tags: ['admin'],
    request: { params: stringParam('topicId') },
    response: { schema: topicAccessRuleResponseSchema }
  },
  {
    method: 'post',
    path: '/admin/topics/{topicId}/access',
    summary: 'Create topic access rule',
    tags: ['admin'],
    request: { params: stringParam('topicId'), body: { schema: createTopicAccessRuleSchema } },
    response: { schema: schemas.AccessRuleDtoSchema }
  },
  {
    method: 'post',
    path: '/admin/topics/{topicId}/move',
    summary: 'Move topic',
    tags: ['admin'],
    request: { params: stringParam('topicId'), body: { schema: moveTopicSchema } },
    response: { schema: topicMoveResponseSchema }
  },
  {
    method: 'delete',
    path: '/admin/access/{ruleId}',
    summary: 'Delete access rule',
    tags: ['admin'],
    request: { params: stringParam('ruleId') },
    response: { schema: accessRuleDeleteSchema }
  },

  // Admin - deploy
  {
    method: 'get',
    path: '/admin/deploy/status',
    summary: 'Get deploy status',
    tags: ['admin'],
    response: { schema: deployStatusSchema }
  },
  {
    method: 'post',
    path: '/admin/deploy',
    summary: 'Trigger deploy',
    tags: ['admin'],
    response: { schema: deployResponseSchema }
  },
  {
    method: 'post',
    path: '/admin/deploy/on-finish',
    summary: 'Deploy on finish',
    tags: ['admin'],
    response: { schema: deployOnFinishSchema }
  },
  {
    method: 'post',
    path: '/admin/deploy/on-finish/cancel',
    summary: 'Cancel deploy on finish',
    tags: ['admin'],
    response: { schema: deployCancelSchema }
  },

  // Admin - robot automation
  {
    method: 'get',
    path: '/admin/robot/automations',
    summary: 'List automations',
    tags: ['admin'],
    response: { schema: robotAutomationListSchema }
  },
  {
    method: 'post',
    path: '/admin/robot/automations',
    summary: 'Create automation',
    tags: ['admin'],
    request: { body: { schema: automationCreateSchema } },
    response: { schema: schemas.RobotAutomationDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/robot/automations/{automationId}',
    summary: 'Update automation',
    tags: ['admin'],
    request: { params: stringParam('automationId'), body: { schema: automationUpdateSchema } },
    response: { schema: schemas.RobotAutomationDtoSchema }
  },
  {
    method: 'delete',
    path: '/admin/robot/automations/{automationId}',
    summary: 'Delete automation',
    tags: ['admin'],
    request: { params: stringParam('automationId') },
    response: { schema: okSchema }
  },
  {
    method: 'post',
    path: '/admin/robot/automations/{automationId}/run',
    summary: 'Run automation',
    tags: ['admin'],
    request: { params: stringParam('automationId') },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/admin/robot/automations/{automationId}/runs',
    summary: 'List automation runs',
    tags: ['admin'],
    request: { params: stringParam('automationId') },
    response: { schema: robotAutomationRunListSchema }
  },
  {
    method: 'get',
    path: '/admin/analytics',
    summary: 'Forum and canonical Pi analytics',
    tags: ['admin'],
    request: { query: schemas.AdminAnalyticsQuerySchema },
    response: { schema: schemas.AdminAnalyticsDtoSchema }
  },
  {
    method: 'get',
    path: '/admin/robot/dashboard',
    summary: 'Robot dashboard',
    tags: ['admin'],
    response: { schema: schemas.RobotDashboardDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/robot/settings',
    summary: 'Update robot settings',
    tags: ['admin'],
    request: { body: { schema: robotSettingsSchema } },
    response: { schema: z.object({ maxConcurrentTurns: z.number() }) }
  },

  // Admin - skills & tampers
  {
    method: 'get',
    path: '/admin/skills',
    summary: 'List skills',
    tags: ['admin'],
    response: { schema: adminSkillListSchema }
  },
  {
    method: 'get',
    path: '/admin/tampers/plugins',
    summary: 'List tamper plugins',
    tags: ['admin'],
    response: { schema: tamperPluginsResponseSchema }
  },
  {
    method: 'get',
    path: '/admin/tampers',
    summary: 'List tamper configs',
    tags: ['admin'],
    request: { query: z.object({ forumId: z.string().optional() }) },
    response: { schema: tamperConfigsResponseSchema }
  },
  {
    method: 'post',
    path: '/admin/tampers',
    summary: 'Create tamper config',
    tags: ['admin'],
    request: { body: { schema: createTamperConfigSchema } },
    response: { schema: schemas.TamperConfigDtoSchema }
  },
  {
    method: 'patch',
    path: '/admin/tampers/{configId}',
    summary: 'Update tamper config',
    tags: ['admin'],
    request: { params: stringParam('configId'), body: { schema: updateTamperConfigSchema } },
    response: { schema: schemas.TamperConfigDtoSchema }
  },
  {
    method: 'delete',
    path: '/admin/tampers/{configId}',
    summary: 'Delete tamper config',
    tags: ['admin'],
    request: { params: stringParam('configId') },
    response: { schema: okSchema }
  },
  {
    method: 'post',
    path: '/admin/tampers/test',
    summary: 'Test tamper config',
    tags: ['admin'],
    request: { body: { schema: tamperTestSchema } },
    response: { schema: schemas.TamperTestResultDtoSchema }
  },

  // Webhooks
  {
    method: 'get',
    path: '/webhooks',
    summary: 'List webhooks',
    tags: ['admin'],
    response: { schema: webhookListSchema }
  },
  {
    method: 'post',
    path: '/webhooks',
    summary: 'Create webhook',
    tags: ['admin'],
    request: { body: { schema: webhookCreateSchema } },
    response: { schema: webhookResponseSchema }
  },
  {
    method: 'patch',
    path: '/webhooks/{webhookId}',
    summary: 'Update webhook',
    tags: ['admin'],
    request: { params: stringParam('webhookId'), body: { schema: webhookUpdateSchema } },
    response: { schema: webhookResponseSchema }
  },
  {
    method: 'delete',
    path: '/webhooks/{webhookId}',
    summary: 'Delete webhook',
    tags: ['admin'],
    request: { params: stringParam('webhookId') },
    response: { schema: okSchema }
  },

  // Tenants / roles
  {
    method: 'get',
    path: '/tenants',
    summary: 'List tenants',
    tags: ['admin'],
    response: { schema: tenantListSchema }
  },
  {
    method: 'post',
    path: '/tenants',
    summary: 'Create tenant',
    tags: ['admin'],
    request: { body: { schema: tenantCreateSchema } },
    response: { schema: tenantSchema }
  },
  {
    method: 'get',
    path: '/tenants/{tenantId}',
    summary: 'Get tenant',
    tags: ['admin'],
    request: { params: stringParam('tenantId') },
    response: { schema: tenantSchema }
  },
  {
    method: 'patch',
    path: '/tenants/{tenantId}',
    summary: 'Update tenant',
    tags: ['admin'],
    request: { params: stringParam('tenantId'), body: { schema: tenantUpdateSchema } },
    response: { schema: tenantSchema }
  },
  {
    method: 'delete',
    path: '/tenants/{tenantId}',
    summary: 'Delete tenant',
    tags: ['admin'],
    request: { params: stringParam('tenantId') },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/roles',
    summary: 'List roles',
    tags: ['admin'],
    request: { query: z.object({ tenantId: z.string().optional() }) },
    response: { schema: roleListSchema }
  },
  {
    method: 'post',
    path: '/roles',
    summary: 'Create role',
    tags: ['admin'],
    request: { body: { schema: roleCreateSchema } },
    response: { schema: roleSchema }
  },
  {
    method: 'patch',
    path: '/roles/{roleId}',
    summary: 'Update role',
    tags: ['admin'],
    request: { params: stringParam('roleId'), body: { schema: roleUpdateSchema } },
    response: { schema: roleSchema }
  },
  {
    method: 'delete',
    path: '/roles/{roleId}',
    summary: 'Delete role',
    tags: ['admin'],
    request: { params: stringParam('roleId') },
    response: { schema: okSchema }
  },
  {
    method: 'post',
    path: '/identities/{identityId}/roles',
    summary: 'Assign role to identity',
    tags: ['admin'],
    request: { params: stringParam('identityId'), body: { schema: identityRoleUpdateSchema } },
    response: { schema: okSchema }
  },
  {
    method: 'delete',
    path: '/identities/{identityId}/roles/{roleId}',
    summary: 'Remove role from identity',
    tags: ['admin'],
    request: {
      params: z.object({ identityId: z.string(), roleId: z.string() }),
      query: z.object({ tenantId: z.string().optional() })
    },
    response: { schema: okSchema }
  },
  {
    method: 'get',
    path: '/identities/{identityId}/roles',
    summary: 'List identity roles',
    tags: ['admin'],
    request: { params: stringParam('identityId'), query: z.object({ tenantId: z.string().optional() }) },
    response: { schema: identityRoleListSchema }
  },
  {
    method: 'get',
    path: '/identities/{identityId}/permissions',
    summary: 'List identity permissions',
    tags: ['admin'],
    request: { params: stringParam('identityId'), query: z.object({ tenantId: z.string().optional() }) },
    response: { schema: identityPermissionListSchema }
  }
];

