import { MessageTemplateQuotaError } from '@irrigationreal/codex-forum-core';

import { mapMessageTemplateRowToDomain } from '../mappers/db';

import type {
  MessageTemplate,
  MessageTemplateContext,
  MessageTemplateRepository,
  MessageTemplateScope,
  MessageTemplateWriteInput,
} from '@irrigationreal/codex-forum-core';
import type Database from 'better-sqlite3';

import type { MessageTemplateRow } from '../db';

export class SqliteMessageTemplateRepository implements MessageTemplateRepository {
  constructor(private readonly db: Database.Database) {}

  listPersonal(ownerIdentityId: string): Promise<MessageTemplate[]> {
    return Promise.resolve(this.readMany("scope = 'personal' and owner_identity_id = ?", [ownerIdentityId]));
  }

  listSystem(): Promise<MessageTemplate[]> {
    return Promise.resolve(this.readMany("scope = 'system'", []));
  }

  listEffective(input: {
    identityId: string;
    context: MessageTemplateContext;
    forumId: string;
    includePersonal: boolean;
  }): Promise<MessageTemplate[]> {
    const rows = this.db
      .prepare(
        `
      select distinct mt.* from message_templates mt
      join message_template_contexts mc on mc.template_id = mt.id and mc.context = ?
      left join message_template_forums mf on mf.template_id = mt.id and mf.forum_id = ?
      where mt.enabled = 1
        and (mt.scope = 'system' or (? = 1 and mt.scope = 'personal' and mt.owner_identity_id = ?))
        and (mt.forum_scope = 'all' or (mt.forum_scope = 'selected' and mf.forum_id is not null))
      order by case mt.scope when 'personal' then 0 else 1 end, mt.sort_order, lower(mt.name), mt.created_at
    `
      )
      .all(input.context, input.forumId, input.includePersonal ? 1 : 0, input.identityId) as MessageTemplateRow[];
    return Promise.resolve(
      rows.map((row) => {
        const template = this.hydrate(row);
        return {
          ...template,
          forumIds: template.forumScope === 'selected' ? [input.forumId] : [],
        };
      })
    );
  }

  create(input: MessageTemplate, quota: number): Promise<MessageTemplate> {
    const transaction = this.db.transaction(() => {
      const where = input.scope === 'personal' ? "scope = 'personal' and owner_identity_id = ?" : "scope = 'system'";
      const args = input.scope === 'personal' ? [input.ownerIdentityId] : [];
      const count = this.db.prepare(`select count(*) as count from message_templates where ${where}`).get(...args) as {
        count: number;
      };
      if (count.count >= quota)
        throw new MessageTemplateQuotaError(`Message template quota of ${String(quota)} reached`);
      const max = this.db
        .prepare(`select coalesce(max(sort_order), -1) as value from message_templates where ${where}`)
        .get(...args) as { value: number };
      input.sortOrder = max.value + 1;
      this.db
        .prepare(
          `insert into message_templates
        (id, scope, owner_identity_id, name, category, body, thread_title, forum_scope, enabled, sort_order, revision, created_by, updated_by, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.scope,
          input.ownerIdentityId,
          input.name,
          input.category,
          input.body,
          input.threadTitle,
          input.forumScope,
          input.enabled ? 1 : 0,
          input.sortOrder,
          input.revision,
          input.createdBy,
          input.updatedBy,
          input.createdAt,
          input.updatedAt
        );
      this.replaceAssociations(input.id, input.contexts, input.forumIds);
      const created = this.get(input.id);
      if (!created) throw new Error('Failed to read created message template');
      return created;
    });
    return Promise.resolve(transaction());
  }

  update(input: {
    id: string;
    scope: MessageTemplateScope;
    ownerIdentityId: string | null;
    expectedRevision: number;
    actorId: string;
    value: MessageTemplateWriteInput;
  }): Promise<MessageTemplate | 'missing' | 'conflict'> {
    const transaction = this.db.transaction(() => {
      const existing = this.ownedRow(input.id, input.scope, input.ownerIdentityId);
      if (!existing) return 'missing' as const;
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `update message_templates set name = ?, category = ?, body = ?, thread_title = ?, forum_scope = ?, enabled = ?,
        revision = revision + 1, updated_by = ?, updated_at = ? where id = ? and revision = ?`
        )
        .run(
          input.value.name,
          input.value.category ?? null,
          input.value.body,
          input.value.threadTitle ?? null,
          input.value.forumScope,
          input.value.enabled ? 1 : 0,
          input.actorId,
          now,
          input.id,
          input.expectedRevision
        );
      if (!result.changes) return 'conflict' as const;
      this.replaceAssociations(input.id, input.value.contexts, input.value.forumIds);
      const updated = this.get(input.id);
      if (!updated) throw new Error('Failed to read updated message template');
      return updated;
    });
    return Promise.resolve(transaction());
  }

  delete(input: {
    id: string;
    scope: MessageTemplateScope;
    ownerIdentityId: string | null;
    expectedRevision: number;
  }): Promise<'deleted' | 'missing' | 'conflict'> {
    const existing = this.ownedRow(input.id, input.scope, input.ownerIdentityId);
    if (!existing) return Promise.resolve('missing');
    const result = this.db
      .prepare('delete from message_templates where id = ? and revision = ?')
      .run(input.id, input.expectedRevision);
    return Promise.resolve(result.changes ? 'deleted' : 'conflict');
  }

  reorder(input: {
    scope: MessageTemplateScope;
    ownerIdentityId: string | null;
    actorId: string;
    items: { id: string; revision: number }[];
  }): Promise<MessageTemplate[] | 'missing' | 'conflict' | 'invalid'> {
    const transaction = this.db.transaction(() => {
      const where = input.scope === 'personal' ? "scope = 'personal' and owner_identity_id = ?" : "scope = 'system'";
      const args = input.scope === 'personal' ? [input.ownerIdentityId] : [];
      const existingRows = this.db
        .prepare(`select id, revision from message_templates where ${where}`)
        .all(...args) as {
        id: string;
        revision: number;
      }[];
      const submittedIds = new Set(input.items.map((item) => item.id));
      if (
        input.items.length === 0 ||
        input.items.length !== existingRows.length ||
        existingRows.some((row) => !submittedIds.has(row.id))
      ) {
        return 'invalid' as const;
      }
      const existingById = new Map(existingRows.map((row) => [row.id, row]));
      for (const item of input.items) {
        const existing = existingById.get(item.id);
        if (!existing) return 'invalid' as const;
        if (existing.revision !== item.revision) return 'conflict' as const;
      }
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        if (!item) continue;
        this.db
          .prepare(
            'update message_templates set sort_order = ?, revision = revision + 1, updated_by = ?, updated_at = ? where id = ? and revision = ?'
          )
          .run(index, input.actorId, new Date().toISOString(), item.id, item.revision);
      }
      return input.scope === 'personal'
        ? this.readManySync("scope = 'personal' and owner_identity_id = ?", [input.ownerIdentityId])
        : this.readManySync("scope = 'system'", []);
    });
    return Promise.resolve(transaction());
  }

  private ownedRow(id: string, scope: MessageTemplateScope, ownerIdentityId: string | null): MessageTemplateRow | null {
    const row =
      scope === 'personal'
        ? this.db
            .prepare("select * from message_templates where id = ? and scope = 'personal' and owner_identity_id = ?")
            .get(id, ownerIdentityId)
        : this.db.prepare("select * from message_templates where id = ? and scope = 'system'").get(id);
    return (row as MessageTemplateRow | undefined) ?? null;
  }

  private replaceAssociations(id: string, contexts: MessageTemplateContext[], forumIds: string[]): void {
    this.db.prepare('delete from message_template_contexts where template_id = ?').run(id);
    this.db.prepare('delete from message_template_forums where template_id = ?').run(id);
    const insertContext = this.db.prepare('insert into message_template_contexts (template_id, context) values (?, ?)');
    for (const context of contexts) insertContext.run(id, context);
    const insertForum = this.db.prepare('insert into message_template_forums (template_id, forum_id) values (?, ?)');
    for (const forumId of forumIds) insertForum.run(id, forumId);
  }

  private get(id: string): MessageTemplate | null {
    const row = this.db.prepare('select * from message_templates where id = ?').get(id) as
      MessageTemplateRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  private readMany(where: string, args: unknown[]): MessageTemplate[] {
    return this.readManySync(where, args);
  }
  private readManySync(where: string, args: unknown[]): MessageTemplate[] {
    const rows = this.db
      .prepare(`select * from message_templates where ${where} order by sort_order, lower(name), created_at`)
      .all(...args) as MessageTemplateRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private hydrate(row: MessageTemplateRow): MessageTemplate {
    const contexts = this.db
      .prepare('select context from message_template_contexts where template_id = ? order by context')
      .all(row.id) as { context: MessageTemplateContext }[];
    const forums = this.db
      .prepare('select forum_id from message_template_forums where template_id = ? order by forum_id')
      .all(row.id) as { forum_id: string }[];
    return mapMessageTemplateRowToDomain(
      row,
      contexts.map((item) => item.context),
      forums.map((item) => item.forum_id)
    );
  }
}
