import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MessageDraftConflictError,
  MessageDraftQuotaError,
  MessageDraftService,
} from '@irrigationreal/codex-forum-core';

import { runMigrations } from '../migrations';
import { ForumStore } from '../store';
import { SqliteMessageDraftRepository } from './sqliteMessageDraftRepository';

describe('SqliteMessageDraftRepository', () => {
  let db: Database.Database;
  let now: string;
  let service: MessageDraftService;
  let topicId: string;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    now = '2026-08-02T12:00:00.000Z';
    db.prepare(
      "insert into identities (id,display_name,kind,created_at,updated_at) values ('u1','One','human',?,?),('u2','Two','human',?,?)"
    ).run(now, now, now, now);
    db.prepare(
      "insert into forums (id,name,status,visibility,created_at,updated_at) values ('f1','Forum','active','public',?,?)"
    ).run(now, now);
    topicId = new ForumStore(db).createTopic({ forumId: 'f1', title: 'Topic', body: 'starter', authorId: 'u1' }).topic
      .id;
    let sequence = 0;
    service = new MessageDraftService(
      new SqliteMessageDraftRepository(db),
      () => now,
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    );
  });

  it('isolates owners and enforces one revisioned reply per owner/topic', async () => {
    const first = await service.saveReply('u1', topicId, 0, { body: 'private' });
    expect(await service.getReply('u2', topicId)).toBeNull();
    await expect(service.saveReply('u1', topicId, 0, { body: 'overwrite' })).rejects.toBeInstanceOf(
      MessageDraftConflictError
    );
    const second = await service.saveReply('u1', topicId, first.revision, { body: 'updated' });
    expect(second.revision).toBe(2);
    expect((await service.saveReply('u1', topicId, second.revision, { body: 'updated' })).revision).toBe(2);
  });

  it('supports multiple new-thread drafts and does not renew identical content', async () => {
    const one = await service.saveNewThread('u1', 'f1', 0, { title: 'One', body: 'body one' });
    const two = await service.saveNewThread('u1', 'f1', 0, { title: 'Two', body: 'body two' });
    expect(new Set((await service.listNewThreadByForum('u1', 'f1')).map((item) => item.id))).toEqual(
      new Set([one.id, two.id])
    );
    now = '2026-08-03T12:00:00.000Z';
    const same = await service.saveNewThread('u1', 'f1', one.revision, { title: 'One', body: 'body one' }, one.id);
    expect(same.updatedAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('consumes only an exact revision atomically with publication', async () => {
    const store = new ForumStore(db);
    const draft = await service.saveReply('u1', topicId, 0, { body: 'publish me' });
    expect(() =>
      store.createPost({ topicId, authorId: 'u1', body: 'post', draft: { id: draft.id, revision: draft.revision + 1 } })
    ).toThrow('draft changed');
    expect(await service.getReply('u1', topicId)).not.toBeNull();
    store.createPost({ topicId, authorId: 'u1', body: 'post', draft: { id: draft.id, revision: draft.revision } });
    expect(await service.getReply('u1', topicId)).toBeNull();
  });

  it('enforces the 500-active-draft safety quota after purging expired rows', async () => {
    for (let index = 0; index < 500; index += 1) {
      await service.saveNewThread('u1', 'f1', 0, { title: `Draft ${String(index)}`, body: '' });
    }
    await expect(service.saveNewThread('u1', 'f1', 0, { title: 'One too many', body: '' })).rejects.toBeInstanceOf(
      MessageDraftQuotaError
    );
  });

  it('expires, purges, and cascades private drafts', async () => {
    await service.saveReply('u1', topicId, 0, { body: 'reply' });
    await service.saveNewThread('u1', 'f1', 0, { title: 'new', body: '' });
    now = '2026-09-02T12:00:00.000Z';
    expect(await service.list('u1')).toEqual([]);
    expect(await service.purgeExpired()).toBe(2);
    now = '2026-08-02T12:00:00.000Z';
    await service.saveReply('u1', topicId, 0, { body: 'again' });
    new ForumStore(db).deleteTopic(topicId);
    expect(await service.list('u1')).toEqual([]);
  });
});
