import type { Database } from 'better-sqlite3';
import type { ForumStats, ForumStatsReadModel, TopicStats, TopicStatsReadModel } from '@irrigationreal/codex-forum-core';
import { STORE_CACHE_MAX_ENTRIES, STORE_STATS_CACHE_TTL_MS } from '../runtimeConfig';

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

class TimedCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get(key: K): V | undefined {
    if (this.ttlMs <= 0) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.ttlMs <= 0) return;
    const expiresAt = Date.now() + this.ttlMs;
    this.store.set(key, { value, expiresAt });
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as K | undefined;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }
}

export class SqliteStatsReadModel implements ForumStatsReadModel, TopicStatsReadModel {
  private readonly forumStatsCache = new TimedCache<string, ForumStats>(STORE_STATS_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);
  private readonly topicStatsCache = new TimedCache<string, TopicStats>(STORE_STATS_CACHE_TTL_MS, STORE_CACHE_MAX_ENTRIES);

  constructor(private readonly db: Database) {}

  async getForumStatsForForums(forumIds: string[]): Promise<Map<string, ForumStats>> {
    const result = new Map<string, ForumStats>();
    if (!forumIds.length) return result;
    const uniqueIds = Array.from(new Set(forumIds));
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.forumStatsCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return result;

    const placeholders = missing.map(() => '?').join(', ');
    const threadRows = this.db
      .prepare(`select forum_id, count(*) as thread_count from topics where forum_id in (${placeholders}) group by forum_id`)
      .all(...missing) as Array<{ forum_id: string; thread_count: number }>;
    const postRows = this.db
      .prepare(
        `select t.forum_id as forum_id, count(*) as post_count
         from posts p
         join topics t on p.topic_id = t.id
         where p.deleted_at is null and t.forum_id in (${placeholders})
         group by t.forum_id`
      )
      .all(...missing) as Array<{ forum_id: string; post_count: number }>;
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
      .all(...missing) as Array<{
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
    const lastPostByForum = new Map(
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

    for (const forumId of missing) {
      const stats: ForumStats = {
        threadCount: threadCountByForum.get(forumId) ?? 0,
        postCount: postCountByForum.get(forumId) ?? 0,
        lastPost: lastPostByForum.get(forumId) ?? null
      };
      this.forumStatsCache.set(forumId, stats);
      result.set(forumId, stats);
    }

    return result;
  }

  async getForumStats(forumId: string): Promise<ForumStats> {
    const stats = (await this.getForumStatsForForums([forumId])).get(forumId);
    if (stats) return stats;
    return { threadCount: 0, postCount: 0, lastPost: null };
  }

  async getTopicStatsForTopics(topicIds: string[]): Promise<Map<string, TopicStats>> {
    const result = new Map<string, TopicStats>();
    if (!topicIds.length) return result;
    const uniqueIds = Array.from(new Set(topicIds));
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.topicStatsCache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return result;

    const placeholders = missing.map(() => '?').join(', ');
    const countRows = this.db
      .prepare(
        `select topic_id, count(*) as post_count
         from posts
         where deleted_at is null and topic_id in (${placeholders})
         group by topic_id`
      )
      .all(...missing) as Array<{ topic_id: string; post_count: number }>;
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
      .all(...missing) as Array<{ topic_id: string; author_id: string | null; author_name: string | null; created_at: string | null }>;

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

    for (const topicId of missing) {
      const stats: TopicStats = {
        postCount: postCountByTopic.get(topicId) ?? 0,
        lastPostAuthorId: lastPostByTopic.get(topicId)?.lastPostAuthorId ?? null,
        lastPostAuthorName: lastPostByTopic.get(topicId)?.lastPostAuthorName ?? null,
        lastPostAt: lastPostByTopic.get(topicId)?.lastPostAt ?? null
      };
      this.topicStatsCache.set(topicId, stats);
      result.set(topicId, stats);
    }

    return result;
  }

  async getTopicStats(topicId: string): Promise<TopicStats> {
    const stats = (await this.getTopicStatsForTopics([topicId])).get(topicId);
    if (stats) return stats;
    return { postCount: 0, lastPostAuthorId: null, lastPostAuthorName: null, lastPostAt: null };
  }
}
