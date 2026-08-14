import type {
  Forum,
  ForumListOptions,
  ForumRepository,
  IdentityKind,
  IdentityPrivate,
  IdentityPublic,
  IdentityRepository,
  Post,
  PostRepository,
  Topic,
  TopicRepository,
} from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

import type { ForumRow, IdentityRow, PostRow, TopicRow } from '../db';

export class SqliteForumRepository implements ForumRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: Forum['id']): Promise<Forum | null> {
    const row = this.db.prepare('select * from forums where id = ?').get(id) as ForumRow | undefined;
    return row ? mapForumRow(row) : null;
  }

  async list(options?: ForumListOptions): Promise<Forum[]> {
    const clauses: string[] = [];
    const params: Array<string | null> = [];
    const includeArchived = options?.includeArchived ?? false;

    if (!includeArchived) {
      clauses.push('status = ?');
      params.push(options?.status ?? 'active');
    } else if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }

    if (options?.parentForumId !== undefined) {
      if (options.parentForumId === null) {
        clauses.push('parent_forum_id is null');
      } else {
        clauses.push('parent_forum_id = ?');
        params.push(options.parentForumId);
      }
    }

    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
    const rows = this.db.prepare(`select * from forums ${where} order by created_at asc`).all(...params) as ForumRow[];
    return rows.map(mapForumRow);
  }

  async create(forum: Forum): Promise<void> {
    this.db
      .prepare(
        'insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        forum.id,
        forum.tenantId ?? null,
        forum.parentForumId ?? null,
        forum.category ?? null,
        forum.name,
        forum.description ?? null,
        forum.cwd ?? null,
        forum.prePrompt ?? null,
        forum.status,
        forum.visibility,
        forum.archivedAt ?? null,
        forum.createdAt,
        forum.updatedAt
      );
  }

  async update(forum: Forum): Promise<void> {
    this.db
      .prepare(
        'update forums set tenant_id = ?, parent_forum_id = ?, category = ?, name = ?, description = ?, cwd = ?, pre_prompt = ?, status = ?, visibility = ?, archived_at = ?, created_at = ?, updated_at = ? where id = ?'
      )
      .run(
        forum.tenantId ?? null,
        forum.parentForumId ?? null,
        forum.category ?? null,
        forum.name,
        forum.description ?? null,
        forum.cwd ?? null,
        forum.prePrompt ?? null,
        forum.status,
        forum.visibility,
        forum.archivedAt ?? null,
        forum.createdAt,
        forum.updatedAt,
        forum.id
      );
  }
}

export class SqliteTopicRepository implements TopicRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: Topic['id']): Promise<Topic | null> {
    const row = this.db.prepare('select * from topics where id = ?').get(id) as TopicRow | undefined;
    return row ? mapTopicRow(row) : null;
  }

  async listByForum(forumId: Topic['forumId'], page = 1, pageSize = 50): Promise<Topic[]> {
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare('select * from topics where forum_id = ? order by created_at desc limit ? offset ?')
      .all(forumId, pageSize, offset) as TopicRow[];
    return rows.map(mapTopicRow);
  }

  async create(topic: Topic): Promise<void> {
    this.db
      .prepare(
        'insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, auto_compact_enabled, auto_compact_revision, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        topic.id,
        topic.forumId,
        topic.tenantId ?? null,
        topic.title,
        topic.status,
        JSON.stringify(topic.tags ?? []),
        topic.robotMode ?? 'auto',
        topic.autoCompactEnabled ? 1 : 0,
        topic.autoCompactRevision ?? 0,
        topic.createdBy,
        topic.createdAt,
        topic.updatedAt
      );
  }

  async update(topic: Topic): Promise<void> {
    this.db
      .prepare(
        'update topics set forum_id = ?, tenant_id = ?, title = ?, status = ?, tags_json = ?, robot_mode = ?, auto_compact_enabled = ?, auto_compact_revision = ?, created_by = ?, created_at = ?, updated_at = ? where id = ?'
      )
      .run(
        topic.forumId,
        topic.tenantId ?? null,
        topic.title,
        topic.status,
        JSON.stringify(topic.tags ?? []),
        topic.robotMode ?? 'auto',
        topic.autoCompactEnabled ? 1 : 0,
        topic.autoCompactRevision ?? 0,
        topic.createdBy,
        topic.createdAt,
        topic.updatedAt,
        topic.id
      );
  }
}

export class SqlitePostRepository implements PostRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: Post['id']): Promise<Post | null> {
    const row = this.db.prepare('select * from posts where id = ?').get(id) as PostRow | undefined;
    return row ? mapPostRow(row) : null;
  }

  async listByTopic(topicId: Post['topicId'], page = 1, pageSize = 200): Promise<Post[]> {
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare('select * from posts where topic_id = ? order by created_at asc limit ? offset ?')
      .all(topicId, pageSize, offset) as PostRow[];
    return rows.map(mapPostRow);
  }

  async create(post: Post): Promise<void> {
    this.db
      .prepare(
        'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        post.id,
        post.topicId,
        post.tenantId ?? null,
        post.parentPostId ?? null,
        post.authorId,
        post.body,
        post.sourceMessageId ?? null,
        post.silent ? 1 : 0,
        post.createdAt,
        post.editedAt ?? null,
        post.deletedAt ?? null
      );
  }

  async update(post: Post): Promise<void> {
    this.db
      .prepare(
        'update posts set topic_id = ?, tenant_id = ?, parent_post_id = ?, author_id = ?, body = ?, source_message_id = ?, silent = ?, created_at = ?, edited_at = ?, deleted_at = ? where id = ?'
      )
      .run(
        post.topicId,
        post.tenantId ?? null,
        post.parentPostId ?? null,
        post.authorId,
        post.body,
        post.sourceMessageId ?? null,
        post.silent ? 1 : 0,
        post.createdAt,
        post.editedAt ?? null,
        post.deletedAt ?? null,
        post.id
      );
  }

  async delete(postId: Post['id']): Promise<void> {
    this.db.prepare('delete from posts where id = ?').run(postId);
  }
}

export class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: IdentityPrivate['id']): Promise<IdentityPrivate | null> {
    const row = this.db.prepare('select * from identities where id = ?').get(id) as IdentityRow | undefined;
    return row ? mapIdentityPrivate(row) : null;
  }

  async listByTopic(topicId: string, page = 1, pageSize = 100): Promise<IdentityPublic[]> {
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare(
        `select distinct i.* from identities i
         join posts p on p.author_id = i.id
         where p.topic_id = ?
         order by i.display_name asc
         limit ? offset ?`
      )
      .all(topicId, pageSize, offset) as IdentityRow[];
    return rows.map(mapIdentityPublic);
  }

  async create(identity: IdentityPrivate): Promise<void> {
    this.db
      .prepare(
        'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, username, password_hash, location, signature, theme, private_email, quick_reply_docked_by_default, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        identity.id,
        identity.tenantId ?? null,
        identity.displayName,
        identity.kind,
        identity.parentIdentityId ?? null,
        identity.avatarUrl ?? null,
        identity.username ?? null,
        identity.passwordHash ?? null,
        identity.location ?? null,
        identity.signature ?? null,
        identity.theme ?? null,
        identity.privateEmail ?? null,
        identity.quickReplyDockedByDefault ? 1 : 0,
        identity.createdAt,
        identity.updatedAt
      );
  }

  async update(identity: IdentityPrivate): Promise<void> {
    this.db
      .prepare(
        'update identities set tenant_id = ?, display_name = ?, kind = ?, parent_identity_id = ?, avatar_url = ?, username = ?, password_hash = ?, location = ?, signature = ?, theme = ?, private_email = ?, quick_reply_docked_by_default = ?, created_at = ?, updated_at = ? where id = ?'
      )
      .run(
        identity.tenantId ?? null,
        identity.displayName,
        identity.kind,
        identity.parentIdentityId ?? null,
        identity.avatarUrl ?? null,
        identity.username ?? null,
        identity.passwordHash ?? null,
        identity.location ?? null,
        identity.signature ?? null,
        identity.theme ?? null,
        identity.privateEmail ?? null,
        identity.quickReplyDockedByDefault ? 1 : 0,
        identity.createdAt,
        identity.updatedAt,
        identity.id
      );
  }
}

function mapForumRow(row: ForumRow): Forum {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    parentForumId: row.parent_forum_id,
    category: row.category,
    name: row.name,
    description: row.description,
    cwd: row.cwd,
    prePrompt: row.pre_prompt,
    status: row.status as Forum['status'],
    visibility: row.visibility as Forum['visibility'],
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTopicRow(row: TopicRow): Topic {
  return {
    id: row.id,
    forumId: row.forum_id,
    tenantId: row.tenant_id,
    title: row.title,
    status: row.status as Topic['status'],
    robotMode: (row.robot_mode ?? null) as 'auto' | 'mention' | 'off' | null,
    autoCompactEnabled: Boolean(row.auto_compact_enabled),
    autoCompactRevision: row.auto_compact_revision,
    tags: safeParseTags(row.tags_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPostRow(row: PostRow): Post {
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
    deletedAt: row.deleted_at,
  };
}

function mapIdentityPublic(row: IdentityRow): IdentityPublic {
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
    updatedAt: row.updated_at,
  };
}

function mapIdentityPrivate(row: IdentityRow): IdentityPrivate {
  return {
    ...mapIdentityPublic(row),
    username: row.username,
    passwordHash: row.password_hash,
    privateEmail: row.private_email,
    quickReplyDockedByDefault: Boolean(row.quick_reply_docked_by_default),
  };
}

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}
