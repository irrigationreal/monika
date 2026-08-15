import { mapMessageDraftRowToDomain } from '../mappers/db';

import type { MessageDraft, MessageDraftRepository, MessageDraftWriteInput } from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

import type { MessageDraftRow } from '../db';

export class SqliteMessageDraftRepository implements MessageDraftRepository {
  constructor(private readonly db: Database.Database) {}

  getById(ownerIdentityId: string, id: string, now: string): Promise<MessageDraft | null> {
    return Promise.resolve(this.one('owner_identity_id = ? and id = ? and expires_at > ?', [ownerIdentityId, id, now]));
  }
  getReply(ownerIdentityId: string, topicId: string, now: string): Promise<MessageDraft | null> {
    return Promise.resolve(
      this.one("owner_identity_id = ? and context = 'reply' and topic_id = ? and expires_at > ?", [
        ownerIdentityId,
        topicId,
        now,
      ])
    );
  }
  listOwner(ownerIdentityId: string, now: string): Promise<MessageDraft[]> {
    return Promise.resolve(this.many('owner_identity_id = ? and expires_at > ?', [ownerIdentityId, now]));
  }
  listNewThreadByForum(ownerIdentityId: string, forumId: string, now: string): Promise<MessageDraft[]> {
    return Promise.resolve(
      this.many("owner_identity_id = ? and context = 'new_thread' and forum_id = ? and expires_at > ?", [
        ownerIdentityId,
        forumId,
        now,
      ])
    );
  }

  save(input: {
    draft: MessageDraft;
    expectedRevision: number;
    value: MessageDraftWriteInput;
    now: string;
    quota: number;
  }): Promise<MessageDraft | 'conflict' | 'quota'> {
    const result = this.db.transaction(() => {
      this.db.prepare('delete from message_drafts where expires_at <= ?').run(input.now);
      let existing: MessageDraftRow | undefined;
      if (input.draft.context === 'reply') {
        existing = this.db
          .prepare("select * from message_drafts where owner_identity_id = ? and context = 'reply' and topic_id = ?")
          .get(input.draft.ownerIdentityId, input.draft.topicId) as MessageDraftRow | undefined;
      } else if (input.draft.context === 'notepad') {
        existing = this.db
          .prepare("select * from message_drafts where owner_identity_id = ? and context = 'notepad'")
          .get(input.draft.ownerIdentityId) as MessageDraftRow | undefined;
      } else if (input.expectedRevision > 0) {
        existing = this.db
          .prepare("select * from message_drafts where owner_identity_id = ? and context = 'new_thread' and id = ?")
          .get(input.draft.ownerIdentityId, input.draft.id) as MessageDraftRow | undefined;
      } else {
        const occupied = this.db.prepare('select 1 from message_drafts where id = ?').get(input.draft.id);
        if (occupied) return 'conflict' as const;
      }
      if (existing) {
        if (existing.revision !== input.expectedRevision) return 'conflict' as const;
        const title = input.draft.context === 'reply' ? null : (input.value.title ?? null);
        const optionsJson = input.draft.context === 'notepad' ? JSON.stringify(input.value.options ?? null) : null;
        if (existing.title === title && existing.body === input.value.body && existing.options_json === optionsJson)
          return mapMessageDraftRowToDomain(existing);
        const expiresAt = input.draft.expiresAt;
        const updated = this.db
          .prepare(
            `update message_drafts set title = ?, body = ?, options_json = ?, revision = revision + 1,
          updated_at = ?, expires_at = ? where id = ? and owner_identity_id = ? and revision = ?`
          )
          .run(
            title,
            input.value.body,
            optionsJson,
            input.now,
            expiresAt,
            existing.id,
            input.draft.ownerIdentityId,
            input.expectedRevision
          );
        if (!updated.changes) return 'conflict' as const;
        return this.oneRaw(existing.id, input.draft.ownerIdentityId);
      }
      if (input.expectedRevision !== 0) return 'conflict' as const;
      const count = this.db
        .prepare('select count(*) count from message_drafts where owner_identity_id = ?')
        .get(input.draft.ownerIdentityId) as { count: number };
      if (count.count >= input.quota) return 'quota' as const;
      this.db
        .prepare(
          `insert into message_drafts
        (id, owner_identity_id, context, forum_id, topic_id, title, body, options_json, revision, created_at, updated_at, expires_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          input.draft.id,
          input.draft.ownerIdentityId,
          input.draft.context,
          input.draft.forumId,
          input.draft.topicId,
          input.draft.context === 'reply' ? null : (input.value.title ?? null),
          input.value.body,
          input.draft.context === 'notepad' ? JSON.stringify(input.value.options ?? null) : null,
          input.now,
          input.now,
          input.draft.expiresAt
        );
      return this.oneRaw(input.draft.id, input.draft.ownerIdentityId);
    })();
    return Promise.resolve(result ?? 'conflict');
  }

  delete(ownerIdentityId: string, id: string, expectedRevision?: number): Promise<'deleted' | 'missing' | 'conflict'> {
    const existing = this.db
      .prepare('select revision from message_drafts where owner_identity_id = ? and id = ?')
      .get(ownerIdentityId, id) as { revision: number } | undefined;
    if (!existing) return Promise.resolve('missing');
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) return Promise.resolve('conflict');
    const result = this.db
      .prepare('delete from message_drafts where owner_identity_id = ? and id = ?')
      .run(ownerIdentityId, id);
    return Promise.resolve(result.changes ? 'deleted' : 'missing');
  }
  purgeExpired(now: string): Promise<number> {
    return Promise.resolve(this.db.prepare('delete from message_drafts where expires_at <= ?').run(now).changes);
  }

  private one(where: string, args: unknown[]): MessageDraft | null {
    const row = this.db.prepare(`select * from message_drafts where ${where}`).get(...args) as
      MessageDraftRow | undefined;
    return row ? mapMessageDraftRowToDomain(row) : null;
  }
  private oneRaw(id: string, owner: string): MessageDraft | null {
    return this.one('id = ? and owner_identity_id = ?', [id, owner]);
  }
  private many(where: string, args: unknown[]): MessageDraft[] {
    const rows = this.db
      .prepare(`select * from message_drafts where ${where} order by updated_at desc`)
      .all(...args) as MessageDraftRow[];
    return rows.map(mapMessageDraftRowToDomain);
  }
}
