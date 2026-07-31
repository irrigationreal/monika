import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAnalyticsRoutes } from './analyticsRoutes';

const query = '?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&bucket=day';

describe('analytics route access and validation', () => {
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
    registerAnalyticsRoutes({
      app: instance,
      access,
      service: {
        async getAnalytics(input: any) {
          return {
            generatedAt: '2026-07-31T00:00:00.000Z',
            window: input.window,
            selectedForumId: null,
            forums: [],
            vocabulary: { algorithmVersion: 1, groups: [] },
            runtime: { available: false, warning: 'fixture', metrics: null },
          };
        },
      } as any,
    });
    await instance.ready();
    return instance;
  }

  it('requires an administrator', async () => {
    const instance = await app();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentity('Human', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);
    expect((await instance.inject({ url: `/admin/analytics${query}` })).statusCode).toBe(401);
    expect(
      (await instance.inject({ url: `/admin/analytics${query}`, headers: { authorization: 'Bearer human-token' } }))
        .statusCode
    ).toBe(403);
    const response = await instance.inject({
      url: `/admin/analytics${query}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runtime.available).toBe(false);
  });

  it('rejects inverted and over-wide ranges', async () => {
    const instance = await app();
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const headers = { authorization: 'Bearer admin-token' };
    expect(
      (
        await instance.inject({
          url: '/admin/analytics?from=2026-08-01T00%3A00%3A00.000Z&to=2026-07-01T00%3A00%3A00.000Z&bucket=day',
          headers,
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await instance.inject({
          url: '/admin/analytics?from=2025-01-01T00%3A00%3A00.000Z&to=2026-07-01T00%3A00%3A00.000Z&bucket=week',
          headers,
        })
      ).statusCode
    ).toBe(400);
  });
});
