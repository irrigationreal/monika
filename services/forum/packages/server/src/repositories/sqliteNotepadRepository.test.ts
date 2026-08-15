import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { MessageDraftService, NotepadConflictError, NotepadService } from '@irrigationreal/codex-forum-core';

import { runMigrations } from '../migrations';
import { SqliteMessageDraftRepository } from './sqliteMessageDraftRepository';
import { SqliteNotepadRepository } from './sqliteNotepadRepository';

describe('SqliteNotepadRepository', () => {
  let db: Database.Database;
  let now: string;
  let service: NotepadService;
  let drafts: MessageDraftService;
  let sequence = 0;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    now = '2026-08-14T12:00:00.000Z';
    db.prepare(
      "insert into identities (id,display_name,kind,created_at,updated_at) values ('u1','One','human',?,?),('u2','Two','human',?,?)"
    ).run(now, now, now, now);
    const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    service = new NotepadService(new SqliteNotepadRepository(db), () => now, id);
    drafts = new MessageDraftService(new SqliteMessageDraftRepository(db), () => now, id);
  });

  it('isolates owners and lists pinned then reverse chronological entries', async () => {
    const old = await service.create('u1', { body: 'old', tags: ['Writing'], expiration: 'never' });
    now = '2026-08-14T13:00:00.000Z';
    const newest = await service.create('u1', { body: 'new', tags: ['todo'], expiration: 'never' });
    await service.create('u2', { body: 'secret', tags: ['private'], expiration: 'never' });
    const pinned = await service.update('u1', old.id, old.revision, {
      body: old.body,
      title: old.title,
      tags: old.tags,
      expiration: 'keep',
      pinned: true,
    });
    expect((await service.list('u1', { tags: [] })).entries.map((entry) => entry.id)).toEqual([pinned.id, newest.id]);
    expect(await service.get('u2', old.id)).toBeNull();
    expect(await service.tags('u1')).toEqual([
      { tag: 'todo', count: 1 },
      { tag: 'writing', count: 1 },
    ]);
  });

  it('publishes only an exact Notepad draft revision and consumes it atomically', async () => {
    const draft = await drafts.saveNotepad('u1', 0, {
      body: 'capture',
      options: { tags: ['todo'], expiration: 'one_month' },
    });
    await expect(
      service.create('u1', { body: 'capture', draft: { id: draft.id, revision: draft.revision + 1 } })
    ).rejects.toBeInstanceOf(NotepadConflictError);
    expect(await drafts.getNotepad('u1')).not.toBeNull();
    await service.create('u1', { body: 'capture', draft: { id: draft.id, revision: draft.revision } });
    expect(await drafts.getNotepad('u1')).toBeNull();
  });

  it('rejects publication from an expired capture draft before draft cleanup runs', async () => {
    const draft = await drafts.saveNotepad('u1', 0, {
      body: 'stale capture',
      options: { tags: [], expiration: 'one_month' },
    });
    now = '2026-10-14T12:00:00.000Z';
    await expect(
      service.create('u1', { body: 'stale capture', draft: { id: draft.id, revision: draft.revision } })
    ).rejects.toBeInstanceOf(NotepadConflictError);
  });

  it('keeps due notes visible until cleanup physically deletes them', async () => {
    const entry = await service.create('u1', { body: 'temporary', expiration: 'one_day' });
    now = '2026-08-16T12:00:00.000Z';
    expect(await service.get('u1', entry.id)).not.toBeNull();
    expect(await service.purgeExpired()).toBe(1);
    expect(await service.get('u1', entry.id)).toBeNull();
  });

  it('hard deletes notes and their derived tags', async () => {
    const entry = await service.create('u1', { body: 'remove', tags: ['gone'], expiration: 'never' });
    await service.delete('u1', entry.id, entry.revision);
    expect(db.prepare('select * from notepad_entries where id = ?').get(entry.id)).toBeUndefined();
    expect(db.prepare('select * from notepad_entry_tags where entry_id = ?').all(entry.id)).toEqual([]);
  });
});
