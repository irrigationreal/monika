import type Database from 'better-sqlite3';
import type { PostRepository, Post } from '@irrigationreal/codex-forum-core';
import { nowIso, type PostRow } from '../../db';
import { mapPostRow } from './mappers';

const DEFAULT_PAGE_SIZE = 200;
const DELETED_BODY_PLACEHOLDER = '[This post has been deleted]';

export class SqlitePostRepository implements PostRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: string): Promise<Post | null> {
    const row = this.db.prepare('select * from posts where id = ?').get(id) as PostRow | undefined;
    return row ? mapPostRow(row) : null;
  }

  async listByTopic(topicId: string, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE): Promise<Post[]> {
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
        'update posts set topic_id = ?, tenant_id = ?, parent_post_id = ?, author_id = ?, body = ?, source_message_id = ?, silent = ?, edited_at = ?, deleted_at = ? where id = ?'
      )
      .run(
        post.topicId,
        post.tenantId ?? null,
        post.parentPostId ?? null,
        post.authorId,
        post.body,
        post.sourceMessageId ?? null,
        post.silent ? 1 : 0,
        post.editedAt ?? null,
        post.deletedAt ?? null,
        post.id
      );
  }

  async delete(postId: string): Promise<void> {
    const deletedAt = nowIso();
    this.db
      .prepare('update posts set deleted_at = ?, body = ? where id = ?')
      .run(deletedAt, DELETED_BODY_PLACEHOLDER, postId);
  }
}
