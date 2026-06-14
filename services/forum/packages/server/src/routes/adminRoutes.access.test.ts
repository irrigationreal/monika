import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAdminRoutes } from './adminRoutes';

describe('Admin routes access controls', () => {
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
    const codex = {
      listActiveTurns: () => [],
      listQueuedTurns: () => [],
      pauseActiveThreads: async () => ({ paused: 0, skipped: 0 })
    } as any;
    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();
    return app;
  }

  it('blocks non-admins from admin panel endpoints', async () => {
    const app = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const routes = [
      { method: 'GET', url: '/admin/users' },
      { method: 'POST', url: '/admin/users' },
      { method: 'PATCH', url: '/admin/users/user-1' },
      { method: 'DELETE', url: '/admin/users/user-1' },
      { method: 'GET', url: '/admin/forums' },
      { method: 'POST', url: '/admin/forums' },
      { method: 'PATCH', url: '/admin/forums/forum-1' },
      { method: 'DELETE', url: '/admin/forums/forum-1' },
      { method: 'GET', url: '/admin/forums/forum-1/access' },
      { method: 'POST', url: '/admin/forums/forum-1/access' },
      { method: 'POST', url: '/admin/topics/topic-1/move' },
      { method: 'GET', url: '/admin/topics/topic-1/access' },
      { method: 'POST', url: '/admin/topics/topic-1/access' },
      { method: 'DELETE', url: '/admin/access/rule-1' },
      { method: 'GET', url: '/admin/forums/forum-1/personas' },
      { method: 'POST', url: '/admin/forums/forum-1/personas' },
      { method: 'PATCH', url: '/admin/forums/forum-1/personas/key' },
      { method: 'DELETE', url: '/admin/forums/forum-1/personas/key' },
      { method: 'GET', url: '/admin/tampers/plugins' },
      { method: 'GET', url: '/admin/skills' },
      { method: 'GET', url: '/admin/tampers' },
      { method: 'POST', url: '/admin/tampers' },
      { method: 'PATCH', url: '/admin/tampers/config-1' },
      { method: 'DELETE', url: '/admin/tampers/config-1' },
      { method: 'POST', url: '/admin/tampers/test' },
      { method: 'GET', url: '/admin/deploy/status' },
      { method: 'POST', url: '/admin/deploy' },
      { method: 'POST', url: '/admin/deploy/on-finish' },
      { method: 'POST', url: '/admin/deploy/on-finish/cancel' },
      { method: 'GET', url: '/admin/robot/automations' },
      { method: 'POST', url: '/admin/robot/automations' },
      { method: 'PATCH', url: '/admin/robot/automations/auto-1' },
      { method: 'DELETE', url: '/admin/robot/automations/auto-1' },
      { method: 'POST', url: '/admin/robot/automations/auto-1/run' },
      { method: 'GET', url: '/admin/robot/automations/auto-1/runs' },
      { method: 'GET', url: '/admin/robot/dashboard' },
      { method: 'PATCH', url: '/admin/robot/settings' }
    ];

    for (const route of routes) {
      const guestRes = await app.inject({ method: route.method, url: route.url });
      expect(guestRes.statusCode, `${route.method} ${route.url} guest`).toBe(401);

      const humanRes = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer human-token' }
      });
      expect(humanRes.statusCode, `${route.method} ${route.url} human`).toBe(403);
    }

    const adminRes = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminRes.statusCode).toBe(200);
  });
});

