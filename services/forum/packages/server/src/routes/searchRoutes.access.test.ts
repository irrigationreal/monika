import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerSearchRoutes } from './searchRoutes';

describe('Search routes access controls', () => {
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

  async function buildApp(options?: { rateLimiting?: boolean }) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    if (options?.rateLimiting) {
      await app.register(rateLimit, {
        max: 1000,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip,
      });
    }
    const access = createAccessHelpers(app, store);
    registerSearchRoutes({
      app,
      store,
      featureFlags: { enableSearch: true, enableRateLimiting: Boolean(options?.rateLimiting) } as any,
      access,
    });
    await app.ready();
    return app;
  }

  function createTopicWithPost(forumId: string, title: string, body: string, authorId: string) {
    const { topic, post } = store.createTopic({ forumId, title, body, authorId });
    return { topic, post };
  }

  it('returns only public results to guests', async () => {
    const app = await buildApp();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const membersForum = store.createForum('Members', null, null, null, null, 'active', 'members');
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const author = store.createIdentity('Author', 'human');

    createTopicWithPost(publicForum.id, 'needle public topic', 'needle public post', author.id);
    createTopicWithPost(membersForum.id, 'needle members topic', 'needle members post', author.id);
    createTopicWithPost(adminForum.id, 'needle admin topic', 'needle admin post', author.id);

    const res = await app.inject({ method: 'GET', url: '/search?q=needle' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.topics.map((topic: any) => topic.title)).toEqual(['needle public topic']);
    expect(body.posts.map((post: any) => post.body)).toEqual(['needle public post']);
    expect(JSON.stringify(body)).not.toContain('members');
    expect(JSON.stringify(body)).not.toContain('admin');
  });

  it('filters visibility before applying the result limit', async () => {
    const app = await buildApp();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const author = store.createIdentity('Author', 'human');

    const privateOne = createTopicWithPost(adminForum.id, 'private one', 'needle private one', author.id);
    const privateTwo = createTopicWithPost(adminForum.id, 'private two', 'needle private two', author.id);
    const publicOne = createTopicWithPost(publicForum.id, 'public one', 'needle public one', author.id);
    const publicTwo = createTopicWithPost(publicForum.id, 'public two', 'needle public two', author.id);

    db.prepare('update posts set created_at = ? where id = ?').run('2026-06-20T18:04:00.000Z', privateOne.post.id);
    db.prepare('update posts set created_at = ? where id = ?').run('2026-06-20T18:03:00.000Z', privateTwo.post.id);
    db.prepare('update posts set created_at = ? where id = ?').run('2026-06-20T18:02:00.000Z', publicOne.post.id);
    db.prepare('update posts set created_at = ? where id = ?').run('2026-06-20T18:01:00.000Z', publicTwo.post.id);

    const res = await app.inject({ method: 'GET', url: '/search?q=needle&scope=posts&limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.topics).toEqual([]);
    expect(body.posts.map((post: any) => post.body)).toEqual(['needle public one', 'needle public two']);
  });

  it('allows authenticated members to see members results but not admin results', async () => {
    const app = await buildApp();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const membersForum = store.createForum('Members', null, null, null, null, 'active', 'members');
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const author = store.createIdentity('Author', 'human');
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('member-token', member.id);

    createTopicWithPost(publicForum.id, 'needle public topic', 'needle public post', author.id);
    createTopicWithPost(membersForum.id, 'needle members topic', 'needle members post', author.id);
    createTopicWithPost(adminForum.id, 'needle admin topic', 'needle admin post', author.id);

    const res = await app.inject({
      method: 'GET',
      url: '/search?q=needle',
      headers: { authorization: 'Bearer member-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.topics.map((topic: any) => topic.title).sort()).toEqual([
      'needle members topic',
      'needle public topic',
    ]);
    expect(body.posts.map((post: any) => post.body).sort()).toEqual(['needle members post', 'needle public post']);
    expect(JSON.stringify(body)).not.toContain('admin');
  });

  it('allows admins to see admin results', async () => {
    const app = await buildApp();
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    store.createAuthSession('admin-token', admin.id);
    createTopicWithPost(adminForum.id, 'needle admin topic', 'needle admin post', admin.id);

    const res = await app.inject({
      method: 'GET',
      url: '/search?q=needle',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.topics.map((topic: any) => topic.title)).toEqual(['needle admin topic']);
    expect(body.posts.map((post: any) => post.body)).toEqual(['needle admin post']);
  });

  it('supports current-forum search without leaking other visible forums', async () => {
    const app = await buildApp();
    const firstForum = store.createForum('First', null, null, null, null, 'active', 'public');
    const secondForum = store.createForum('Second', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    createTopicWithPost(firstForum.id, 'needle first topic', 'needle first post', author.id);
    createTopicWithPost(secondForum.id, 'needle second topic', 'needle second post', author.id);

    const scoped = await app.inject({ method: 'GET', url: `/search?q=needle&forumId=${firstForum.id}` });
    expect(scoped.statusCode).toBe(200);
    expect((scoped.json() as any).topics.map((topic: any) => topic.title)).toEqual(['needle first topic']);

    const global = await app.inject({ method: 'GET', url: '/search?q=needle' });
    expect(global.statusCode).toBe(200);
    expect((global.json() as any).topics.map((topic: any) => topic.title).sort()).toEqual([
      'needle first topic',
      'needle second topic',
    ]);
  });

  it('rejects invalid scopes and malformed limits', async () => {
    const app = await buildApp();
    const invalidScope = await app.inject({ method: 'GET', url: '/search?q=needle&scope=everything' });
    expect(invalidScope.statusCode).toBe(400);

    const invalidLimit = await app.inject({ method: 'GET', url: '/search?q=needle&limit=not-a-number' });
    expect(invalidLimit.statusCode).toBe(400);
  });

  it('keeps search input parameterized', async () => {
    const app = await buildApp();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const author = store.createIdentity('Author', 'human');
    createTopicWithPost(publicForum.id, 'ordinary public topic', 'ordinary public post', author.id);
    createTopicWithPost(adminForum.id, 'admin secret topic', 'admin secret post', author.id);

    const res = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent("needle%' OR 1=1 --")}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ topics: [], posts: [] });
  });

  it('applies a search-specific rate limit', async () => {
    const app = await buildApp({ rateLimiting: true });
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    createTopicWithPost(publicForum.id, 'needle topic', 'needle post', author.id);

    let lastStatus = 200;
    for (let i = 0; i < 61; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/search?q=needle' });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});
