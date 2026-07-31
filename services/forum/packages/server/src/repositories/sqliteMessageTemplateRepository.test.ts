import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MessageTemplateConflictError,
  MessageTemplateService,
  MessageTemplateValidationError,
} from '@irrigationreal/codex-forum-core';

import { runMigrations } from '../migrations';
import { SqliteMessageTemplateRepository } from './sqliteMessageTemplateRepository';

const write = {
  name: 'Approval',
  category: 'Review',
  body: 'Approved.',
  threadTitle: null,
  forumScope: 'selected' as const,
  forumIds: ['forum-1'],
  contexts: ['reply' as const],
  enabled: true,
};

describe('SqliteMessageTemplateRepository', () => {
  let db: Database.Database;
  let service: MessageTemplateService;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(
      "insert into identities (id, display_name, kind, created_at, updated_at) values ('user-1','User','human',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into identities (id, display_name, kind, created_at, updated_at) values ('admin-1','Admin','admin',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into forums (id,name,status,visibility,created_at,updated_at) values ('forum-1','One','active','public',?,?)"
    ).run(now, now);
    db.prepare(
      "insert into forums (id,name,status,visibility,created_at,updated_at) values ('forum-2','Two','active','public',?,?)"
    ).run(now, now);
    service = new MessageTemplateService(
      new SqliteMessageTemplateRepository(db),
      () => now,
      () => `template-${Math.random()}`
    );
  });

  it('filters selected templates and never widens them when their forum is deleted', async () => {
    const created = await service.createPersonal('user-1', write);
    expect(
      (await service.listEffective({ identityId: 'user-1', context: 'reply', forumId: 'forum-1' })).map(
        (item) => item.id
      )
    ).toEqual([created.id]);
    expect(await service.listEffective({ identityId: 'user-1', context: 'reply', forumId: 'forum-2' })).toEqual([]);
    db.prepare("delete from forums where id = 'forum-1'").run();
    expect((await service.listPersonal('user-1'))[0]?.forumScope).toBe('selected');
    expect(await service.listEffective({ identityId: 'user-1', context: 'reply', forumId: 'forum-2' })).toEqual([]);
  });

  it('isolates personal and system scopes and enforces revisions across associations and deletes', async () => {
    const personal = await service.createPersonal('user-1', write);
    const system = await service.createSystem('admin-1', { ...write, forumScope: 'all', forumIds: [] });
    expect((await service.listPersonal('user-1')).map((item) => item.id)).toEqual([personal.id]);
    expect((await service.listSystem()).map((item) => item.id)).toEqual([system.id]);
    const updated = await service.updatePersonal('user-1', personal.id, personal.revision, {
      ...write,
      contexts: ['new_thread'],
    });
    expect(updated.contexts).toEqual(['new_thread']);
    await expect(service.updatePersonal('user-1', personal.id, personal.revision, write)).rejects.toBeInstanceOf(
      MessageTemplateConflictError
    );
    await expect(service.deletePersonal('user-1', personal.id, personal.revision)).rejects.toBeInstanceOf(
      MessageTemplateConflictError
    );
    await service.deletePersonal('user-1', personal.id, updated.revision);
    expect(await service.listPersonal('user-1')).toEqual([]);
  });

  it('returns only the requested selected forum from an effective template', async () => {
    const created = await service.createSystem('admin-1', {
      ...write,
      forumIds: ['forum-1', 'forum-2'],
    });
    expect((await service.listSystem())[0]?.forumIds).toEqual(['forum-1', 'forum-2']);
    expect(
      (await service.listEffective({ identityId: 'user-1', context: 'reply', forumId: 'forum-1' }))[0]?.forumIds
    ).toEqual(['forum-1']);
    expect(created.forumIds).toEqual(['forum-1', 'forum-2']);
  });

  it('requires a complete reorder and rolls back when any revision is stale', async () => {
    const first = await service.createPersonal('user-1', { ...write, name: 'First' });
    const second = await service.createPersonal('user-1', { ...write, name: 'Second' });
    await expect(
      service.reorderPersonal('user-1', [{ id: second.id, revision: second.revision }])
    ).rejects.toBeInstanceOf(MessageTemplateValidationError);
    await expect(service.reorderPersonal('user-1', [])).rejects.toBeInstanceOf(MessageTemplateValidationError);

    const reordered = await service.reorderPersonal('user-1', [
      { id: second.id, revision: second.revision },
      { id: first.id, revision: first.revision },
    ]);
    expect(reordered.map((item) => [item.name, item.sortOrder])).toEqual([
      ['Second', 0],
      ['First', 1],
    ]);

    await expect(
      service.reorderPersonal('user-1', [
        { id: first.id, revision: first.revision },
        { id: second.id, revision: second.revision },
      ])
    ).rejects.toBeInstanceOf(MessageTemplateConflictError);
    expect((await service.listPersonal('user-1')).map((item) => item.name)).toEqual(['Second', 'First']);
  });

  it('enforces the personal quota transactionally', async () => {
    for (let index = 0; index < 200; index += 1) {
      await service.createPersonal('user-1', { ...write, name: `Template ${String(index)}` });
    }
    await expect(service.createPersonal('user-1', { ...write, name: 'One too many' })).rejects.toThrow('quota of 200');
    expect(await service.listPersonal('user-1')).toHaveLength(200);
  });

  it('cascades personal ownership while retaining system templates when their creator is deleted', async () => {
    await service.createPersonal('user-1', write);
    await service.createSystem('admin-1', { ...write, forumScope: 'all', forumIds: [] });
    db.prepare("delete from identities where id = 'user-1'").run();
    expect(db.prepare("select count(*) count from message_templates where scope='personal'").get()).toEqual({
      count: 0,
    });
    db.prepare("delete from identities where id = 'admin-1'").run();
    const system = db.prepare("select created_by, updated_by from message_templates where scope='system'").get();
    expect(system).toEqual({ created_by: null, updated_by: null });
  });

  it('rejects bodies larger than 64 KiB in UTF-8', async () => {
    await expect(service.createPersonal('user-1', { ...write, body: '🙂'.repeat(16385) })).rejects.toThrow('64 KiB');
  });
});
