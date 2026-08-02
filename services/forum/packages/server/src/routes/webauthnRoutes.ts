import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import {
  EmptyJsonRequestSchema,
  WebAuthnRegistrationVerifyRequestSchema,
  WebAuthnVerifyRequestSchema,
} from '@irrigationreal/codex-forum-contracts';

import { issueBrowserSession } from '../auth/browserSession';
import { mapIdentityRowToDomain, mapWebAuthnCredentialRowToDomain } from '../mappers/db';
import { mapIdentityToDto, mapWebAuthnCredentialToDto } from '../mappers/dto';
import { WEBAUTHN_ORIGIN, WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME } from '../runtimeConfig';
import { parseBody } from '../utils/validation';

import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';

import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';

const RECENT_AUTH_MS = 10 * 60_000;
const WEBAUTHN_BODY_LIMIT = 2 * 1024 * 1024;

function requireRecentSession(
  app: FastifyInstance,
  store: ForumStore,
  access: AccessHelpers,
  request: Parameters<AccessHelpers['getCurrentUser']>[0]
) {
  const auth = access.requireScope(access.getCurrentUser(request), 'write');
  const recent =
    auth.authType === 'session' &&
    auth.authenticatedAt &&
    Date.now() - Date.parse(auth.authenticatedAt) <= RECENT_AUTH_MS;
  const identity = store.getIdentity(auth.identityId);
  const canBootstrapFirstPasskey =
    auth.authMethod === 'verification' &&
    identity !== null &&
    !identity.password_hash &&
    store.countWebAuthnCredentials(identity.id) === 0;
  if (!recent || (!canBootstrapFirstPasskey && auth.authMethod !== 'password' && auth.authMethod !== 'webauthn')) {
    throw app.httpErrors.forbidden('Recent password or passkey authentication required');
  }
  return auth;
}

export function registerWebAuthnRoutes({
  app,
  store,
  access,
  authEnabled,
  passwordLoginEnabled,
  rateLimitingEnabled,
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
  authEnabled: boolean;
  passwordLoginEnabled: boolean;
  rateLimitingEnabled: boolean;
}): void {
  const requireAuthEnabled = (): void => {
    if (!authEnabled) throw app.httpErrors.forbidden('Authentication is disabled');
  };

  app.post(
    '/auth/webauthn/login/options',
    {
      bodyLimit: 1024,
      config: { rateLimit: rateLimitingEnabled ? { max: 30, timeWindow: '1 minute' } : false },
    },
    async (request) => {
      requireAuthEnabled();
      parseBody(app, EmptyJsonRequestSchema, request.body);
      const options = await generateAuthenticationOptions({
        rpID: WEBAUTHN_RP_ID,
        userVerification: 'required',
        timeout: 60_000,
      });
      const record = store.createWebAuthnChallenge({
        challenge: options.challenge,
        ceremony: 'authentication',
        identityId: null,
      });
      return { challengeId: record.id, options };
    }
  );

  app.post(
    '/auth/webauthn/login/verify',
    {
      bodyLimit: WEBAUTHN_BODY_LIMIT,
      config: { rateLimit: rateLimitingEnabled ? { max: 10, timeWindow: '1 minute' } : false },
    },
    async (request, reply) => {
      requireAuthEnabled();
      const body = parseBody(app, WebAuthnVerifyRequestSchema, request.body);
      const challenge = store.consumeWebAuthnChallenge(body.challengeId, 'authentication', null);
      if (!challenge) throw app.httpErrors.badRequest('Invalid or expired authentication challenge');
      const response = body.response as unknown as AuthenticationResponseJSON;
      const credentialRow = store.getWebAuthnCredential(response.id);
      if (!credentialRow) throw app.httpErrors.unauthorized('Unknown passkey');
      const credential = mapWebAuthnCredentialRowToDomain(credentialRow);
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: WEBAUTHN_ORIGIN,
          expectedRPID: WEBAUTHN_RP_ID,
          requireUserVerification: true,
          credential: {
            id: credential.id,
            publicKey: new Uint8Array(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports as AuthenticatorTransportFuture[],
          },
        });
      } catch {
        throw app.httpErrors.unauthorized('Passkey verification failed');
      }
      if (!verification.verified || !verification.authenticationInfo.userVerified) {
        throw app.httpErrors.unauthorized('Passkey verification failed');
      }
      store.updateWebAuthnCredentialUsage(
        credential.id,
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp
      );
      const identity = store.getIdentity(credential.identityId);
      if (!identity) throw app.httpErrors.unauthorized('Passkey account no longer exists');
      issueBrowserSession(reply, store, identity.id, 'webauthn');
      return {
        identity: {
          ...mapIdentityToDto(mapIdentityRowToDomain(identity)),
          username: identity.username,
          hasPassword: Boolean(identity.password_hash),
        },
      };
    }
  );

  app.get('/me/webauthn/credentials', (request) => {
    const auth = access.requireScope(access.getCurrentUser(request), 'read');
    return {
      items: store
        .listWebAuthnCredentials(auth.identityId)
        .map(mapWebAuthnCredentialRowToDomain)
        .map(mapWebAuthnCredentialToDto),
    };
  });

  app.post(
    '/me/webauthn/register/options',
    {
      bodyLimit: 1024,
      config: { rateLimit: rateLimitingEnabled ? { max: 10, timeWindow: '1 minute' } : false },
    },
    async (request) => {
      const auth = requireRecentSession(app, store, access, request);
      parseBody(app, EmptyJsonRequestSchema, request.body);
      const identity = store.getIdentity(auth.identityId);
      if (!identity) throw app.httpErrors.notFound('User not found');
      const credentials = store.listWebAuthnCredentials(identity.id).map(mapWebAuthnCredentialRowToDomain);
      const options = await generateRegistrationOptions({
        rpName: WEBAUTHN_RP_NAME,
        rpID: WEBAUTHN_RP_ID,
        userID: Buffer.from(identity.id, 'utf8'),
        userName: identity.username ?? identity.display_name,
        userDisplayName: identity.display_name,
        attestationType: 'none',
        timeout: 60_000,
        excludeCredentials: credentials.map((item) => ({
          id: item.id,
          transports: item.transports as AuthenticatorTransportFuture[],
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const challenge = store.createWebAuthnChallenge({
        challenge: options.challenge,
        ceremony: 'registration',
        identityId: identity.id,
      });
      return { challengeId: challenge.id, options };
    }
  );

  app.post(
    '/me/webauthn/register/verify',
    {
      bodyLimit: WEBAUTHN_BODY_LIMIT,
      config: { rateLimit: rateLimitingEnabled ? { max: 10, timeWindow: '1 minute' } : false },
    },
    async (request) => {
      const auth = requireRecentSession(app, store, access, request);
      const body = parseBody(app, WebAuthnRegistrationVerifyRequestSchema, request.body);
      const challenge = store.consumeWebAuthnChallenge(body.challengeId, 'registration', auth.identityId);
      if (!challenge) throw app.httpErrors.badRequest('Invalid or expired registration challenge');
      const response = body.response as unknown as RegistrationResponseJSON;
      if (store.getWebAuthnCredential(response.id)) throw app.httpErrors.conflict('Passkey is already registered');
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: WEBAUTHN_ORIGIN,
          expectedRPID: WEBAUTHN_RP_ID,
          requireUserVerification: true,
        });
      } catch {
        throw app.httpErrors.badRequest('Passkey registration failed');
      }
      if (!verification.verified || !verification.registrationInfo.userVerified) {
        throw app.httpErrors.badRequest('Passkey registration failed');
      }
      const info = verification.registrationInfo;
      const row = store.createWebAuthnCredential({
        credentialId: info.credential.id,
        identityId: auth.identityId,
        name: body.name.trim(),
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      });
      store.deleteAuthSessionsForIdentity(auth.identityId, auth.tokenId);
      return mapWebAuthnCredentialToDto(mapWebAuthnCredentialRowToDomain(row));
    }
  );

  app.delete('/me/webauthn/credentials/:credentialId', (request) => {
    const auth = requireRecentSession(app, store, access, request);
    const { credentialId } = request.params as { credentialId: string };
    const identity = store.getIdentity(auth.identityId);
    if (!identity) throw app.httpErrors.notFound('User not found');
    const credentialRow = store.getWebAuthnCredential(credentialId);
    const credential = credentialRow ? mapWebAuthnCredentialRowToDomain(credentialRow) : null;
    if (credential?.identityId !== identity.id) throw app.httpErrors.notFound('Passkey not found');
    const hasUsablePassword = passwordLoginEnabled && Boolean(identity.password_hash);
    if (!hasUsablePassword && store.countWebAuthnCredentials(identity.id) <= 1) {
      throw app.httpErrors.conflict('Cannot remove the final passkey without another usable login method');
    }
    store.deleteWebAuthnCredential(identity.id, credentialId);
    store.deleteAuthSessionsForIdentity(identity.id, auth.tokenId);
    return { ok: true };
  });
}
