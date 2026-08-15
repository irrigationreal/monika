import type {
  MessageTemplateContext,
  MessageTemplateForumScope,
  NotepadDraftOptions,
  NotepadExpirationPreset,
} from '@irrigationreal/codex-forum-core';

import type {
  AdminAnalyticsDto,
  ExternalRefDto,
  ForumDto,
  IdentityDto,
  MessageDraftListResponseDto,
  MessageDraftResponseDto,
  MessageTemplateDto,
  MessageTemplateListResponseDto,
  NotepadEntryResponseDto,
  NotepadListResponseDto,
  PostDto,
  RobotStateDto,
  SessionDto,
  SessionInspectorDto,
  TopicDto,
} from './dto';
import type { PageResponse } from './pagination';
import type { ForumThemeKey } from './themes';

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

export interface DraftReferenceRequest {
  id: string;
  revision: number;
}

export interface MessageDraftWriteRequest {
  expectedRevision: number;
  title?: string | null | undefined;
  body: string;
  options?: NotepadDraftOptions | null | undefined;
}

export interface NotepadEntryWriteRequest {
  title?: string | null | undefined;
  body: string;
  tags?: string[] | undefined;
  expiration?: NotepadExpirationPreset | undefined;
  draft: DraftReferenceRequest;
}
export interface NotepadEntryUpdateRequest extends Omit<NotepadEntryWriteRequest, 'draft' | 'expiration'> {
  expectedRevision: number;
  expiration?: NotepadExpirationPreset | 'keep' | undefined;
  pinned?: boolean | undefined;
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
  /** Admin-only, shared thread policy. New topics default to false. */
  autoCompactEnabled?: boolean;
  /**
   * When true, the forum will store the post but will not dispatch a robot turn for it.
   * A subsequent non-silent post will include these silent posts as catch-up context once.
   */
  silent?: boolean;
  /** Exact private draft snapshot to consume atomically with publication. */
  draft?: DraftReferenceRequest;
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
  /** Admin-only desired shared thread policy; must be paired with its revision. */
  autoCompactEnabled?: boolean;
  autoCompactRevision?: number;
  /**
   * When true, the forum will store the post but will not dispatch a robot turn for it.
   * A subsequent non-silent post will include these silent posts as catch-up context once.
   */
  silent?: boolean;
  /** Exact private draft snapshot to consume atomically with publication. */
  draft?: DraftReferenceRequest;
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

export interface MessageTemplateWriteRequest {
  name: string;
  category?: string | null;
  body: string;
  threadTitle?: string | null;
  forumScope: MessageTemplateForumScope;
  forumIds: string[];
  contexts: MessageTemplateContext[];
  enabled: boolean;
}

export interface MessageTemplateUpdateRequest extends MessageTemplateWriteRequest {
  revision: number;
}

export interface MessageTemplateReorderRequest {
  items: { id: string; revision: number }[];
}

export interface UpdatePrivateEmailRequest {
  emailAddress: string | null;
}

export interface UpdateQuickReplyPreferenceRequest {
  quickReplyDockedByDefault: boolean;
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
  listDrafts(): Promise<MessageDraftListResponseDto>;
  getDraft(id: string): Promise<MessageDraftResponseDto>;
  listForumDrafts(forumId: string): Promise<MessageDraftListResponseDto>;
  getReplyDraft(topicId: string): Promise<MessageDraftResponseDto>;
  saveReplyDraft(topicId: string, req: MessageDraftWriteRequest): Promise<MessageDraftResponseDto>;
  createNewThreadDraft(forumId: string, req: MessageDraftWriteRequest): Promise<MessageDraftResponseDto>;
  updateDraft(id: string, req: MessageDraftWriteRequest): Promise<MessageDraftResponseDto>;
  deleteDraft(id: string, revision: number): Promise<{ ok: boolean }>;
  getNotepadDraft(): Promise<MessageDraftResponseDto>;
  saveNotepadDraft(req: MessageDraftWriteRequest): Promise<MessageDraftResponseDto>;
  listNotepad(input?: {
    query?: string;
    tags?: string[];
    cursor?: string;
    limit?: number;
  }): Promise<NotepadListResponseDto>;
  getNotepadEntry(id: string): Promise<NotepadEntryResponseDto>;
  createNotepadEntry(req: NotepadEntryWriteRequest): Promise<NotepadEntryResponseDto>;
  updateNotepadEntry(id: string, req: NotepadEntryUpdateRequest): Promise<NotepadEntryResponseDto>;
  deleteNotepadEntry(id: string, revision: number): Promise<{ ok: boolean }>;
  listEffectiveMessageTemplates(
    context: MessageTemplateContext,
    forumId: string
  ): Promise<MessageTemplateListResponseDto>;
  listMyMessageTemplates(): Promise<MessageTemplateListResponseDto>;
  createMessageTemplate(req: MessageTemplateWriteRequest): Promise<MessageTemplateDto>;
  updateMessageTemplate(id: string, req: MessageTemplateUpdateRequest): Promise<MessageTemplateDto>;
  deleteMessageTemplate(id: string, revision: number): Promise<{ ok: boolean }>;
  reorderMessageTemplates(req: MessageTemplateReorderRequest): Promise<MessageTemplateListResponseDto>;
  listSystemMessageTemplates(): Promise<MessageTemplateListResponseDto>;
  createSystemMessageTemplate(req: MessageTemplateWriteRequest): Promise<MessageTemplateDto>;
  updateSystemMessageTemplate(id: string, req: MessageTemplateUpdateRequest): Promise<MessageTemplateDto>;
  deleteSystemMessageTemplate(id: string, revision: number): Promise<{ ok: boolean }>;
  reorderSystemMessageTemplates(req: MessageTemplateReorderRequest): Promise<MessageTemplateListResponseDto>;
  listExternalRefs(topicId: string): Promise<ExternalRefDto[]>;
  getSessionByTopic(topicId: string): Promise<SessionDto | null>;
  getSession(sessionId: string): Promise<SessionDto | null>;
  getSessionInspector(sessionId: string): Promise<SessionInspectorDto>;
  getAdminAnalytics(
    input: {
      from: string;
      to: string;
      bucket: 'day' | 'week';
      forumId?: string | null;
    },
    options?: { signal?: AbortSignal }
  ): Promise<AdminAnalyticsDto>;
}

export interface ForumStreamApi {
  subscribeRobotState(topicId: string): AsyncIterable<RobotStateDto>;
}
