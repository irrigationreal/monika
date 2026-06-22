import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from './access';
import { hashToken } from './auth';
import { rateLimitKeyForRequest } from './rateLimit';

describe('rateLimitKeyForRequest', () => {
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
    app.get('/key', (request) => ({ key: rateLimitKeyForRequest(request, access) }));
    await app.ready();
    return app;
  }

  it('keys anonymous requests by client IP', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/key', remoteAddress: '198.51.100.10' });
    expect(res.json()).toEqual({ key: 'ip:198.51.100.10' });
  });

  it('keys browser sessions by identity', async () => {
    const app = await buildApp();
    const user = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('session-token', user.id);

    const res = await app.inject({
      method: 'GET',
      url: '/key',
      remoteAddress: '198.51.100.10',
      headers: { authorization: 'Bearer session-token' }
    });

    expect(res.json()).toEqual({ key: `identity:${user.id}` });
  });

  it('keys API and impersonation tokens by token id', async () => {
    const app = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    const apiKey = store.createApiKey({
      identityId: admin.id,
      label: 'api',
      tokenHash: hashToken('api-token'),
      tokenPrefix: 'api-toke',
      scopes: ['read'],
      expiresAt: null
    });
    const impersonation = store.createImpersonationToken({
      ownerIdentityId: admin.id,
      impersonatedIdentityId: human.id,
      label: 'impersonation',
      tokenHash: hashToken('imp-token'),
      tokenPrefix: 'imp-toke',
      scopes: ['read'],
      expiresAt: null
    });

    const apiRes = await app.inject({ method: 'GET', url: '/key', headers: { authorization: 'Bearer api-token' } });
    expect(apiRes.json()).toEqual({ key: `apiKey:${apiKey.id}` });

    const impersonationRes = await app.inject({ method: 'GET', url: '/key', headers: { authorization: 'Bearer imp-token' } });
    expect(impersonationRes.json()).toEqual({ key: `impersonation:${impersonation.id}` });
  });
});
