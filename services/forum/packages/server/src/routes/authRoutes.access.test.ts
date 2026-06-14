import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteOneTimeLinkIssuer } from '../auth/oneTimeLinks';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAuthRoutes } from './authRoutes';

describe('Auth route access controls', () => {
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
    const featureFlags = { enableRateLimiting: false, enableAuth: true } as any;
    const linkIssuer = new SqliteOneTimeLinkIssuer(db, 'https://example.com');
    const emailService = { sendVerificationEmail: vi.fn(async () => {}) } as any;
    registerAuthRoutes({ app, store, featureFlags, linkIssuer, emailService, access });
    await app.ready();
    return app;
  }

  it('restricts API key and impersonation token routes to admins', async () => {
    const app = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const guestApiKeys = await app.inject({ method: 'GET', url: '/api-keys' });
    expect(guestApiKeys.statusCode).toBe(401);

    const humanApiKeys = await app.inject({
      method: 'GET',
      url: '/api-keys',
      headers: { authorization: 'Bearer human-token' }
    });
    expect(humanApiKeys.statusCode).toBe(403);

    const adminApiKeys = await app.inject({
      method: 'GET',
      url: '/api-keys',
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminApiKeys.statusCode).toBe(200);

    const humanCreateKey = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: 'Bearer human-token' },
      payload: { label: 'nope' }
    });
    expect(humanCreateKey.statusCode).toBe(403);

    const adminCreateKey = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: 'Bearer admin-token' },
      payload: { label: 'admin key' }
    });
    expect(adminCreateKey.statusCode).toBe(200);
    const created = adminCreateKey.json() as { apiKey: { id: string } };

    const humanDeleteKey = await app.inject({
      method: 'DELETE',
      url: `/api-keys/${created.apiKey.id}`,
      headers: { authorization: 'Bearer human-token' }
    });
    expect(humanDeleteKey.statusCode).toBe(403);

    const adminDeleteKey = await app.inject({
      method: 'DELETE',
      url: `/api-keys/${created.apiKey.id}`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminDeleteKey.statusCode).toBe(200);

    const guestImpersonation = await app.inject({ method: 'GET', url: '/impersonation-tokens' });
    expect(guestImpersonation.statusCode).toBe(401);

    const humanImpersonation = await app.inject({
      method: 'GET',
      url: '/impersonation-tokens',
      headers: { authorization: 'Bearer human-token' }
    });
    expect(humanImpersonation.statusCode).toBe(403);

    const adminImpersonation = await app.inject({
      method: 'POST',
      url: '/impersonation-tokens',
      headers: { authorization: 'Bearer admin-token' },
      payload: { label: 'token', displayName: 'Bot' }
    });
    expect(adminImpersonation.statusCode).toBe(200);
  });
});

