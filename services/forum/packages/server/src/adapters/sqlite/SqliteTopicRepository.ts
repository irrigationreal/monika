import { type TopicRow } from '../../db';
import { mapTopicRow } from './mappers';

import type { Topic, TopicRepository } from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_ROBOT_MODE = 'auto';

export class SqliteTopicRepository implements TopicRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: string): Promise<Topic | null> {
    const row = this.db.prepare('select * from topics where id = ?').get(id) as TopicRow | undefined;
    return row ? mapTopicRow(row) : null;
  }

  async listByForum(forumId: string, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE): Promise<Topic[]> {
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
        topic.robotMode ?? DEFAULT_ROBOT_MODE,
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
        'update topics set forum_id = ?, tenant_id = ?, title = ?, status = ?, tags_json = ?, robot_mode = ?, auto_compact_enabled = ?, auto_compact_revision = ?, created_by = ?, updated_at = ? where id = ?'
      )
      .run(
        topic.forumId,
        topic.tenantId ?? null,
        topic.title,
        topic.status,
        JSON.stringify(topic.tags ?? []),
        topic.robotMode ?? DEFAULT_ROBOT_MODE,
        topic.autoCompactEnabled ? 1 : 0,
        topic.autoCompactRevision ?? 0,
        topic.createdBy,
        topic.updatedAt,
        topic.id
      );
  }
}
