import type {
  CompactionOperation,
  ExternalRef,
  ExternalRefKind,
  ExternalScopeKind,
  ForkOperation,
  IdentityKind,
  IdentityPrivate,
  MessageDraft,
  MessageTemplate,
  Post,
  RobotActivity,
  RobotState,
  SurfaceKind,
  Topic,
  TopicOperationalEvent,
  TopicStatus,
  UserFile,
  WebAuthnCredential,
} from '@irrigationreal/codex-forum-core';

import type {
  AttachmentRow,
  CompactionOperationRow,
  ExternalRefRow,
  ForkOperationRow,
  IdentityRow,
  InviteRow,
  MessageDraftRow,
  MessageTemplateRow,
  PlanRow,
  PostRow,
  RobotStateRow,
  SessionMessageRow,
  SessionRow,
  ToolRunRow,
  TopicAutoRunRow,
  TopicOperationalEventRow,
  TopicRow,
  UserFileRow,
  WebAuthnCredentialRow,
} from '../db';
import type { Attachment, Invite, Plan, Session, SessionMessage, ToolRun, TopicAutoRun } from './domain';

export function mapForkOperationRowToDomain(row: ForkOperationRow): ForkOperation {
  return {
    id: row.id,
    sourceTopicId: row.source_topic_id,
    boundaryPostId: row.boundary_post_id,
    boundaryEntryId: row.boundary_entry_id,
    expectedLeafId: row.expected_leaf_id,
    initiatedBy: row.initiated_by,
    title: row.title,
    openingBody: row.opening_body,
    status: row.status,
    childTopicId: row.child_topic_id,
    childSessionId: row.child_session_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapTopicRowToDomain(row: TopicRow): Topic {
  const topic: Topic = {
    id: row.id,
    forumId: row.forum_id,
    title: row.title,
    status: row.status as TopicStatus,
    autoCompactEnabled: Boolean(row.auto_compact_enabled),
    autoCompactRevision: row.auto_compact_revision,
    tags: JSON.parse(row.tags_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.tenant_id != null) topic.tenantId = row.tenant_id;
  if (row.robot_mode != null) topic.robotMode = row.robot_mode as Exclude<Topic['robotMode'], undefined>;
  return topic;
}

export function mapPostRowToDomain(row: PostRow): Post {
  return {
    id: row.id,
    topicId: row.topic_id,
    tenantId: row.tenant_id,
    parentPostId: row.parent_post_id,
    authorId: row.author_id,
    body: row.body,
    sourceMessageId: row.source_message_id,
    silent: Boolean(row.silent),
    followUp: Boolean(row.follow_up),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}

export function mapAttachmentRowToDomain(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    postId: row.post_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256 ?? null,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

export function mapUserFileRowToDomain(row: UserFileRow): UserFile {
  return {
    id: row.id,
    ownerIdentityId: row.identity_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    standalone: Boolean(row.standalone),
    visibility: row.visibility,
    expiresAt: row.expires_at,
    revision: row.revision,
    blobState: row.blob_id ? 'ready' : 'missing',
    associations: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMessageDraftRowToDomain(row: MessageDraftRow): MessageDraft {
  return {
    id: row.id,
    ownerIdentityId: row.owner_identity_id,
    context: row.context,
    forumId: row.forum_id,
    topicId: row.topic_id,
    title: row.title,
    body: row.body,
    options: row.options_json ? (JSON.parse(row.options_json) as MessageDraft['options']) : null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function mapMessageTemplateRowToDomain(
  row: MessageTemplateRow,
  contexts: MessageTemplate['contexts'],
  forumIds: string[]
): MessageTemplate {
  return {
    id: row.id,
    scope: row.scope as MessageTemplate['scope'],
    ownerIdentityId: row.owner_identity_id,
    name: row.name,
    category: row.category,
    body: row.body,
    threadTitle: row.thread_title,
    forumScope: row.forum_scope as MessageTemplate['forumScope'],
    forumIds,
    contexts,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapWebAuthnCredentialRowToDomain(row: WebAuthnCredentialRow): WebAuthnCredential {
  return {
    id: row.credential_id,
    identityId: row.identity_id,
    name: row.name,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports_json) as string[],
    deviceType: row.device_type,
    backedUp: Boolean(row.backed_up),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  };
}

export function mapIdentityRowToDomain(row: IdentityRow): IdentityPrivate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    kind: row.kind as IdentityKind,
    parentIdentityId: row.parent_identity_id,
    avatarUrl: row.avatar_url,
    location: row.location,
    signature: row.signature,
    theme: row.theme,
    username: row.username,
    passwordHash: row.password_hash,
    privateEmail: row.private_email,
    quickReplyDesktopMode: row.quick_reply_desktop_mode ?? null,
    quickReplyMobileMode: row.quick_reply_mobile_mode ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapExternalRefRowToDomain(row: ExternalRefRow): ExternalRef {
  return {
    id: row.id,
    surfaceId: row.surface_id,
    surfaceKind: row.surface_kind as SurfaceKind,
    externalId: row.external_id,
    kind: row.kind as ExternalRefKind,
    scope: row.scope,
    scopeKind: row.scope_kind as ExternalScopeKind | null,
    mappedForumId: row.mapped_forum_id,
    mappedTopicId: row.mapped_topic_id,
    mappedPostId: row.mapped_post_id,
    mappedIdentityId: row.mapped_identity_id,
  };
}

export function mapPlanRowToDomain(row: PlanRow): Plan {
  return {
    id: row.id,
    content: row.content,
    summary: row.summary,
    parentPostId: row.parent_post_id,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapToolRunRowToDomain(row: ToolRunRow): ToolRun {
  return {
    id: row.id,
    tool: row.tool,
    parentPostId: row.parent_post_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    command: row.command,
    filesTouched: row.files_touched_json ? (JSON.parse(row.files_touched_json) as string[]) : null,
    outputSummary: row.output_summary,
    redactionsApplied: Boolean(row.redactions_applied),
    visibility: row.visibility,
  };
}

export function mapRobotStateRowToDomain(row: RobotStateRow): RobotState {
  return {
    topicId: row.topic_id,
    sessionId: row.session_id,
    activity: row.activity as RobotActivity,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    lastUpdatedAt: row.last_updated_at,
    lastTurnError:
      row.last_error_message && row.last_error_at
        ? {
            message: row.last_error_message,
            at: row.last_error_at,
            postId: row.last_error_post_id ?? null,
            turnId: row.last_error_turn_id ?? null,
          }
        : null,
    recentToolRuns: [],
  };
}

export function mapTopicOperationalEventRowToDomain(row: TopicOperationalEventRow): TopicOperationalEvent {
  return {
    id: row.id,
    topicId: row.topic_id,
    anchorPostId: row.anchor_post_id,
    type: row.event_type as TopicOperationalEvent['type'],
    category: row.category as TopicOperationalEvent['category'],
    status: row.status as TopicOperationalEvent['status'],
    summary: row.summary,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : null,
    sourceKind: row.source_kind as TopicOperationalEvent['sourceKind'],
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

export function mapCompactionOperationRowToDomain(row: CompactionOperationRow): CompactionOperation {
  return {
    id: row.id,
    topicId: row.topic_id,
    sessionId: row.session_id,
    initiatedBy: row.initiated_by,
    expectedLeafId: row.expected_leaf_id,
    customInstructions: row.custom_instructions,
    recoveryPrompt: row.recovery_prompt,
    status: row.status as CompactionOperation['status'],
    eventId: row.event_id,
    recoveryPostId: row.recovery_post_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapTopicAutoRunRowToDomain(row: TopicAutoRunRow | null, topicId: string): TopicAutoRun {
  if (!row) {
    return {
      topicId,
      enabled: false,
      context: null,
      worker: 'echs',
      model: null,
      reasoningEffort: null,
      maxReplies: 20,
      replyCount: 0,
      status: 'idle',
      lastRunAt: null,
      lastReplyAt: null,
      lastSummary: null,
      lastNotes: null,
      lastError: null,
      steerMessage: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    topicId: row.topic_id,
    enabled: Boolean(row.enabled),
    context: row.context,
    worker: row.worker,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    maxReplies: row.max_replies,
    replyCount: row.reply_count,
    status: row.status,
    lastRunAt: row.last_run_at,
    lastReplyAt: row.last_reply_at,
    lastSummary: row.last_summary,
    lastNotes: row.last_notes,
    lastError: row.last_error,
    steerMessage: row.steer_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapSessionRowToDomain(row: SessionRow): Session {
  return {
    id: row.id,
    topicId: row.topic_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
  };
}

export function mapSessionMessageRowToDomain(row: SessionMessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    visibility: row.visibility,
  };
}

export function mapInviteRowToDomain(row: InviteRow): Invite {
  return {
    id: row.id,
    code: row.code,
    createdBy: row.created_by,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
