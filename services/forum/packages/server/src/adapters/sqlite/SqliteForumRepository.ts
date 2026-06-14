import type Database from 'better-sqlite3';
import type { ForumRepository, ForumListOptions, Forum, ForumStatus } from '@irrigationreal/codex-forum-core';
import { nowIso, type ForumRow } from '../../db';
import { mapForumRow } from './mappers';

const DEFAULT_VISIBILITY = 'public';

export class SqliteForumRepository implements ForumRepository {
  constructor(private readonly db: Database.Database) {}

  async getById(id: string): Promise<Forum | null> {
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

    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
    const rows = this.db.prepare(`select * from forums ${where} order by created_at asc`).all(...params) as ForumRow[];
    return rows.map(mapForumRow);
  }

  async create(forum: Forum): Promise<void> {
    const archivedAt = forum.archivedAt ?? (forum.status === 'archived' ? forum.updatedAt ?? nowIso() : null);
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
        forum.status ?? ('active' as ForumStatus),
        forum.visibility ?? DEFAULT_VISIBILITY,
        archivedAt,
        forum.createdAt,
        forum.updatedAt
      );
  }

  async update(forum: Forum): Promise<void> {
    const archivedAt = forum.archivedAt ?? (forum.status === 'archived' ? forum.updatedAt ?? nowIso() : null);
    this.db
      .prepare(
        'update forums set tenant_id = ?, parent_forum_id = ?, category = ?, name = ?, description = ?, cwd = ?, pre_prompt = ?, status = ?, visibility = ?, archived_at = ?, updated_at = ? where id = ?'
      )
      .run(
        forum.tenantId ?? null,
        forum.parentForumId ?? null,
        forum.category ?? null,
        forum.name,
        forum.description ?? null,
        forum.cwd ?? null,
        forum.prePrompt ?? null,
        forum.status ?? ('active' as ForumStatus),
        forum.visibility ?? DEFAULT_VISIBILITY,
        archivedAt,
        forum.updatedAt,
        forum.id
      );
  }
}
