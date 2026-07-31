import type { Forum, Post, Topic } from '@irrigationreal/codex-forum-core';

import type { ForumRow, PostRow, TopicRow } from '../../db';

const parseTags = (value: string): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const mapForumRow = (row: ForumRow): Forum => ({
  id: row.id,
  tenantId: row.tenant_id,
  parentForumId: row.parent_forum_id,
  category: row.category,
  name: row.name,
  description: row.description,
  status: row.status as Forum['status'],
  visibility: row.visibility as Forum['visibility'],
  cwd: row.cwd,
  prePrompt: row.pre_prompt,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapTopicRow = (row: TopicRow): Topic => {
  const topic: Topic = {
    id: row.id,
    forumId: row.forum_id,
    title: row.title,
    status: row.status as Topic['status'],
    autoCompactEnabled: Boolean(row.auto_compact_enabled),
    autoCompactRevision: row.auto_compact_revision,
    tags: parseTags(row.tags_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.tenant_id != null) topic.tenantId = row.tenant_id;
  if (row.robot_mode != null) topic.robotMode = row.robot_mode as Exclude<Topic['robotMode'], undefined>;
  return topic;
};

export const mapPostRow = (row: PostRow): Post => ({
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
  deletedAt: row.deleted_at,
});
