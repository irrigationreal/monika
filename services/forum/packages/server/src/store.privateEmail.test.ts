import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { ForumStore } from './store';

describe('Identity private email', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores and retrieves a private email address', () => {
    const identity = store.createIdentity('Alice');
    expect(store.getIdentityPrivateEmail(identity.id)).toBeNull();
    expect(store.hasIdentityPrivateEmail(identity.id)).toBe(false);

    store.setIdentityPrivateEmail(identity.id, 'alice@example.com');
    expect(store.getIdentityPrivateEmail(identity.id)).toBe('alice@example.com');
    expect(store.hasIdentityPrivateEmail(identity.id)).toBe(true);
  });

  it('can clear a private email address', () => {
    const identity = store.createIdentity('Alice');
    store.setIdentityPrivateEmail(identity.id, 'alice@example.com');
    expect(store.hasIdentityPrivateEmail(identity.id)).toBe(true);

    store.setIdentityPrivateEmail(identity.id, null);
    expect(store.getIdentityPrivateEmail(identity.id)).toBeNull();
    expect(store.hasIdentityPrivateEmail(identity.id)).toBe(false);
  });

  it('throws when setting private email for non-existent identity', () => {
    expect(() => store.setIdentityPrivateEmail('missing', 'alice@example.com')).toThrow('identity not found');
  });
});

