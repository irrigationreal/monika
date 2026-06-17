import type {
  AttachmentRow,
  ExternalRefRow,
  IdentityRow,
  InviteRow,
  PlanRow,
  PostRow,
  RobotStateRow,
  SessionMessageRow,
  SessionRow,
  ToolRunRow,
  TopicAutoRunRow,
  TopicRow,
  UserFileRow
} from '../db';
import type {
  ExternalRef,
  ExternalRefKind,
  ExternalScopeKind,
  Identity,
  IdentityKind,
  Post,
  RobotActivity,
  RobotState,
  SurfaceKind,
  Topic,
  TopicStatus
} from '@irrigationreal/codex-forum-core';
import type {
  Attachment,
  Invite,
  Plan,
  Session,
  SessionMessage,
  ToolRun,
  TopicAutoRun,
  UserFile
} from './domain';

export function mapTopicRowToDomain(row: TopicRow): Topic {
  const topic: Topic = {
    id: row.id,
    forumId: row.forum_id,
    title: row.title,
    status: row.status as TopicStatus,
    tags: JSON.parse(row.tags_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at
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
    createdAt: row.created_at
  };
}

export function mapUserFileRowToDomain(row: UserFileRow): UserFile {
  return {
    id: row.id,
    ownerId: row.identity_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at
  };
}

export function mapIdentityRowToDomain(row: IdentityRow): Identity {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    mappedIdentityId: row.mapped_identity_id
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
    updatedAt: row.updated_at
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
    visibility: row.visibility
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
    lastTurnError: row.last_error_message && row.last_error_at
      ? {
          message: row.last_error_message,
          at: row.last_error_at,
          postId: row.last_error_post_id ?? null,
          turnId: row.last_error_turn_id ?? null,
        }
      : null,
    recentToolRuns: []
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
      updatedAt: null
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
    updatedAt: row.updated_at
  };
}

export function mapSessionRowToDomain(row: SessionRow): Session {
  return {
    id: row.id,
    topicId: row.topic_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status
  };
}

export function mapSessionMessageRowToDomain(row: SessionMessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    visibility: row.visibility
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
    createdAt: row.created_at
  };
}

