import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { SqliteIdentityRepository } from './sqliteRepositories';

import type { IdentityPrivate } from '@irrigationreal/codex-forum-core';

describe('SqliteIdentityRepository private preferences', () => {
  let db: Database.Database;
  let repository: SqliteIdentityRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repository = new SqliteIdentityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips private desktop and mobile Quick Reply preferences through create and update', async () => {
    const identity: IdentityPrivate = {
      id: 'identity-1',
      displayName: 'Reader',
      kind: 'human',
      username: 'reader',
      passwordHash: 'secret',
      privateEmail: 'reader@example.com',
      quickReplyDesktopMode: 'docked',
      quickReplyMobileMode: 'inline',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    await repository.create(identity);
    expect(await repository.getById(identity.id)).toMatchObject({
      quickReplyDesktopMode: 'docked',
      quickReplyMobileMode: 'inline',
    });

    await repository.update({ ...identity, quickReplyDesktopMode: 'inline', quickReplyMobileMode: 'docked' });
    expect(await repository.getById(identity.id)).toMatchObject({
      quickReplyDesktopMode: 'inline',
      quickReplyMobileMode: 'docked',
    });
  });
});
