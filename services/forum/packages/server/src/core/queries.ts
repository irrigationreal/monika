import type Database from 'better-sqlite3';
import type { ForumStats, TopicStats, IdentityPublic } from '@irrigationreal/codex-forum-core';
import type { IdentityKind } from '@irrigationreal/codex-forum-core';
import type { ForumLastPost } from '@irrigationreal/codex-forum-core';
import type { IdentityRow } from '../db';

export interface RecentPostRow {
  post_id: string;
  topic_id: string;
  forum_id: string;
  forum_name: string;
  forum_visibility: string;
  forum_tenant_id: string | null;
  topic_title: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface ReactionCountRow {
  emoji: string;
  count: number;
}

export class ForumQueries {
  constructor(private readonly db: Database.Database) {}

  listRecentPosts(limit = 3): RecentPostRow[] {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.db
      .prepare(
        `select
          p.id as post_id,
          p.topic_id,
          p.author_id,
          p.body,
          p.created_at,
          t.title as topic_title,
          t.forum_id,
          f.name as forum_name,
          f.visibility as forum_visibility,
          f.tenant_id as forum_tenant_id,
          i.display_name as author_name
        from posts p
        join topics t on p.topic_id = t.id
        join forums f on t.forum_id = f.id
        join identities i on p.author_id = i.id
        where p.deleted_at is null
        order by p.created_at desc
        limit ?`
      )
      .all(safeLimit) as RecentPostRow[];
  }

  getForumStatsForForums(forumIds: string[]): Map<string, ForumStats> {
    const result = new Map<string, ForumStats>();
    if (!forumIds.length) return result;
    const uniqueIds = Array.from(new Set(forumIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');

    const threadRows = this.db
      .prepare(`select forum_id, count(*) as thread_count from topics where forum_id in (${placeholders}) group by forum_id`)
      .all(...uniqueIds) as Array<{ forum_id: string; thread_count: number }>;
    const postRows = this.db
      .prepare(
        `select t.forum_id as forum_id, count(*) as post_count
         from posts p
         join topics t on p.topic_id = t.id
         where p.deleted_at is null and t.forum_id in (${placeholders})
         group by t.forum_id`
      )
      .all(...uniqueIds) as Array<{ forum_id: string; post_count: number }>;
    const lastPostRows = this.db
      .prepare(
        `select forum_id, post_id, topic_id, topic_title, author_id, author_name, created_at
         from (
           select
             t.forum_id as forum_id,
             p.id as post_id,
             p.topic_id as topic_id,
             t.title as topic_title,
             p.author_id as author_id,
             i.display_name as author_name,
             p.created_at as created_at,
             row_number() over (partition by t.forum_id order by p.created_at desc, p.rowid desc) as rn
           from posts p
           join topics t on p.topic_id = t.id
           join identities i on p.author_id = i.id
           where p.deleted_at is null and t.forum_id in (${placeholders})
         )
         where rn = 1`
      )
      .all(...uniqueIds) as Array<{
        forum_id: string;
        post_id: string;
        topic_id: string;
        topic_title: string;
        author_id: string;
        author_name: string;
        created_at: string;
      }>;

    const threadCountByForum = new Map(threadRows.map((row) => [row.forum_id, row.thread_count]));
    const postCountByForum = new Map(postRows.map((row) => [row.forum_id, row.post_count]));
    const lastPostByForum = new Map<string, ForumLastPost>(
      lastPostRows.map((row) => [
        row.forum_id,
        {
          postId: row.post_id,
          topicId: row.topic_id,
          topicTitle: row.topic_title,
          authorId: row.author_id,
          authorName: row.author_name,
          createdAt: row.created_at
        }
      ])
    );

    for (const forumId of uniqueIds) {
      result.set(forumId, {
        threadCount: threadCountByForum.get(forumId) ?? 0,
        postCount: postCountByForum.get(forumId) ?? 0,
        lastPost: lastPostByForum.get(forumId) ?? null
      });
    }

    return result;
  }

  getTopicStatsForTopics(topicIds: string[]): Map<string, TopicStats> {
    const result = new Map<string, TopicStats>();
    if (!topicIds.length) return result;
    const uniqueIds = Array.from(new Set(topicIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const countRows = this.db
      .prepare(
        `select topic_id, count(*) as post_count
         from posts
         where deleted_at is null and topic_id in (${placeholders})
         group by topic_id`
      )
      .all(...uniqueIds) as Array<{ topic_id: string; post_count: number }>;
    const lastPostRows = this.db
      .prepare(
        `select topic_id, author_id, author_name, created_at
         from (
           select
             p.topic_id as topic_id,
             p.author_id as author_id,
             i.display_name as author_name,
             p.created_at as created_at,
             row_number() over (partition by p.topic_id order by p.created_at desc, p.rowid desc) as rn
           from posts p
           join identities i on p.author_id = i.id
           where p.deleted_at is null and p.topic_id in (${placeholders})
         )
         where rn = 1`
      )
      .all(...uniqueIds) as Array<{
        topic_id: string;
        author_id: string;
        author_name: string;
        created_at: string;
      }>;

    const postCountByTopic = new Map(countRows.map((row) => [row.topic_id, row.post_count]));
    const lastPostByTopic = new Map(
      lastPostRows.map((row) => [
        row.topic_id,
        {
          lastPostAuthorId: row.author_id ?? null,
          lastPostAuthorName: row.author_name ?? null,
          lastPostAt: row.created_at ?? null
        }
      ])
    );

    for (const topicId of uniqueIds) {
      const lastPost = lastPostByTopic.get(topicId);
      result.set(topicId, {
        postCount: postCountByTopic.get(topicId) ?? 0,
        lastPostAuthorId: lastPost?.lastPostAuthorId ?? null,
        lastPostAuthorName: lastPost?.lastPostAuthorName ?? null,
        lastPostAt: lastPost?.lastPostAt ?? null
      });
    }

    return result;
  }

  getIdentitiesByIds(identityIds: string[]): Map<string, IdentityPublic> {
    const result = new Map<string, IdentityPublic>();
    if (!identityIds.length) return result;
    const uniqueIds = Array.from(new Set(identityIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`select * from identities where id in (${placeholders})`)
      .all(...uniqueIds) as IdentityRow[];
    for (const row of rows) {
      result.set(row.id, mapIdentityPublic(row));
    }
    return result;
  }

  listChatMessages(topicId: string, limit: number, beforePostId?: string | null) {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    let beforeRowId = Number.MAX_SAFE_INTEGER;
    if (beforePostId) {
      const row = this.db
        .prepare('select rowid as rowid from posts where id = ? and topic_id = ?')
        .get(beforePostId, topicId) as { rowid: number } | undefined;
      if (row?.rowid) {
        beforeRowId = row.rowid;
      }
    }
    return this.db
      .prepare(
        `select
          p.id,
          p.topic_id,
          p.author_id,
          p.body,
          p.created_at,
          p.edited_at,
          i.display_name as author_name,
          i.avatar_url as author_avatar_url
        from posts p
        join identities i on p.author_id = i.id
        where p.deleted_at is null and p.topic_id = ? and p.rowid < ?
        order by p.rowid desc
        limit ?`
      )
      .all(topicId, beforeRowId, safeLimit) as Array<{
      id: string;
      topic_id: string;
      author_id: string;
      author_name: string;
      author_avatar_url: string | null;
      body: string;
      created_at: string;
      edited_at: string | null;
    }>;
  }

  getReactionCountsForPosts(postIds: string[]): Map<string, ReactionCountRow[]> {
    if (postIds.length === 0) return new Map();
    const placeholders = postIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `select post_id, emoji, count(*) as count from reactions where post_id in (${placeholders}) group by post_id, emoji`
      )
      .all(...postIds) as Array<{ post_id: string; emoji: string; count: number }>;

    const result = new Map<string, ReactionCountRow[]>();
    for (const row of rows) {
      const counts = result.get(row.post_id) ?? [];
      counts.push({ emoji: row.emoji, count: row.count });
      result.set(row.post_id, counts);
    }
    return result;
  }
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
    updatedAt: row.updated_at
  };
}
