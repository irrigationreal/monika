import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap, migrate } from './db';

describe('database bootstrap web identity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertIdentity(input: {
    id: string;
    displayName: string;
    kind: string;
    username?: string | null;
    avatarUrl?: string | null;
  }): void {
    const now = new Date().toISOString();
    db.prepare(
      'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, username, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      input.id,
      null,
      input.displayName,
      input.kind,
      null,
      input.avatarUrl ?? null,
      input.username ?? null,
      now,
      now
    );
  }

  it('creates a generic web user when no default human exists', () => {
    const result = bootstrap(db);

    const identity = db.prepare('select display_name, username, kind, avatar_url from identities where id = ?').get(result.webIdentityId) as
      | { display_name: string; username: string | null; kind: string; avatar_url: string | null }
      | undefined;

    expect(identity).toEqual({
      display_name: 'Web User',
      username: null,
      kind: 'human',
      avatar_url: '/avatars/user.svg',
    });
  });

  it('uses a configured existing identity without renaming or downgrading it', () => {
    insertIdentity({
      id: 'neon-id',
      displayName: 'neon',
      username: 'neon',
      kind: 'admin',
      avatarUrl: '/uploads/avatars/neon.jpg',
    });

    const result = bootstrap(db, { defaultWebIdentityId: 'neon-id' });

    const identity = db.prepare('select display_name, username, kind, avatar_url from identities where id = ?').get(result.webIdentityId) as
      | { display_name: string; username: string | null; kind: string; avatar_url: string | null }
      | undefined;

    expect(result.webIdentityId).toBe('neon-id');
    expect(identity).toEqual({
      display_name: 'neon',
      username: 'neon',
      kind: 'admin',
      avatar_url: '/uploads/avatars/neon.jpg',
    });
  });

  it('does not apply legacy pp-to-neon renaming during normal startup', () => {
    insertIdentity({ id: 'pp-id', displayName: 'pp', kind: 'human' });

    const result = bootstrap(db);

    const identity = db.prepare('select display_name, kind from identities where id = ?').get(result.webIdentityId) as
      | { display_name: string; kind: string }
      | undefined;

    expect(result.webIdentityId).toBe('pp-id');
    expect(identity).toEqual({ display_name: 'pp', kind: 'human' });
  });

  it('can create the web identity from deployment configuration', () => {
    const result = bootstrap(db, {
      defaultWebIdentityId: 'configured-web-id',
      defaultWebIdentityDisplayName: 'Local Human',
      defaultWebIdentityUsername: 'local-human',
    });

    const identity = db.prepare('select id, display_name, username, kind, avatar_url from identities where id = ?').get(result.webIdentityId) as
      | { id: string; display_name: string; username: string | null; kind: string; avatar_url: string | null }
      | undefined;

    expect(identity).toEqual({
      id: 'configured-web-id',
      display_name: 'Local Human',
      username: 'local-human',
      kind: 'human',
      avatar_url: '/avatars/user.svg',
    });
  });
});
