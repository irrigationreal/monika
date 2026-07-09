import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { PiSessionSyncService } from './piSessionSyncService';

function createService(cwd: string | null) {
  const db = new Database(':memory:');
  db.exec(`
    create table forums (
      id text primary key,
      name text not null,
      parent_forum_id text,
      cwd text,
      created_at text not null,
      updated_at text not null
    );
  `);
  db.prepare(
    'insert into forums (id, name, parent_forum_id, cwd, created_at, updated_at) values (?, ?, ?, ?, ?, ?)'
  ).run('forum-1', 'General', null, cwd, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  const service = new PiSessionSyncService(db, { agentdBaseUrl: 'http://agentd.test', intervalMs: 60_000 });
  return {
    db,
    ensureForum: (nextCwd: string | null) =>
      (
        service as unknown as {
          ensureForum(name: string, parentForumId: string | null, cwd: string | null): string;
        }
      ).ensureForum('General', null, nextCwd),
  };
}

describe('PiSessionSyncService forum cwd reconciliation', () => {
  it('backfills a taxonomy cwd when the existing forum cwd is null', () => {
    const { db, ensureForum } = createService(null);

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace' });

    db.close();
  });

  it('preserves an explicit forum cwd', () => {
    const { db, ensureForum } = createService('/workspace/custom');

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace/custom' });

    db.close();
  });
});
