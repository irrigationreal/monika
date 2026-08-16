import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteOneTimeLinkIssuer } from '../auth/oneTimeLinks';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { hashPassword } from '../utils/auth';
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

  async function buildApp(featureFlagOverrides: Partial<FeatureFlags> = {}, passwordLoginEnabled = true) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags: FeatureFlags = {
      useRedisStreamBus: false,
      enableRateLimiting: false,
      enableAuth: true,
      enableSearch: false,
      registrationMode: 'disabled',
      ...featureFlagOverrides,
    };
    const linkIssuer = new SqliteOneTimeLinkIssuer(db, 'https://example.com');
    const emailService = { sendVerificationEmail: vi.fn(async () => {}) } as any;
    registerAuthRoutes({ app, store, featureFlags, linkIssuer, emailService, access, passwordLoginEnabled });
    await app.ready();
    return app;
  }

  it('persists the authenticated user desktop and mobile quick-reply preferences', async () => {
    const app = await buildApp();
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('human-preference-token', human.id);
    const headers = { authorization: 'Bearer human-preference-token' };

    const initial = await app.inject({ method: 'GET', url: '/auth/me', headers });
    expect(initial.json().identity).toMatchObject({ quickReplyDesktopMode: null, quickReplyMobileMode: null });

    const unauthenticated = await app.inject({
      method: 'PATCH',
      url: '/me/preferences/quick-reply',
      payload: { desktopMode: 'docked', mobileMode: 'inline' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const malformed = await app.inject({
      method: 'PATCH',
      url: '/me/preferences/quick-reply',
      headers,
      payload: { desktopMode: 'floating', mobileMode: 'inline' },
    });
    expect(malformed.statusCode).toBe(400);

    const updated = await app.inject({
      method: 'PATCH',
      url: '/me/preferences/quick-reply',
      headers,
      payload: { desktopMode: 'docked', mobileMode: 'inline' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ok: true, desktopMode: 'docked', mobileMode: 'inline' });

    const refreshed = await app.inject({ method: 'GET', url: '/auth/me', headers });
    expect(refreshed.json().identity).toMatchObject({
      quickReplyDesktopMode: 'docked',
      quickReplyMobileMode: 'inline',
    });

    await app.close();
  });

  it('restricts API key and impersonation token routes to admins', async () => {
    const app = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const guestApiKeys = await app.inject({ method: 'GET', url: '/api-keys' });
    expect(guestApiKeys.statusCode).toBe(401);
    const querySession = await app.inject({ method: 'GET', url: '/api-keys?token=admin-token' });
    expect(querySession.statusCode).toBe(401);

    const humanApiKeys = await app.inject({
      method: 'GET',
      url: '/api-keys',
      headers: { authorization: 'Bearer human-token' },
    });
    expect(humanApiKeys.statusCode).toBe(403);

    const adminApiKeys = await app.inject({
      method: 'GET',
      url: '/api-keys',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminApiKeys.statusCode).toBe(200);

    const humanCreateKey = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: 'Bearer human-token' },
      payload: { label: 'nope' },
    });
    expect(humanCreateKey.statusCode).toBe(403);

    const adminCreateKey = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: 'Bearer admin-token' },
      payload: { label: 'admin key' },
    });
    expect(adminCreateKey.statusCode).toBe(200);
    const created = adminCreateKey.json() as { apiKey: { id: string } };

    const humanDeleteKey = await app.inject({
      method: 'DELETE',
      url: `/api-keys/${created.apiKey.id}`,
      headers: { authorization: 'Bearer human-token' },
    });
    expect(humanDeleteKey.statusCode).toBe(403);

    const adminDeleteKey = await app.inject({
      method: 'DELETE',
      url: `/api-keys/${created.apiKey.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminDeleteKey.statusCode).toBe(200);

    const guestImpersonation = await app.inject({ method: 'GET', url: '/impersonation-tokens' });
    expect(guestImpersonation.statusCode).toBe(401);

    const humanImpersonation = await app.inject({
      method: 'GET',
      url: '/impersonation-tokens',
      headers: { authorization: 'Bearer human-token' },
    });
    expect(humanImpersonation.statusCode).toBe(403);

    const adminImpersonation = await app.inject({
      method: 'POST',
      url: '/impersonation-tokens',
      headers: { authorization: 'Bearer admin-token' },
      payload: { label: 'token', displayName: 'Bot' },
    });
    expect(adminImpersonation.statusCode).toBe(200);
  });

  it('makes both passkey login endpoints honor disabled authentication', async () => {
    const app = await buildApp({ enableAuth: false });
    const options = await app.inject({ method: 'POST', url: '/auth/webauthn/login/options', payload: {} });
    expect(options.statusCode).toBe(403);
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/webauthn/login/verify',
      payload: {
        challengeId: '00000000-0000-4000-8000-000000000000',
        response: { id: 'credential' },
      },
    });
    expect(verify.statusCode).toBe(403);
  });

  it('protects passkey profile routes while keeping usernameless login options public', async () => {
    const app = await buildApp();
    const options = await app.inject({ method: 'POST', url: '/auth/webauthn/login/options', payload: {} });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({ challengeId: expect.any(String), options: { rpId: expect.any(String) } });

    const list = await app.inject({ method: 'GET', url: '/me/webauthn/credentials' });
    expect(list.statusCode).toBe(401);
    const enroll = await app.inject({ method: 'POST', url: '/me/webauthn/register/options', payload: {} });
    expect(enroll.statusCode).toBe(401);
    const remove = await app.inject({ method: 'DELETE', url: '/me/webauthn/credentials/other-users-key' });
    expect(remove.statusCode).toBe(401);
  });

  it('removes passwords only after passkey enrollment and revokes other sessions', async () => {
    const app = await buildApp();
    const passwordHash = await hashPassword('password123');
    const identity = store.createIdentityWithPassword('Password User', 'password-user', passwordHash, 'human');
    store.createAuthSession('current-session', identity.id, 7, 'password');
    store.createAuthSession('other-session', identity.id, 7, 'internal');

    const blocked = await app.inject({
      method: 'DELETE',
      url: '/me/password',
      headers: { authorization: 'Bearer current-session' },
    });
    expect(blocked.statusCode).toBe(409);

    store.createWebAuthnCredential({
      credentialId: 'credential-1',
      identityId: identity.id,
      name: 'Phone',
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
    });
    const unsafeRemoval = await app.inject({
      method: 'DELETE',
      url: '/me/password',
      headers: { authorization: 'Bearer other-session' },
    });
    expect(unsafeRemoval.statusCode).toBe(403);
    expect(store.getIdentity(identity.id)?.password_hash).not.toBeNull();

    const removed = await app.inject({
      method: 'DELETE',
      url: '/me/password',
      headers: { authorization: 'Bearer current-session' },
    });
    expect(removed.statusCode).toBe(200);
    expect(store.getIdentity(identity.id)?.password_hash).toBeNull();
    expect(store.getAuthSession('current-session')).not.toBeNull();
    expect(store.getAuthSession('other-session')).toBeNull();

    const finalPasskey = await app.inject({
      method: 'DELETE',
      url: '/me/webauthn/credentials/credential-1',
      headers: { authorization: 'Bearer current-session' },
    });
    expect(finalPasskey.statusCode).toBe(409);
  });

  it('keeps ordinary login and logout scoped to the current device session', async () => {
    const app = await buildApp();
    const passwordHash = await hashPassword('password123');
    const identity = store.createIdentityWithPassword('Multi Device', 'multi-device', passwordHash, 'human');
    store.createAuthSession('existing-device', identity.id, 7, 'password');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'multi-device', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ identity: { username: 'multi-device' } });
    expect(store.getAuthSession('existing-device')).not.toBeNull();
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeTypeOf('string');
    const currentToken = (cookie as string).match(/cforum_session=([^;]+)/)?.[1];
    expect(currentToken).toBeTruthy();
    expect(store.getAuthSession(currentToken as string)).not.toBeNull();

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie as string } });
    expect(me.json()).toMatchObject({ identity: { username: 'multi-device' } });

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: cookie as string } });
    expect(logout.statusCode).toBe(200);
    expect(store.getAuthSession(currentToken as string)).toBeNull();
    expect(store.getAuthSession('existing-device')).not.toBeNull();
  });

  it('bounds unauthenticated login bodies and credential lengths', async () => {
    const app = await buildApp();
    const oversized = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'user', password: 'x'.repeat(20 * 1024) },
    });
    expect(oversized.statusCode).toBe(413);

    const longUsername = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'u'.repeat(101), password: 'password123' },
    });
    expect(longUsername.statusCode).toBe(400);
  });

  it('reports disabled registration by default and rejects all registration attempts', async () => {
    const app = await buildApp();
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toEqual({
      mode: 'disabled',
      registrationEnabled: false,
      inviteRegistrationEnabled: false,
      publicRegistrationEnabled: false,
      passwordLoginEnabled: true,
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' },
    });
    expect(passwordless.statusCode).toBe(403);

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);
    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' },
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
      publicRegistrationEnabled: false,
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' },
    });
    expect(passwordless.statusCode).toBe(403);

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);

    const missingCredentials = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Missing Creds', inviteCode: invite.code },
    });
    expect(missingCredentials.statusCode).toBe(400);

    const invalidInvite = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Bad Invite', inviteCode: 'not-real', username: 'badinvite', password: 'password123' },
    });
    expect(invalidInvite.statusCode).toBe(400);

    const inviteInfo = await app.inject({ method: 'GET', url: `/auth/invite/${invite.code}` });
    expect(inviteInfo.statusCode).toBe(200);

    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' },
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).toMatchObject({
      identity: { displayName: 'Invited User' },
    });
    expect(invited.json()).not.toHaveProperty('token');
    expect(invited.json()).not.toHaveProperty('refreshToken');
    expect(invited.headers['set-cookie']).toContain('HttpOnly');
  });

  it('reports invite registration unavailable but public verification available when passwords are disabled', async () => {
    const app = await buildApp({ registrationMode: 'public' }, false);
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.json()).toEqual({
      mode: 'public',
      registrationEnabled: true,
      inviteRegistrationEnabled: false,
      publicRegistrationEnabled: true,
      passwordLoginEnabled: false,
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Verification User' },
    });
    expect(passwordless.statusCode).toBe(200);

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);
    const inviteInfo = await app.inject({ method: 'GET', url: `/auth/invite/${invite.code}` });
    expect(inviteInfo.statusCode).toBe(404);
    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited', inviteCode: invite.code, username: 'invited', password: 'password123' },
    });
    expect(invited.statusCode).toBe(403);
  });

  it('reports invite-only registration closed when passwords are disabled', async () => {
    const app = await buildApp({ registrationMode: 'invite-only' }, false);
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.json()).toMatchObject({
      registrationEnabled: false,
      inviteRegistrationEnabled: false,
      publicRegistrationEnabled: false,
      passwordLoginEnabled: false,
    });
  });

  it('preserves passwordless and invite registration in public mode', async () => {
    const app = await buildApp({ registrationMode: 'public' });
    const mode = await app.inject({ method: 'GET', url: '/auth/registration' });
    expect(mode.json()).toMatchObject({
      mode: 'public',
      registrationEnabled: true,
      inviteRegistrationEnabled: true,
      publicRegistrationEnabled: true,
    });

    const passwordless = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Public User' },
    });
    expect(passwordless.statusCode).toBe(200);
    expect(passwordless.json()).toMatchObject({
      identity: { displayName: 'Public User' },
      verifyUrl: expect.any(String),
      expiresAt: expect.any(String),
      emailSent: false,
    });

    const admin = store.createIdentity('Admin', 'admin');
    const invite = store.createInvite(admin.id, 1, null);
    const invited = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { displayName: 'Invited User', inviteCode: invite.code, username: 'invited', password: 'password123' },
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).not.toHaveProperty('token');
    expect(invited.headers['set-cookie']).toContain('SameSite=Lax');
  });
});
