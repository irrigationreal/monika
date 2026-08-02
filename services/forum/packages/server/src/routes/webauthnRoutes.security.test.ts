import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerWebAuthnRoutes } from './webauthnRoutes';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'server-challenge', rpId: 'localhost' })),
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'registration-challenge', rp: { id: 'localhost' } })),
  verifyAuthenticationResponse: vi.fn(
    async ({
      response,
      expectedChallenge,
    }: {
      response: { challenge?: string; uv?: boolean };
      expectedChallenge: string;
    }) => {
      if (response.challenge !== expectedChallenge) throw new Error('wrong challenge');
      return {
        verified: response.uv !== false,
        authenticationInfo: {
          userVerified: response.uv !== false,
          newCounter: 1,
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    }
  ),
  verifyRegistrationResponse: vi.fn(async ({ response }: { response: { succeed?: boolean } }) =>
    response.succeed
      ? {
          verified: true,
          registrationInfo: {
            userVerified: true,
            credential: {
              id: 'new-credential',
              publicKey: new Uint8Array([1, 2, 3]),
              counter: 0,
              transports: ['internal'],
            },
            credentialDeviceType: 'multiDevice',
            credentialBackedUp: true,
          },
        }
      : { verified: false }
  ),
}));

describe('WebAuthn route ceremony controls', () => {
  let db: Database.Database;
  let store: ForumStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    app = Fastify();
    await app.register(sensible);
    registerWebAuthnRoutes({
      app,
      store,
      access: createAccessHelpers(app, store),
      authEnabled: true,
      passwordLoginEnabled: true,
      rateLimitingEnabled: false,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('accepts the explicit empty JSON options contract over a real HTTP connection', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/auth/webauthn/login/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      challengeId: expect.any(String),
      options: { rpId: 'localhost' },
    });
  });

  it('consumes wrong challenges and rejects reuse and missing user verification', async () => {
    const identity = store.createIdentity('Passkey User', 'human');
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

    const wrongOptions = await app.inject({ method: 'POST', url: '/auth/webauthn/login/options', payload: {} });
    const wrongId = wrongOptions.json().challengeId as string;
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/webauthn/login/verify',
      payload: { challengeId: wrongId, response: { id: 'credential-1', challenge: 'attacker-challenge', uv: true } },
    });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    const reused = await app.inject({
      method: 'POST',
      url: '/auth/webauthn/login/verify',
      payload: { challengeId: wrongId, response: { id: 'credential-1', challenge: 'server-challenge', uv: true } },
    });
    expect(reused.statusCode).toBe(400);

    const uvOptions = await app.inject({ method: 'POST', url: '/auth/webauthn/login/options', payload: {} });
    const noUv = await app.inject({
      method: 'POST',
      url: '/auth/webauthn/login/verify',
      payload: {
        challengeId: uvOptions.json().challengeId,
        response: { id: 'credential-1', challenge: 'server-challenge', uv: false },
      },
    });
    expect(noUv.statusCode).toBe(401);
  });

  it('allows a recent verification session to bootstrap only its first passkey', async () => {
    const identity = store.createIdentity('Verified User', 'human');
    store.createAuthSession('verification-session', identity.id, 7, 'verification');
    store.createAuthSession('other-session', identity.id, 7, 'internal');

    const options = await app.inject({
      method: 'POST',
      url: '/me/webauthn/register/options',
      headers: { authorization: 'Bearer verification-session' },
      payload: {},
    });
    expect(options.statusCode).toBe(200);

    const registered = await app.inject({
      method: 'POST',
      url: '/me/webauthn/register/verify',
      headers: { authorization: 'Bearer verification-session' },
      payload: {
        challengeId: options.json().challengeId,
        name: 'Security key',
        response: { id: 'new-credential', succeed: true },
      },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toMatchObject({ id: 'new-credential', name: 'Security key' });
    expect(store.getAuthSession('verification-session')).not.toBeNull();
    expect(store.getAuthSession('other-session')).toBeNull();

    const second = await app.inject({
      method: 'POST',
      url: '/me/webauthn/register/options',
      headers: { authorization: 'Bearer verification-session' },
      payload: {},
    });
    expect(second.statusCode).toBe(403);
  });

  it('never removes the final passkey when password login is globally disabled', async () => {
    await app.close();
    app = Fastify();
    await app.register(sensible);
    registerWebAuthnRoutes({
      app,
      store,
      access: createAccessHelpers(app, store),
      authEnabled: true,
      passwordLoginEnabled: false,
      rateLimitingEnabled: false,
    });

    const identity = store.createIdentityWithPassword('Locked User', 'locked-user', 'legacy-hash', 'human');
    store.createAuthSession('password-session', identity.id, 7, 'password');
    store.createWebAuthnCredential({
      credentialId: 'final-credential',
      identityId: identity.id,
      name: 'Only key',
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: '/me/webauthn/credentials/final-credential',
      headers: { authorization: 'Bearer password-session' },
    });
    expect(removed.statusCode).toBe(409);
    expect(store.getWebAuthnCredential('final-credential')).not.toBeNull();
  });

  it('binds registration challenges to the authenticated account and rejects expiry', async () => {
    const first = store.createIdentity('First', 'human');
    const second = store.createIdentity('Second', 'human');
    store.createAuthSession('second-session', second.id, 7, 'password');
    const crossAccount = store.createWebAuthnChallenge({
      challenge: 'registration-challenge',
      ceremony: 'registration',
      identityId: first.id,
    });
    const crossed = await app.inject({
      method: 'POST',
      url: '/me/webauthn/register/verify',
      headers: { authorization: 'Bearer second-session' },
      payload: { challengeId: crossAccount.id, name: 'Not mine', response: { id: 'credential-x' } },
    });
    expect(crossed.statusCode).toBe(400);

    const expired = store.createWebAuthnChallenge({
      challenge: 'registration-challenge',
      ceremony: 'registration',
      identityId: second.id,
      ttlMs: -1,
    });
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/me/webauthn/register/verify',
      headers: { authorization: 'Bearer second-session' },
      payload: { challengeId: expired.id, name: 'Expired', response: { id: 'credential-y' } },
    });
    expect(expiredResponse.statusCode).toBe(400);
  });

  it('bounds outstanding registration challenges per identity', async () => {
    const identity = store.createIdentityWithPassword('Bounded', 'bounded', 'hash', 'human');
    store.createAuthSession('bounded-session', identity.id, 7, 'password');

    for (let index = 0; index < 25; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/me/webauthn/register/options',
        headers: { authorization: 'Bearer bounded-session' },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }

    const row = db
      .prepare("select count(*) as count from webauthn_challenges where identity_id = ? and ceremony = 'registration'")
      .get(identity.id) as { count: number };
    expect(row.count).toBe(20);
  });
});
