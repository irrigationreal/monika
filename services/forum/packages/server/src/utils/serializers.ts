export type TopicRow = {
  id: string;
  forum_id: string;
  tenant_id: string | null;
  title: string;
  status: string;
  tags_json: string;
  robot_mode: string;
  auto_compact_enabled: number;
  auto_compact_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export interface SerializedTopic {
  id: string;
  forumId: string;
  tenantId: string | null;
  title: string;
  status: string;
  tags: unknown;
  robotMode: string;
  autoCompactEnabled: boolean;
  autoCompactRevision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function serializeTopic(row: TopicRow): SerializedTopic {
  return {
    id: row.id,
    forumId: row.forum_id,
    tenantId: row.tenant_id,
    title: row.title,
    status: row.status,
    tags: JSON.parse(row.tags_json),
    robotMode: row.robot_mode,
    autoCompactEnabled: Boolean(row.auto_compact_enabled),
    autoCompactRevision: row.auto_compact_revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type PostRow = {
  id: string;
  topic_id: string;
  tenant_id: string | null;
  parent_post_id: string | null;
  author_id: string;
  body: string;
  source_message_id: string | null;
  silent: number;
  follow_up: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

export interface SerializedPost {
  id: string;
  topicId: string;
  tenantId: string | null;
  parentPostId: string | null;
  authorId: string;
  body: string;
  sourceMessageId: string | null;
  silent: boolean;
  followUp: boolean;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export function serializePost(row: PostRow): SerializedPost {
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

export type AttachmentRow = {
  id: string;
  post_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export interface SerializedAttachment {
  id: string;
  postId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export function serializeAttachment(row: AttachmentRow): SerializedAttachment {
  return {
    id: row.id,
    postId: row.post_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

export type UserFileRow = {
  id: string;
  identity_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export interface SerializedUserFile {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export function serializeUserFile(row: UserFileRow): SerializedUserFile {
  return {
    id: row.id,
    ownerId: row.identity_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}
