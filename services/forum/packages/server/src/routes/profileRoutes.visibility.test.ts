import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerProfileRoutes } from './profileRoutes';

describe('Profile routes visibility / privacy', () => {
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

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    registerProfileRoutes({ app, store, access });
    await app.ready();
    return app;
  }

  it('omits private quick-reply preferences from identity and public profile responses', async () => {
    const app = await buildApp();
    const profileOwner = store.createIdentityWithPassword('Owner', 'owner', 'pw-hash', 'human');
    const viewer = store.createIdentityWithPassword('Viewer', 'viewer', 'pw-hash', 'human');
    store.createAuthSession('viewer-token', viewer.id);
    store.setIdentityQuickReplyPreferences(profileOwner.id, { desktopMode: 'docked', mobileMode: 'inline' });

    const identityResponse = await app.inject({ method: 'GET', url: `/identities/${profileOwner.id}` });
    expect(identityResponse.statusCode).toBe(200);
    expect(identityResponse.json()).not.toHaveProperty('quickReplyDesktopMode');
    expect(identityResponse.json()).not.toHaveProperty('quickReplyMobileMode');

    const profileResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${profileOwner.id}`,
      headers: { authorization: 'Bearer viewer-token' }
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json()).not.toHaveProperty('quickReplyDesktopMode');
    expect(profileResponse.json()).not.toHaveProperty('quickReplyMobileMode');

    await app.close();
  });

  it('hides posts from admin-only forums for non-admin viewers', async () => {
    const app = await buildApp();

    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');

    const profileOwner = store.createIdentityWithPassword('Owner', 'owner', 'pw-hash', 'human');
    const viewer = store.createIdentityWithPassword('Viewer', 'viewer', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');

    store.createAuthSession('viewer-token', viewer.id);
    store.createAuthSession('admin-token', admin.id);

    // Owner posts in both forums.
    store.createTopic({ forumId: publicForum.id, title: 'Public Topic', body: 'public starter', authorId: profileOwner.id });
    store.createTopic({ forumId: adminForum.id, title: 'Admin Topic', body: 'admin starter', authorId: profileOwner.id });

    const viewerRes = await app.inject({
      method: 'GET',
      url: `/profiles/${profileOwner.id}/posts?page=1&pageSize=50`,
      headers: { authorization: 'Bearer viewer-token' }
    });
    expect(viewerRes.statusCode).toBe(200);
    const viewerBody = viewerRes.json() as { total: number; items: Array<{ forumId: string; topicTitle: string }> };
    expect(viewerBody.total).toBe(1);
    expect(viewerBody.items).toHaveLength(1);
    expect(viewerBody.items[0]?.topicTitle).toBe('Public Topic');
    expect(viewerBody.items.some((item) => item.forumId === adminForum.id)).toBe(false);

    const adminRes = await app.inject({
      method: 'GET',
      url: `/profiles/${profileOwner.id}/posts?page=1&pageSize=50`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminRes.statusCode).toBe(200);
    const adminBody = adminRes.json() as { total: number; items: Array<{ forumId: string; topicTitle: string }> };
    expect(adminBody.total).toBe(2);
    expect(adminBody.items).toHaveLength(2);
    expect(adminBody.items.map((item) => item.topicTitle).sort()).toEqual(['Admin Topic', 'Public Topic']);
  });

  it('returns only the requested page of results (pagination)', async () => {
    const app = await buildApp();

    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const profileOwner = store.createIdentityWithPassword('Owner', 'owner', 'pw-hash', 'human');
    const viewer = store.createIdentityWithPassword('Viewer', 'viewer', 'pw-hash', 'human');
    store.createAuthSession('viewer-token', viewer.id);

    for (let i = 0; i < 60; i++) {
      store.createTopic({
        forumId: forum.id,
        title: `Topic ${i}`,
        body: `post ${i}`,
        authorId: profileOwner.id
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/profiles/${profileOwner.id}/posts?page=1&pageSize=25`,
      headers: { authorization: 'Bearer viewer-token' }
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json() as { page: number; pageSize: number; total: number; items: unknown[] };
    expect(page1Body.page).toBe(1);
    expect(page1Body.pageSize).toBe(25);
    expect(page1Body.total).toBe(60);
    expect(page1Body.items).toHaveLength(25);

    const page3 = await app.inject({
      method: 'GET',
      url: `/profiles/${profileOwner.id}/posts?page=3&pageSize=25`,
      headers: { authorization: 'Bearer viewer-token' }
    });
    expect(page3.statusCode).toBe(200);
    const page3Body = page3.json() as { page: number; pageSize: number; total: number; items: unknown[] };
    expect(page3Body.page).toBe(3);
    expect(page3Body.pageSize).toBe(25);
    expect(page3Body.total).toBe(60);
    // 60 total, pageSize 25 -> page 3 has 10 items.
    expect(page3Body.items).toHaveLength(10);
  });
});

