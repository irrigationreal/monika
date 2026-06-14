import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { nowIso, type ForumRow, type TopicRow, type PostRow, type ProfilePostHistoryRow, type RecentPostRow } from '../../db';
import type { ForumRepository, TopicRepository, PostRepository } from '@irrigationreal/codex-forum-core';
import { SqliteForumRepository } from './SqliteForumRepository';
import { SqliteTopicRepository } from './SqliteTopicRepository';
import { SqlitePostRepository } from './SqlitePostRepository';

export class SqliteForumStore {
  readonly forums: ForumRepository;
  readonly topics: TopicRepository;
  readonly posts: PostRepository;

  constructor(private readonly db: Database.Database) {
    this.forums = new SqliteForumRepository(db);
    this.topics = new SqliteTopicRepository(db);
    this.posts = new SqlitePostRepository(db);
  }

  listForums(options?: { parentForumId?: string | null; status?: 'active' | 'archived'; includeArchived?: boolean }): ForumRow[] {
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

    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
    return this.db.prepare(`select * from forums ${where} order by created_at asc`).all(...params) as ForumRow[];
  }

  getForum(forumId: string): ForumRow | null {
    const row = this.db.prepare('select * from forums where id = ?').get(forumId) as ForumRow | undefined;
    return row ?? null;
  }

  createForum(
    name: string,
    description?: string | null,
    cwd?: string | null,
    parentForumId?: string | null,
    category?: string | null,
    status: 'active' | 'archived' = 'active',
    visibility: 'public' | 'members' | 'admin' = 'public',
    prePrompt?: string | null
  ): ForumRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        null,
        parentForumId ?? null,
        category ?? null,
        name,
        description ?? null,
        cwd ?? null,
        prePrompt ?? null,
        status,
        visibility,
        status === 'archived' ? now : null,
        now,
        now
      );
    return this.getForum(id) as ForumRow;
  }

  updateForum(
    forumId: string,
    updates: {
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
  ): ForumRow | null {
    const forum = this.getForum(forumId);
    if (!forum) return null;
    const now = nowIso();
    const nextStatus = updates.status ?? forum.status;
    const nextArchivedAt =
      updates.archivedAt !== undefined
        ? updates.archivedAt
        : nextStatus === 'archived'
          ? forum.archived_at ?? now
          : null;
    this.db
      .prepare(
        'update forums set parent_forum_id = ?, category = ?, name = ?, description = ?, cwd = ?, pre_prompt = ?, status = ?, visibility = ?, archived_at = ?, updated_at = ? where id = ?'
      )
      .run(
        updates.parentForumId !== undefined ? updates.parentForumId : forum.parent_forum_id,
        updates.category !== undefined ? updates.category : forum.category,
        updates.name ?? forum.name,
        updates.description !== undefined ? updates.description : forum.description,
        updates.cwd !== undefined ? updates.cwd : forum.cwd,
        updates.prePrompt !== undefined ? updates.prePrompt : forum.pre_prompt,
        nextStatus,
        updates.visibility ?? forum.visibility,
        nextArchivedAt,
        now,
        forumId
      );
    return this.getForum(forumId);
  }

  deleteForum(forumId: string): boolean {
    const topicCount = this.db.prepare('select count(*) as count from topics where forum_id = ?').get(forumId) as { count: number };
    if (topicCount.count > 0) return false;
    this.db.prepare('delete from access_rules where scope_kind = ? and scope_id = ?').run('forum', forumId);
    const result = this.db.prepare('delete from forums where id = ?').run(forumId);
    return result.changes > 0;
  }

  listTopics(forumId: string, page = 1, pageSize = 50): TopicRow[] {
    const offset = (page - 1) * pageSize;
    return this.db
      .prepare('select * from topics where forum_id = ? order by created_at desc limit ? offset ?')
      .all(forumId, pageSize, offset) as TopicRow[];
  }

  getTopic(topicId: string): TopicRow | null {
    const row = this.db.prepare('select * from topics where id = ?').get(topicId) as TopicRow | undefined;
    return row ?? null;
  }

  updateTopicStatus(topicId: string, status: 'open' | 'locked' | 'archived'): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) throw new Error('topic not found');
    const now = nowIso();
    this.db.prepare('update topics set status = ?, updated_at = ? where id = ?').run(status, now, topicId);
    return this.getTopic(topicId) as TopicRow;
  }

  updateTopicTitle(topicId: string, title: string): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) throw new Error('topic not found');
    const now = nowIso();
    this.db.prepare('update topics set title = ?, updated_at = ? where id = ?').run(title, now, topicId);
    return this.getTopic(topicId) as TopicRow;
  }

  updateTopicTags(topicId: string, tags: string[]): TopicRow {
    const existing = this.getTopic(topicId);
    if (!existing) throw new Error('topic not found');
    const now = nowIso();
    this.db.prepare('update topics set tags_json = ?, updated_at = ? where id = ?').run(JSON.stringify(tags), now, topicId);
    return this.getTopic(topicId) as TopicRow;
  }

  deleteTopic(topicId: string): void {
    const existing = this.getTopic(topicId);
    if (!existing) throw new Error('topic not found');
    this.db.transaction(() => {
      this.db.prepare('delete from message_tampers where topic_id = ?').run(topicId);
      const postIds = this.db.prepare('select id from posts where topic_id = ?').all(topicId) as { id: string }[];
      for (const { id: postId } of postIds) {
        this.db.prepare('delete from reactions where post_id = ?').run(postId);
        this.db.prepare('delete from attachments where post_id = ?').run(postId);
      }
      const sessionIds = this.db.prepare('select id from sessions where topic_id = ?').all(topicId) as { id: string }[];
      for (const { id: sessionId } of sessionIds) {
        this.db.prepare('delete from session_messages where session_id = ?').run(sessionId);
      }
      this.db.prepare('delete from robot_state where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_auto_runs where topic_id = ?').run(topicId);
      this.db.prepare('delete from tool_runs where topic_id = ?').run(topicId);
      this.db.prepare('delete from plans where topic_id = ?').run(topicId);
      this.db.prepare('delete from sessions where topic_id = ?').run(topicId);
      this.db.prepare('delete from posts where topic_id = ?').run(topicId);
      this.db.prepare('delete from topic_moves where topic_id = ?').run(topicId);
      this.db.prepare('delete from external_refs where mapped_topic_id = ?').run(topicId);
      this.db.prepare('delete from access_rules where scope_kind = ? and scope_id = ?').run('topic', topicId);
      this.db.prepare('delete from topics where id = ?').run(topicId);
    })();
  }

  createTopic(input: { forumId: string; title: string; body: string; authorId: string; silent?: boolean; robotMode?: 'auto' | 'mention' | 'off' }): { topic: TopicRow; post: PostRow } {
    const topicId = randomUUID();
    const postId = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(topicId, input.forumId, null, input.title, 'open', JSON.stringify([]), input.robotMode ?? 'auto', input.authorId, now, now);
    this.db
      .prepare(
        'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(postId, topicId, null, null, input.authorId, input.body, null, input.silent ? 1 : 0, now, null, null);
    const topic = this.getTopic(topicId) as TopicRow;
    const post = this.getPost(postId) as PostRow;
    return { topic, post };
  }

  listPosts(topicId: string, page = 1, pageSize = 200): PostRow[] {
    const offset = (page - 1) * pageSize;
    return this.db.prepare('select * from posts where topic_id = ? order by created_at asc limit ? offset ?').all(topicId, pageSize, offset) as PostRow[];
  }

  listAllPosts(topicId: string): PostRow[] {
    return this.db.prepare('select * from posts where topic_id = ? order by created_at asc').all(topicId) as PostRow[];
  }

  listPostsBetween(topicId: string, opts: { afterPostId?: string | null; beforePostId: string }): PostRow[] {
    const before = this.db
      .prepare('select rowid as rowid from posts where id = ? and topic_id = ?')
      .get(opts.beforePostId, topicId) as { rowid: number } | undefined;
    if (!before) return [];

    let afterRowid = 0;
    if (opts.afterPostId) {
      const after = this.db
        .prepare('select rowid as rowid from posts where id = ? and topic_id = ?')
        .get(opts.afterPostId, topicId) as { rowid: number } | undefined;
      if (after) afterRowid = after.rowid;
    }

    return this.db
      .prepare('select * from posts where topic_id = ? and rowid > ? and rowid < ? order by rowid asc')
      .all(topicId, afterRowid, before.rowid) as PostRow[];
  }

  getLatestHumanPostId(topicId: string): string | null {
    const row = this.db
      .prepare(
        `
      select p.id
      from posts p
      join identities i on p.author_id = i.id
      where p.topic_id = ? and p.deleted_at is null and i.kind != 'robot'
      order by p.created_at desc
      limit 1
    `
      )
      .get(topicId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getLatestPostId(topicId: string): string | null {
    const row = this.db
      .prepare(
        `
      select id
      from posts
      where topic_id = ? and deleted_at is null
      order by created_at desc
      limit 1
    `
      )
      .get(topicId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getPost(postId: string): PostRow | null {
    const row = this.db.prepare('select * from posts where id = ?').get(postId) as PostRow | undefined;
    return row ?? null;
  }

  createPost(input: { topicId: string; body: string; authorId: string; parentPostId?: string | null; sourceMessageId?: string | null; silent?: boolean }): PostRow {
    const postId = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        postId,
        input.topicId,
        null,
        input.parentPostId ?? null,
        input.authorId,
        input.body,
        input.sourceMessageId ?? null,
        input.silent ? 1 : 0,
        now,
        null,
        null
      );
    return this.getPost(postId) as PostRow;
  }

  updatePost(postId: string, input: { body: string }): PostRow {
    const existing = this.getPost(postId);
    if (!existing) throw new Error('post not found');
    if (existing.deleted_at) throw new Error('cannot edit deleted post');
    const now = nowIso();
    this.db.prepare('update posts set body = ?, edited_at = ? where id = ?').run(input.body, now, postId);
    return this.getPost(postId) as PostRow;
  }

  setPostSilent(postId: string, silent: boolean): PostRow {
    const existing = this.getPost(postId);
    if (!existing) throw new Error('post not found');
    if (existing.deleted_at) throw new Error('cannot update deleted post');
    this.db.prepare('update posts set silent = ? where id = ?').run(silent ? 1 : 0, postId);
    return this.getPost(postId) as PostRow;
  }

  softDeletePost(postId: string): PostRow {
    const existing = this.getPost(postId);
    if (!existing) throw new Error('post not found');
    if (existing.deleted_at) throw new Error('post already deleted');
    const now = nowIso();
    this.db.prepare('update posts set deleted_at = ?, body = ? where id = ?').run(now, '[This post has been deleted]', postId);
    return this.getPost(postId) as PostRow;
  }

  listRecentPosts(limit = 20): RecentPostRow[] {
    return this.db
      .prepare(
        `
      select
        p.id as post_id,
        p.topic_id,
        t.title as topic_title,
        t.forum_id,
        f.name as forum_name,
        f.visibility as forum_visibility,
        f.tenant_id as forum_tenant_id,
        p.author_id,
        i.display_name as author_name,
        p.body,
        p.created_at
      from posts p
      join topics t on p.topic_id = t.id
      join forums f on t.forum_id = f.id
      join identities i on p.author_id = i.id
      where p.deleted_at is null
      order by p.created_at desc
      limit ?
    `
      )
      .all(limit) as RecentPostRow[];
  }

  listPostsByAuthor(authorId: string, page = 1, pageSize = 20, opts?: { includeAdminForums?: boolean }): ProfilePostHistoryRow[] {
    const offset = (page - 1) * pageSize;
    const includeAdminForums = opts?.includeAdminForums ?? false;
    const query = includeAdminForums
      ? `
        select
          p.id as post_id,
          p.topic_id,
          t.title as topic_title,
          t.forum_id,
          f.name as forum_name,
          f.visibility as forum_visibility,
          f.tenant_id as forum_tenant_id,
          p.body,
          p.created_at
        from posts p
        join topics t on p.topic_id = t.id
        join forums f on t.forum_id = f.id
        where p.author_id = ? and p.deleted_at is null
        order by p.created_at desc
        limit ? offset ?
      `
      : `
        select
          p.id as post_id,
          p.topic_id,
          t.title as topic_title,
          t.forum_id,
          f.name as forum_name,
          f.visibility as forum_visibility,
          f.tenant_id as forum_tenant_id,
          p.body,
          p.created_at
        from posts p
        join topics t on p.topic_id = t.id
        join forums f on t.forum_id = f.id
        where p.author_id = ? and p.deleted_at is null and f.visibility != 'admin'
        order by p.created_at desc
        limit ? offset ?
      `;
    return this.db.prepare(query).all(authorId, pageSize, offset) as ProfilePostHistoryRow[];
  }
}
