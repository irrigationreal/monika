import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessageDraftService } from '@irrigationreal/codex-forum-core';

import { migrate } from '../db';
import { SqliteMessageDraftRepository } from '../repositories/sqliteMessageDraftRepository';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { hashToken } from '../utils/auth';
import { registerMessageDraftRoutes } from './messageDraftRoutes';

describe('message draft route privacy', () => {
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
    registerMessageDraftRoutes({
      app: instance,
      store,
      access: createAccessHelpers(instance, store),
      service: new MessageDraftService(new SqliteMessageDraftRepository(db)),
    });
    await instance.ready();
    return instance;
  }
  it('requires browser sessions and never exposes another owner draft', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('other-token', other.id);
    expect((await instance.inject({ method: 'GET', url: '/drafts' })).statusCode).toBe(401);
    const created = await instance.inject({
      method: 'POST',
      url: `/forums/${forum.id}/drafts`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { expectedRevision: 0, title: 'Secret', body: 'private prose' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    const id = created.json().draft.id as string;
    expect(
      (await instance.inject({ method: 'GET', url: `/drafts/${id}`, headers: { authorization: 'Bearer other-token' } }))
        .statusCode
    ).toBe(404);
    expect(
      (
        await instance.inject({ method: 'GET', url: '/drafts', headers: { authorization: 'Bearer other-token' } })
      ).json()
    ).toEqual({ drafts: [] });
  });
  it('keeps owned text manageable without leaking locked destination metadata', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    const topic = store.createTopic({
      forumId: forum.id,
      title: 'Sensitive destination',
      body: 'starter',
      authorId: owner.id,
    }).topic;
    expect(
      (
        await instance.inject({
          method: 'PUT',
          url: `/topics/${topic.id}/draft`,
          headers: { authorization: 'Bearer owner-token' },
          payload: { expectedRevision: 0, body: 'private reply' },
        })
      ).statusCode
    ).toBe(200);
    store.updateTopicStatus(topic.id, 'locked');
    const listed = (
      await instance.inject({ method: 'GET', url: '/drafts', headers: { authorization: 'Bearer owner-token' } })
    ).json().drafts[0];
    expect(listed).toMatchObject({ body: 'private reply', destinationName: null, canContinue: false });
  });

  it('rejects API keys and impersonation even when they resolve to the owner', async () => {
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
      (await instance.inject({ method: 'GET', url: '/drafts', headers: { authorization: 'Bearer api-token' } }))
        .statusCode
    ).toBe(403);
    expect(
      (await instance.inject({ method: 'GET', url: '/drafts', headers: { authorization: 'Bearer imp-token' } }))
        .statusCode
    ).toBe(403);
  });
});
