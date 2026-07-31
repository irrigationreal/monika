import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessageTemplateService } from '@irrigationreal/codex-forum-core';

import { migrate } from '../db';
import { SqliteMessageTemplateRepository } from '../repositories/sqliteMessageTemplateRepository';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { hashToken } from '../utils/auth';
import { registerMessageTemplateRoutes } from './messageTemplateRoutes';

const payload = {
  name: 'Approval',
  category: 'Review',
  body: 'Approved.',
  threadTitle: null,
  forumScope: 'all',
  forumIds: [],
  contexts: ['reply'],
  enabled: true,
};

describe('message template routes access', () => {
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
    const access = createAccessHelpers(instance, store);
    registerMessageTemplateRoutes({
      app: instance,
      access,
      service: new MessageTemplateService(new SqliteMessageTemplateRepository(db)),
    });
    await instance.ready();
    return instance;
  }

  it('requires authentication for personal and effective endpoints', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    expect((await instance.inject({ method: 'GET', url: '/message-templates/mine' })).statusCode).toBe(401);
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: `/message-templates/effective?context=reply&forumId=${forum.id}`,
        })
      ).statusCode
    ).toBe(401);
  });

  it('keeps personal templates private and effective filtering server-side', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const adminForum = store.createForum('Secret', null, null, null, null, 'active', 'admin');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const viewer = store.createIdentityWithPassword('Viewer', 'viewer', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('viewer-token', viewer.id);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/message-templates',
          headers: { authorization: 'Bearer owner-token' },
          payload,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/message-templates/mine',
          headers: { authorization: 'Bearer viewer-token' },
        })
      ).json()
    ).toEqual({ templates: [] });
    const effective = await instance.inject({
      method: 'GET',
      url: `/message-templates/effective?context=reply&forumId=${forum.id}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(effective.json().templates).toHaveLength(1);
    const hidden = await instance.inject({
      method: 'GET',
      url: `/message-templates/effective?context=reply&forumId=${adminForum.id}`,
      headers: { authorization: 'Bearer viewer-token' },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects personal access while impersonating and returns only effective system templates', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('admin-token', admin.id);
    await instance.inject({
      method: 'POST',
      url: '/message-templates',
      headers: { authorization: 'Bearer owner-token' },
      payload,
    });
    await instance.inject({
      method: 'POST',
      url: '/admin/message-templates',
      headers: { authorization: 'Bearer admin-token' },
      payload: { ...payload, name: 'System' },
    });
    store.createImpersonationToken({
      ownerIdentityId: admin.id,
      impersonatedIdentityId: owner.id,
      label: 'test',
      tokenHash: hashToken('imp-token'),
      tokenPrefix: 'imp',
      scopes: ['read', 'write'],
    });
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/message-templates/mine',
          headers: { authorization: 'Bearer imp-token' },
        })
      ).statusCode
    ).toBe(403);
    const effective = await instance.inject({
      method: 'GET',
      url: `/message-templates/effective?context=reply&forumId=${forum.id}`,
      headers: { authorization: 'Bearer imp-token' },
    });
    expect((effective.json() as { templates: { scope: string }[] }).templates.map((item) => item.scope)).toEqual([
      'system',
    ]);
  });

  it('does not disclose other selected forum ids in an effective response', async () => {
    const instance = await app();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const adminForum = store.createForum('Secret', null, null, null, null, 'active', 'admin');
    const viewer = store.createIdentityWithPassword('Viewer', 'viewer', 'hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('viewer-token', viewer.id);
    store.createAuthSession('admin-token', admin.id);
    const created = await instance.inject({
      method: 'POST',
      url: '/admin/message-templates',
      headers: { authorization: 'Bearer admin-token' },
      payload: {
        ...payload,
        forumScope: 'selected',
        forumIds: [publicForum.id, adminForum.id],
      },
    });
    expect(created.statusCode).toBe(200);

    const effective = await instance.inject({
      method: 'GET',
      url: `/message-templates/effective?context=reply&forumId=${publicForum.id}`,
      headers: { authorization: 'Bearer viewer-token' },
    });
    expect(effective.statusCode).toBe(200);
    expect((effective.json() as { templates: { forumIds: string[] }[] }).templates[0]?.forumIds).toEqual([
      publicForum.id,
    ]);
  });

  it('rejects invalid body and forum-scope combinations at the contract boundary', async () => {
    const instance = await app();
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    const request = (overrides: Record<string, unknown>) =>
      instance.inject({
        method: 'POST',
        url: '/message-templates',
        headers: { authorization: 'Bearer owner-token' },
        payload: { ...payload, ...overrides },
      });

    expect((await request({ body: '   ' })).statusCode).toBe(400);
    expect((await request({ forumScope: 'selected', forumIds: [] })).statusCode).toBe(400);
    expect((await request({ forumScope: 'all', forumIds: [forum.id] })).statusCode).toBe(400);
  });

  it('maps stale personal revisions to conflict without deleting the latest version', async () => {
    const instance = await app();
    store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    store.createAuthSession('owner-token', owner.id);
    const created = (
      await instance.inject({
        method: 'POST',
        url: '/message-templates',
        headers: { authorization: 'Bearer owner-token' },
        payload,
      })
    ).json() as { id: string; revision: number };
    const updated = await instance.inject({
      method: 'PATCH',
      url: `/message-templates/${created.id}`,
      headers: { authorization: 'Bearer owner-token' },
      payload: { ...payload, body: 'Updated.', revision: created.revision },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (
        await instance.inject({
          method: 'DELETE',
          url: `/message-templates/${created.id}?revision=${String(created.revision)}`,
          headers: { authorization: 'Bearer owner-token' },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/message-templates/mine',
          headers: { authorization: 'Bearer owner-token' },
        })
      ).json().templates
    ).toHaveLength(1);
  });

  it('separates admin system APIs from personal rows', async () => {
    const instance = await app();
    store.createForum('Public', null, null, null, null, 'active', 'public');
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('admin-token', admin.id);
    await instance.inject({
      method: 'POST',
      url: '/message-templates',
      headers: { authorization: 'Bearer owner-token' },
      payload,
    });
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/admin/message-templates',
          headers: { authorization: 'Bearer admin-token' },
        })
      ).json()
    ).toEqual({ templates: [] });
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/admin/message-templates',
          headers: { authorization: 'Bearer owner-token' },
          payload,
        })
      ).statusCode
    ).toBe(403);
  });
});
