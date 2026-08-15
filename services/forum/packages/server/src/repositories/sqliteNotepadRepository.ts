import type { NotepadEntry, NotepadRepository, NotepadTagSummary } from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

import type { NotepadEntryRow } from '../db';

export class SqliteNotepadRepository implements NotepadRepository {
  constructor(private readonly db: Database.Database) {}

  list(
    ownerIdentityId: string,
    input: { query?: string; tags: string[]; cursor?: string; limit: number }
  ): Promise<{ entries: NotepadEntry[]; nextCursor: string | null }> {
    const params: unknown[] = [ownerIdentityId];
    const where = ['e.owner_identity_id = ?'];
    if (input.query) {
      where.push("(coalesce(e.title, '') like ? escape '\\' or e.body like ? escape '\\')");
      const escaped = input.query.replace(/[\\%_]/g, (value) => `\\${value}`);
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    for (const tag of input.tags) {
      where.push('exists (select 1 from notepad_entry_tags f where f.entry_id = e.id and f.tag = ?)');
      params.push(tag);
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      where.push('(e.pinned < ? or (e.pinned = ? and (e.created_at < ? or (e.created_at = ? and e.id < ?))))');
      params.push(cursor.pinned, cursor.pinned, cursor.createdAt, cursor.createdAt, cursor.id);
    }
    params.push(input.limit + 1);
    const rows = this.db
      .prepare(
        `select e.* from notepad_entries e where ${where.join(' and ')}
         order by e.pinned desc, e.created_at desc, e.id desc limit ?`
      )
      .all(...params) as NotepadEntryRow[];
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const entries = selected.map((row) => this.map(row));
    const last = selected.at(-1);
    return Promise.resolve({ entries, nextCursor: hasMore && last ? encodeCursor(last) : null });
  }

  get(ownerIdentityId: string, id: string): Promise<NotepadEntry | null> {
    const row = this.db
      .prepare('select * from notepad_entries where id = ? and owner_identity_id = ?')
      .get(id, ownerIdentityId) as NotepadEntryRow | undefined;
    return Promise.resolve(row ? this.map(row) : null);
  }

  tags(ownerIdentityId: string): Promise<NotepadTagSummary[]> {
    const rows = this.db
      .prepare(
        `select t.tag, count(*) count from notepad_entry_tags t
         join notepad_entries e on e.id = t.entry_id
         where e.owner_identity_id = ? group by t.tag order by count(*) desc, t.tag asc`
      )
      .all(ownerIdentityId) as Array<{ tag: string; count: number }>;
    return Promise.resolve(rows);
  }

  create(input: {
    entry: NotepadEntry;
    draft?: { id: string; revision: number };
    quota: number;
    now: string;
  }): Promise<NotepadEntry | 'conflict' | 'quota'> {
    const result = this.db.transaction(() => {
      if (input.draft) {
        const draft = this.db
          .prepare(
            "select revision from message_drafts where id = ? and owner_identity_id = ? and context = 'notepad' and expires_at > ?"
          )
          .get(input.draft.id, input.entry.ownerIdentityId, input.now) as { revision: number } | undefined;
        if (!draft || draft.revision !== input.draft.revision) return 'conflict' as const;
      }
      const count = this.db
        .prepare('select count(*) count from notepad_entries where owner_identity_id = ?')
        .get(input.entry.ownerIdentityId) as { count: number };
      if (count.count >= input.quota) return 'quota' as const;
      this.db
        .prepare(
          `insert into notepad_entries
           (id, owner_identity_id, content_format, title, body, pinned, revision, created_at, updated_at, expires_at)
           values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          input.entry.id,
          input.entry.ownerIdentityId,
          input.entry.contentFormat,
          input.entry.title,
          input.entry.body,
          input.entry.pinned ? 1 : 0,
          input.entry.createdAt,
          input.entry.updatedAt,
          input.entry.expiresAt
        );
      this.replaceTags(input.entry.id, input.entry.tags);
      if (input.draft)
        this.db
          .prepare('delete from message_drafts where id = ? and owner_identity_id = ?')
          .run(input.draft.id, input.entry.ownerIdentityId);
      return this.map(this.row(input.entry.id, input.entry.ownerIdentityId)!);
    })();
    return Promise.resolve(result);
  }

  update(input: {
    ownerIdentityId: string;
    id: string;
    expectedRevision: number;
    value: { title: string | null; body: string; tags: string[]; pinned?: boolean; expiresAt?: string | null };
    now: string;
  }): Promise<NotepadEntry | 'missing' | 'conflict'> {
    const result = this.db.transaction(() => {
      const existing = this.row(input.id, input.ownerIdentityId);
      if (!existing) return 'missing' as const;
      if (existing.revision !== input.expectedRevision) return 'conflict' as const;
      const pinned = input.value.pinned === undefined ? existing.pinned : input.value.pinned ? 1 : 0;
      if (pinned) {
        this.db
          .prepare(
            'update notepad_entries set pinned = 0, revision = revision + 1, updated_at = ? where owner_identity_id = ? and pinned = 1 and id <> ?'
          )
          .run(input.now, input.ownerIdentityId, input.id);
      }
      const expiresAt = input.value.expiresAt === undefined ? existing.expires_at : input.value.expiresAt;
      const changed = this.db
        .prepare(
          `update notepad_entries set title = ?, body = ?, pinned = ?, expires_at = ?, revision = revision + 1, updated_at = ?
           where id = ? and owner_identity_id = ? and revision = ?`
        )
        .run(
          input.value.title,
          input.value.body,
          pinned,
          expiresAt,
          input.now,
          input.id,
          input.ownerIdentityId,
          input.expectedRevision
        );
      if (!changed.changes) return 'conflict' as const;
      this.replaceTags(input.id, input.value.tags);
      return this.map(this.row(input.id, input.ownerIdentityId)!);
    })();
    return Promise.resolve(result);
  }

  delete(ownerIdentityId: string, id: string, expectedRevision: number): Promise<'deleted' | 'missing' | 'conflict'> {
    const result = this.db.transaction(() => {
      const existing = this.row(id, ownerIdentityId);
      if (!existing) return 'missing' as const;
      if (existing.revision !== expectedRevision) return 'conflict' as const;
      this.db.prepare('delete from notepad_entry_tags where entry_id = ?').run(id);
      this.db.prepare('delete from notepad_entries where id = ? and owner_identity_id = ?').run(id, ownerIdentityId);
      return 'deleted' as const;
    })();
    return Promise.resolve(result);
  }

  purgeExpired(now: string): Promise<number> {
    return Promise.resolve(
      this.db.transaction(() => {
        const ids = this.db
          .prepare('select id from notepad_entries where expires_at is not null and expires_at <= ?')
          .all(now) as Array<{ id: string }>;
        if (!ids.length) return 0;
        const removeTags = this.db.prepare('delete from notepad_entry_tags where entry_id = ?');
        for (const { id } of ids) removeTags.run(id);
        this.db.prepare('delete from notepad_entries where expires_at is not null and expires_at <= ?').run(now);
        return ids.length;
      })()
    );
  }

  private row(id: string, owner: string): NotepadEntryRow | undefined {
    return this.db.prepare('select * from notepad_entries where id = ? and owner_identity_id = ?').get(id, owner) as
      NotepadEntryRow | undefined;
  }
  private map(row: NotepadEntryRow): NotepadEntry {
    const tags = this.db
      .prepare('select tag from notepad_entry_tags where entry_id = ? order by tag')
      .all(row.id) as Array<{ tag: string }>;
    return {
      id: row.id,
      ownerIdentityId: row.owner_identity_id,
      contentFormat: row.content_format,
      title: row.title,
      body: row.body,
      tags: tags.map(({ tag }) => tag),
      pinned: Boolean(row.pinned),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
  private replaceTags(entryId: string, tags: string[]): void {
    this.db.prepare('delete from notepad_entry_tags where entry_id = ?').run(entryId);
    const insert = this.db.prepare('insert into notepad_entry_tags (entry_id, tag) values (?, ?)');
    for (const tag of tags) insert.run(entryId, tag);
  }
}

function encodeCursor(row: NotepadEntryRow): string {
  return Buffer.from(JSON.stringify([row.pinned, row.created_at, row.id])).toString('base64url');
}
function decodeCursor(value?: string): { pinned: number; createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3) return null;
    const [pinned, createdAt, id] = decoded;
    if ((pinned !== 0 && pinned !== 1) || typeof createdAt !== 'string' || typeof id !== 'string') return null;
    return { pinned, createdAt, id };
  } catch {
    return null;
  }
}
