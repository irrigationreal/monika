import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessageDraftService, NotepadService } from '@irrigationreal/codex-forum-core';

import { migrate } from '../db';
import { SqliteMessageDraftRepository } from '../repositories/sqliteMessageDraftRepository';
import { SqliteNotepadRepository } from '../repositories/sqliteNotepadRepository';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { hashToken } from '../utils/auth';
import { registerNotepadRoutes } from './notepadRoutes';

describe('Notepad route privacy', () => {
  let db: Database.Database;
  let store: ForumStore;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });
  afterEach(() => db.close());
  async function app() {
    const instance = Fastify({ logger: false });
    await instance.register(sensible);
    registerNotepadRoutes({
      app: instance,
      access: createAccessHelpers(instance, store),
      service: new NotepadService(new SqliteNotepadRepository(db)),
    });
    await instance.ready();
    return instance;
  }

  it('is browser-session-only, owner-scoped, and no-store', async () => {
    const instance = await app();
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('other-token', other.id);
    expect((await instance.inject({ method: 'GET', url: '/notepad' })).statusCode).toBe(401);
    const draft = await new MessageDraftService(new SqliteMessageDraftRepository(db)).saveNotepad(owner.id, 0, {
      body: 'private',
      options: { tags: ['secret'], expiration: 'never' },
    });
    const created = await instance.inject({
      method: 'POST',
      url: '/notepad',
      headers: { authorization: 'Bearer owner-token' },
      payload: {
        body: 'private',
        tags: ['secret'],
        expiration: 'never',
        draft: { id: draft.id, revision: draft.revision },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    const id = created.json().entry.id as string;
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: `/notepad/${id}`,
          headers: { authorization: 'Bearer other-token' },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await instance.inject({ method: 'GET', url: '/notepad', headers: { authorization: 'Bearer other-token' } })
      ).json()
    ).toEqual({ entries: [], tags: [], nextCursor: null });
  });

  it('rejects malformed list limits and publication without a saved draft', async () => {
    const instance = await app();
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/notepad?limit=abc',
          headers: { authorization: 'Bearer owner-token' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/notepad',
          headers: { authorization: 'Bearer owner-token' },
          payload: { body: 'not saved' },
        })
      ).statusCode
    ).toBe(400);
  });

  it('rejects API keys and impersonation tokens', async () => {
    const instance = await app();
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createApiKey({
      identityId: owner.id,
      label: 'key',
      tokenHash: hashToken('api-token'),
      tokenPrefix: 'api',
      scopes: ['read', 'write'],
      expiresAt: null,
    });
    store.createImpersonationToken({
      ownerIdentityId: admin.id,
      impersonatedIdentityId: owner.id,
      label: 'imp',
      tokenHash: hashToken('imp-token'),
      tokenPrefix: 'imp',
      scopes: ['read', 'write'],
      expiresAt: null,
    });
    expect(
      (await instance.inject({ method: 'GET', url: '/notepad', headers: { authorization: 'Bearer api-token' } }))
        .statusCode
    ).toBe(403);
    expect(
      (await instance.inject({ method: 'GET', url: '/notepad', headers: { authorization: 'Bearer imp-token' } }))
        .statusCode
    ).toBe(403);
  });
});
