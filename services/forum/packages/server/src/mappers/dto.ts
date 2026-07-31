import type {
  AttachmentDto,
  ChatCategoryDto,
  ChatMessageDto,
  ChatRoomDto,
  ExternalRefDto,
  ForumDto,
  IdentityDto,
  InviteDto,
  MessageTemplateDto,
  PlanDto,
  PostDto,
  RobotPersonaDto,
  RobotStateDto,
  TopicOperationalEventDto,
  CompactionOperationDto,
  SessionDto,
  SessionInspectorDto,
  SessionMessageDto,
  ToolRunDto,
  TopicAutoRunDto,
  TopicDto,
  UserFileDto,
  UserPostHistoryItemDto,
  UserPostHistoryResponseDto,
  ForumThemeKey
} from '@irrigationreal/codex-forum-contracts';
import type { CompactionOperation, ExternalRef, MessageTemplate, PlanArtifact, RobotState, ToolRunSummary, TopicOperationalEvent } from '@irrigationreal/codex-forum-core';
import type { ChatCategoryRow, ChatMessageRow, ChatRoomRow } from '../db';
import type {
  Attachment,
  ForumReadModel,
  IdentityReadModel,
  Invite,
  Plan,
  PostReadModel,
  RobotPersona,
  Session,
  SessionInspector,
  SessionMessage,
  ToolRun,
  TopicAutoRun,
  TopicReadModel,
  UserFile,
  UserPostHistoryItem
} from './domain';

type ChatCategorySummaryRow = ChatCategoryRow & { room_count: number };

export function mapMessageTemplateToDto(template: MessageTemplate): MessageTemplateDto {
  return {
    id: template.id,
    scope: template.scope,
    name: template.name,
    category: template.category,
    body: template.body,
    threadTitle: template.threadTitle,
    forumScope: template.forumScope,
    forumIds: template.forumIds,
    contexts: template.contexts,
    enabled: template.enabled,
    sortOrder: template.sortOrder,
    revision: template.revision,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

export function mapTopicToDto(topic: TopicReadModel): TopicDto {
  const dto: TopicDto = {
    id: topic.id,
    forumId: topic.forumId,
    title: topic.title,
    status: topic.status as TopicDto['status'],
    tags: topic.tags,
    createdBy: topic.createdBy,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt
  };
  if (topic.tenantId !== undefined) dto.tenantId = topic.tenantId;
  if (topic.robotMode != null) dto.robotMode = topic.robotMode;
  if (topic.createdByName !== undefined) dto.createdByName = topic.createdByName;
  if (topic.postCount !== undefined) dto.postCount = topic.postCount;
  if (topic.lastPostAuthorId !== undefined) dto.lastPostAuthorId = topic.lastPostAuthorId;
  if (topic.lastPostAuthorName !== undefined) dto.lastPostAuthorName = topic.lastPostAuthorName;
  if (topic.lastPostAt !== undefined) dto.lastPostAt = topic.lastPostAt;
  return dto;
}

export function mapForumToDto(forum: ForumReadModel): ForumDto {
  return {
    id: forum.id,
    ...(forum.tenantId !== undefined && { tenantId: forum.tenantId }),
    ...(forum.parentForumId !== undefined && { parentForumId: forum.parentForumId }),
    ...(forum.category !== undefined && { category: forum.category }),
    name: forum.name,
    ...(forum.description !== undefined && { description: forum.description }),
    status: forum.status as ForumDto['status'],
    visibility: forum.visibility as ForumDto['visibility'],
    ...(forum.archivedAt !== undefined && { archivedAt: forum.archivedAt }),
    threadCount: forum.threadCount ?? 0,
    postCount: forum.postCount ?? 0,
    lastPost: forum.lastPost ?? null,
    createdAt: forum.createdAt,
    updatedAt: forum.updatedAt
  };
}

export function mapPostToDto(post: PostReadModel): PostDto {
  return {
    id: post.id,
    topicId: post.topicId,
    ...(post.tenantId !== undefined && { tenantId: post.tenantId }),
    ...(post.parentPostId !== undefined && { parentPostId: post.parentPostId }),
    authorId: post.authorId,
    body: post.body,
    ...(post.sourceMessageId !== undefined && { sourceMessageId: post.sourceMessageId }),
    silent: post.silent,
    createdAt: post.createdAt,
    ...(post.editedAt !== undefined && { editedAt: post.editedAt }),
    ...(post.deletedAt !== undefined && { deletedAt: post.deletedAt }),
    ...(post.reactionCounts !== undefined && { reactionCounts: post.reactionCounts })
  };
}

export function mapChatCategoryRowToDto(category: ChatCategorySummaryRow): ChatCategoryDto {
  return {
    id: category.id,
    name: category.name,
    description: category.description ?? null,
    visibility: category.visibility as ChatCategoryDto['visibility'],
    roomCount: category.room_count ?? 0,
    createdAt: category.created_at,
    updatedAt: category.updated_at
  };
}

export function mapChatRoomRowToDto(room: ChatRoomRow): ChatRoomDto {
  return {
    id: room.id,
    categoryId: room.category_id,
    name: room.name,
    status: room.status as ChatRoomDto['status'],
    visibility: room.visibility as ChatRoomDto['visibility'],
    messageCount: room.message_count ?? 0,
    lastMessageAt: room.last_message_at ?? null,
    lastMessageAuthorName: room.last_message_author_name ?? null,
    createdAt: room.created_at,
    updatedAt: room.updated_at
  };
}

export function mapChatMessageRowToDto(message: ChatMessageRow): ChatMessageDto {
  return {
    id: message.id,
    roomId: message.room_id,
    author: {
      id: message.author_id,
      displayName: message.author_name,
      avatarUrl: message.author_avatar_url ?? null
    },
    body: message.body,
    createdAt: message.created_at,
    editedAt: message.edited_at ?? null,
    expiresAt: message.expires_at ?? null,
    attachments: []
  };
}

export function mapAttachmentToDto(attachment: Attachment): AttachmentDto {
  return {
    id: attachment.id,
    postId: attachment.postId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt
  };
}

export function mapUserFileToDto(file: UserFile): UserFileDto {
  return {
    id: file.id,
    ownerId: file.ownerId,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt
  };
}

export function mapIdentityToDto(identity: IdentityReadModel): IdentityDto {
  const dto: IdentityDto = {
    id: identity.id,
    displayName: identity.displayName,
    kind: identity.kind as IdentityDto['kind'],
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt
  };
  if (identity.tenantId !== undefined) dto.tenantId = identity.tenantId;
  if (identity.parentIdentityId !== undefined) dto.parentIdentityId = identity.parentIdentityId;
  if (identity.avatarUrl !== undefined) dto.avatarUrl = identity.avatarUrl;
  if (identity.location !== undefined) dto.location = identity.location;
  if (identity.signature !== undefined) dto.signature = identity.signature;
  if (identity.theme !== undefined) dto.theme = identity.theme as ForumThemeKey | null;
  if (identity.postCount !== undefined) dto.postCount = identity.postCount;
  if (identity.rank !== undefined) dto.rank = identity.rank;
  if (identity.joinDate !== undefined) dto.joinDate = identity.joinDate;
  return dto;
}

export function mapUserPostHistoryItemToDto(item: UserPostHistoryItem): UserPostHistoryItemDto {
  return {
    postId: item.postId,
    topicId: item.topicId,
    topicTitle: item.topicTitle,
    forumId: item.forumId,
    forumName: item.forumName,
    createdAt: item.createdAt,
    excerpt: item.excerpt
  };
}

export function mapUserPostHistoryResponseToDto(
  response: UserPostHistoryResponseDto
): UserPostHistoryResponseDto {
  return response;
}

export function mapRobotPersonaToDto(persona: RobotPersona): RobotPersonaDto {
  return {
    key: persona.key,
    forumId: persona.forumId,
    displayName: persona.displayName,
    description: persona.description,
    accentColor: persona.accentColor,
    avatarUrl: persona.avatarUrl,
    signature: persona.signature,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt
  };
}

export function mapExternalRefToDto(ref: ExternalRef): ExternalRefDto {
  const dto: ExternalRefDto = {
    id: ref.id,
    surfaceId: ref.surfaceId,
    surfaceKind: ref.surfaceKind as ExternalRefDto['surfaceKind'],
    externalId: ref.externalId,
    kind: ref.kind as ExternalRefDto['kind']
  };
  if (ref.scope !== undefined) dto.scope = ref.scope;
  if (ref.scopeKind !== undefined) dto.scopeKind = ref.scopeKind as Exclude<ExternalRefDto['scopeKind'], undefined>;
  if (ref.mappedForumId !== undefined) dto.mappedForumId = ref.mappedForumId;
  if (ref.mappedTopicId !== undefined) dto.mappedTopicId = ref.mappedTopicId;
  if (ref.mappedPostId !== undefined) dto.mappedPostId = ref.mappedPostId;
  if (ref.mappedIdentityId !== undefined) dto.mappedIdentityId = ref.mappedIdentityId;
  return dto;
}

export function mapPlanToDto(plan: Plan): PlanDto {
  return {
    id: plan.id,
    content: plan.content,
    summary: plan.summary ?? null,
    parentPostId: plan.parentPostId ?? null,
    visibility: plan.visibility as PlanDto['visibility'],
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

export function mapToolRunToDto(run: ToolRun): ToolRunDto {
  return {
    id: run.id,
    tool: run.tool,
    parentPostId: run.parentPostId ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
    command: run.command ?? null,
    filesTouched: run.filesTouched ?? null,
    outputSummary: run.outputSummary ?? null,
    redactionsApplied: run.redactionsApplied,
    visibility: run.visibility as ToolRunDto['visibility']
  };
}

function mapPlanArtifactToDto(plan: PlanArtifact): PlanDto {
  return {
    id: plan.id,
    content: plan.content,
    ...(plan.summary !== undefined && { summary: plan.summary }),
    visibility: plan.visibility as PlanDto['visibility'],
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

function mapToolRunSummaryToDto(run: ToolRunSummary): ToolRunDto {
  return {
    id: run.id,
    tool: run.tool,
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined && { finishedAt: run.finishedAt }),
    ...(run.exitCode !== undefined && { exitCode: run.exitCode }),
    ...(run.command !== undefined && { command: run.command }),
    ...(run.filesTouched !== undefined && { filesTouched: run.filesTouched }),
    ...(run.outputSummary !== undefined && { outputSummary: run.outputSummary }),
    redactionsApplied: run.redactionsApplied,
    visibility: run.visibility as ToolRunDto['visibility']
  };
}

export function mapTopicOperationalEventToDto(event: TopicOperationalEvent, includeDetail: boolean): TopicOperationalEventDto {
  return { ...event, detail: includeDetail ? event.detail : null };
}

export function mapCompactionOperationToDto(operation: CompactionOperation): CompactionOperationDto {
  return { ...operation };
}

export function mapRobotStateToDto(state: RobotState): RobotStateDto {
  return {
    topicId: state.topicId,
    sessionId: state.sessionId,
    activity: state.activity as RobotStateDto['activity'],
    model: state.model ?? null,
    reasoningEffort: state.reasoningEffort ?? null,
    lastUpdatedAt: state.lastUpdatedAt,
    lastTurnError: state.lastTurnError ?? null,
    currentPlan: state.currentPlan ? mapPlanArtifactToDto(state.currentPlan) : null,
    recentToolRuns: state.recentToolRuns.map(mapToolRunSummaryToDto)
  };
}

export function mapTopicAutoRunToDto(autoRun: TopicAutoRun): TopicAutoRunDto {
  return {
    topicId: autoRun.topicId,
    enabled: autoRun.enabled,
    context: autoRun.context,
    worker: autoRun.worker as TopicAutoRunDto['worker'],
    model: autoRun.model ?? null,
    reasoningEffort: autoRun.reasoningEffort ?? null,
    maxReplies: autoRun.maxReplies,
    replyCount: autoRun.replyCount,
    status: autoRun.status,
    lastRunAt: autoRun.lastRunAt ?? null,
    lastReplyAt: autoRun.lastReplyAt ?? null,
    lastSummary: autoRun.lastSummary ?? null,
    lastNotes: autoRun.lastNotes ?? null,
    lastError: autoRun.lastError ?? null,
    steerMessage: autoRun.steerMessage ?? null,
    createdAt: autoRun.createdAt ?? null,
    updatedAt: autoRun.updatedAt ?? null
  };
}

export function mapSessionToDto(session: Session): SessionDto {
  return {
    id: session.id,
    topicId: session.topicId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status as SessionDto['status']
  };
}

export function mapSessionMessageToDto(message: SessionMessage): SessionMessageDto {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role as SessionMessageDto['role'],
    content: message.content,
    createdAt: message.createdAt,
    visibility: message.visibility as SessionMessageDto['visibility']
  };
}

export function mapSessionInspectorToDto(inspector: SessionInspector): SessionInspectorDto {
  return {
    session: mapSessionToDto(inspector.session),
    messages: inspector.messages.map(mapSessionMessageToDto),
    toolRuns: inspector.toolRuns.map(mapToolRunToDto),
    plans: inspector.plans.map(mapPlanToDto),
    artifacts: inspector.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      label: artifact.label,
      visibility: artifact.visibility as SessionInspectorDto['artifacts'][number]['visibility']
    }))
  };
}

export function mapInviteToDto(invite: Invite): InviteDto {
  return {
    id: invite.id,
    code: invite.code,
    createdBy: invite.createdBy,
    maxUses: invite.maxUses,
    uses: invite.uses,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt
  };
}
