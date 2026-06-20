import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteOneTimeLinkIssuer } from '../auth/oneTimeLinks';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAuthRoutes } from './authRoutes';
import type { FeatureFlags } from '../config';

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

  async function buildApp(featureFlagOverrides: Partial<FeatureFlags> = {}) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags: FeatureFlags = {
      useRedisStreamBus: false,
      enableRateLimiting: false,
      enableAuth: true,
      enableSearch: false,
      registrationMode: 'disabled',
      ...featureFlagOverrides
    };
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

  it('reports disabled registration by default and rejects all registration attempts', async () => {
    const app = await buildApp();
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toEqual({
      mode: 'disabled',
      registrationEnabled: false,
      inviteRegistrationEnabled: false,
      publicRegistrationEnabled: false
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' }
    });
    expect(passwordless.statusCode).toBe(403);

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);
    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' }
    });
    expect(invited.statusCode).toBe(403);
    expect(store.getIdentityByDisplayName('Public User')).toBeNull();
    expect(store.getIdentityByDisplayName('Invited User')).toBeNull();

    const inviteInfo = await app.inject({ method: 'GET', url: `/auth/invite/${invite.code}` });
    expect(inviteInfo.statusCode).toBe(404);
  });

  it('allows only invite-code credential registration in invite-only mode', async () => {
    const app = await buildApp({ registrationMode: 'invite-only' });
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.json()).toMatchObject({
      mode: 'invite-only',
      registrationEnabled: true,
      inviteRegistrationEnabled: true,
      publicRegistrationEnabled: false
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' }
    });
    expect(passwordless.statusCode).toBe(403);

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);

    const missingCredentials = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Missing Creds', inviteCode: invite.code }
    });
    expect(missingCredentials.statusCode).toBe(400);

    const invalidInvite = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Bad Invite', inviteCode: 'not-real', username: 'badinvite', password: 'password123' }
    });
    expect(invalidInvite.statusCode).toBe(400);

    const inviteInfo = await app.inject({ method: 'GET', url: `/auth/invite/${invite.code}` });
    expect(inviteInfo.statusCode).toBe(200);

    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' }
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).toMatchObject({
      identity: { displayName: 'Invited User' }
    });
    expect(invited.json().token).toEqual(expect.any(String));
    expect(invited.json().refreshToken).toEqual(expect.any(String));
  });

  it('preserves passwordless and invite registration in public mode', async () => {
    const app = await buildApp({ registrationMode: 'public' });
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.json()).toMatchObject({
      mode: 'public',
      registrationEnabled: true,
      inviteRegistrationEnabled: true,
      publicRegistrationEnabled: true
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' }
    });
    expect(passwordless.statusCode).toBe(200);
    expect(passwordless.json()).toMatchObject({
      identity: { displayName: 'Public User' },
      verifyUrl: expect.any(String),
      expiresAt: expect.any(String),
      emailSent: false
    });

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);
    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' }
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json().token).toEqual(expect.any(String));
  });
});
