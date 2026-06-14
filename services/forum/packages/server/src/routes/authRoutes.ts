import type { FastifyInstance } from 'fastify';
import type { FeatureFlags } from '../config';
import type { SqliteOneTimeLinkIssuer } from '../auth/oneTimeLinks';
import type { IEmailService } from '../services/emailService';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';
import { registerOidcRoutes } from '../oidc/routes';
import {
  ChangePasswordRequestSchema,
  CreateApiKeyRequestSchema,
  CreateImpersonationTokenRequestSchema,
  CreateInviteRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  UpdatePrivateEmailRequestSchema
} from '@irrigationreal/codex-forum-contracts';
import {
  API_KEY_PREFIX,
  IMPERSONATION_PREFIX,
  generateApiToken,
  generateToken,
  hashPassword,
  hashToken,
  normalizePrivateEmail,
  parseScopes,
  verifyPassword
} from '../utils/auth';
import { parseBody } from '../utils/validation';
import { mapIdentityRowToDomain, mapInviteRowToDomain } from '../mappers/db';
import { mapIdentityToDto, mapInviteToDto } from '../mappers/dto';

export function registerAuthRoutes({
  app,
  store,
  featureFlags,
  linkIssuer,
  emailService,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  featureFlags: FeatureFlags;
  linkIssuer: SqliteOneTimeLinkIssuer;
  emailService: IEmailService;
  access: AccessHelpers;
}): void {
  const { getCurrentUser, requireAdmin, requireScope } = access;

  // OIDC endpoints (optional; enabled via env)
  registerOidcRoutes({ app, store, access });

  // Clean up expired sessions on startup and periodically
  store.cleanupExpiredAuthSessions();
  store.cleanupExpiredRefreshSessions();
  setInterval(() => {
    store.cleanupExpiredAuthSessions();
    store.cleanupExpiredRefreshSessions();
  }, 60 * 60 * 1000); // Every hour

  app.post('/auth/login', async (request) => {
    if (!featureFlags.enableAuth) {
      return { token: null, message: 'Auth disabled' };
    }
    const body = parseBody(app, LoginRequestSchema, request.body);

    // Look up user by username
    const identity = store.getIdentityByUsername(body.username);
    if (!identity || !identity.password_hash) {
      throw app.httpErrors.unauthorized('Invalid credentials');
    }

    // Verify password
    const valid = await verifyPassword(body.password, identity.password_hash);
    if (!valid) {
      throw app.httpErrors.unauthorized('Invalid credentials');
    }

    const token = generateToken('cforum_access');
    const refreshToken = generateToken('cforum_refresh');
    store.createAuthSession(token, identity.id);
    store.createRefreshSession(refreshToken, identity.id);
    const identityDto = mapIdentityToDto(mapIdentityRowToDomain(identity));
    return {
      token,
      refreshToken,
      identity: identityDto
    };
  });

  app.post('/auth/logout', async (request) => {
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      store.deleteAuthSession(token);
    }
    const refreshHeader = request.headers['x-refresh-token'];
    const refreshValue = Array.isArray(refreshHeader) ? refreshHeader[0] : refreshHeader;
    if (refreshValue) {
      store.deleteRefreshSession(refreshValue);
    }
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    if (!featureFlags.enableAuth) {
      return { identity: null };
    }
    const auth = getCurrentUser(request);
    if (!auth) {
      return { identity: null };
    }
    const identity = store.getIdentity(auth.identityId);
    if (!identity) {
      return { identity: null };
    }
    const identityDto = mapIdentityToDto(mapIdentityRowToDomain(identity));
    return {
      identity: {
        ...identityDto,
        hasPrivateEmail: Boolean(identity.private_email)
      }
    };
  });

  app.post('/auth/refresh', async (request) => {
    if (!featureFlags.enableAuth) {
      return { token: null, refreshToken: null, message: 'Auth disabled' };
    }
    const refreshHeader = request.headers['x-refresh-token'];
    const refreshValue = Array.isArray(refreshHeader) ? refreshHeader[0] : refreshHeader;
    if (!refreshValue) {
      throw app.httpErrors.unauthorized('Refresh token required');
    }
    const session = store.getRefreshSession(refreshValue);
    if (!session) {
      throw app.httpErrors.unauthorized('Refresh token expired');
    }
    const identity = store.getIdentity(session.identity_id);
    if (!identity) {
      store.deleteRefreshSession(refreshValue);
      throw app.httpErrors.unauthorized('Refresh token invalid');
    }
    store.deleteRefreshSession(refreshValue);
    const newAccessToken = generateToken('cforum_access');
    const newRefreshToken = generateToken('cforum_refresh');
    store.createAuthSession(newAccessToken, identity.id);
    store.createRefreshSession(newRefreshToken, identity.id);
    return { token: newAccessToken, refreshToken: newRefreshToken };
  });

  app.get('/api-keys', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot manage API keys');
    }
    return { items: store.listApiKeys(auth.identityId) };
  });

  app.post('/api-keys', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot create API keys');
    }
    const body = parseBody(app, CreateApiKeyRequestSchema, request.body);
    const expiresAt = body.expiresAt ?? null;
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw app.httpErrors.badRequest('expiresAt must be a valid ISO timestamp');
    }
    const token = generateApiToken(API_KEY_PREFIX);
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const scopes = parseScopes(body.scopes);
    const apiKey = store.createApiKey({
      identityId: auth.identityId,
      label: body.label.trim(),
      tokenHash,
      tokenPrefix,
      scopes,
      expiresAt
    });
    return { apiKey, token };
  });

  app.delete('/api-keys/:id', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot revoke API keys');
    }
    const { id } = request.params as { id: string };
    const ok = store.revokeApiKey(auth.identityId, id);
    if (!ok) {
      throw app.httpErrors.notFound('API key not found');
    }
    return { ok: true };
  });

  app.get('/impersonation-tokens', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot list tokens');
    }
    return { items: store.listImpersonationTokens(auth.identityId) };
  });

  app.post('/impersonation-tokens', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot create tokens');
    }
    const body = parseBody(app, CreateImpersonationTokenRequestSchema, request.body);
    const expiresAt = body.expiresAt ?? null;
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw app.httpErrors.badRequest('expiresAt must be a valid ISO timestamp');
    }
    let impersonatedIdentityId = body.impersonatedIdentityId ?? null;
    if (impersonatedIdentityId) {
      const existing = store.getIdentity(impersonatedIdentityId);
      if (!existing) {
        throw app.httpErrors.badRequest('impersonatedIdentityId not found');
      }
    } else {
      if (!body.displayName?.trim()) {
        throw app.httpErrors.badRequest('displayName is required when creating a new identity');
      }
      const identity = store.createImpersonatedIdentity(auth.identityId, body.displayName.trim(), body.avatarUrl ?? null);
      impersonatedIdentityId = identity.id;
    }
    const token = generateApiToken(IMPERSONATION_PREFIX);
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const scopes = parseScopes(body.scopes);
    const impersonationToken = store.createImpersonationToken({
      ownerIdentityId: auth.identityId,
      impersonatedIdentityId,
      label: body.label.trim(),
      tokenHash,
      tokenPrefix,
      scopes,
      expiresAt
    });
    return { impersonationToken, token };
  });

  app.delete('/impersonation-tokens/:id', async (request) => {
    const auth = requireAdmin(request);
    if (auth.authType === 'impersonation') {
      throw app.httpErrors.forbidden('Impersonation tokens cannot revoke tokens');
    }
    const { id } = request.params as { id: string };
    const ok = store.revokeImpersonationToken(auth.identityId, id);
    if (!ok) {
      throw app.httpErrors.notFound('Impersonation token not found');
    }
    return { ok: true };
  });

  // Private (robot-only) email address management.
  //
  // This endpoint intentionally does NOT return the stored email address back to the web UI.
  // It only returns a boolean "hasPrivateEmail" so the user can tell whether something is set.
  app.patch('/me/private-email', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const body = parseBody(app, UpdatePrivateEmailRequestSchema, request.body);

    const normalized = body.emailAddress === null ? null : normalizePrivateEmail(body.emailAddress);
    if (body.emailAddress !== null && normalized === null) {
      throw app.httpErrors.badRequest('Invalid email address');
    }

    store.setIdentityPrivateEmail(user.identityId, normalized);

    return { ok: true, hasPrivateEmail: Boolean(normalized) };
  });

  // Password change (self-service)
  app.post('/me/password', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const body = parseBody(app, ChangePasswordRequestSchema, request.body);

    const identity = store.getIdentity(user.identityId);
    if (!identity) {
      throw app.httpErrors.notFound('User not found');
    }
    if (!identity.username || !identity.password_hash) {
      throw app.httpErrors.badRequest('This account does not support password login');
    }

    const valid = await verifyPassword(body.currentPassword, identity.password_hash);
    if (!valid) {
      throw app.httpErrors.unauthorized('Invalid current password');
    }

    if (body.newPassword.length < 8) {
      throw app.httpErrors.badRequest('Password must be at least 8 characters');
    }

    const passwordHash = await hashPassword(body.newPassword);
    store.setIdentityPassword(identity.id, identity.username, passwordHash);

    return { ok: true };
  });

  // Registration endpoints
  app.post(
    '/auth/register',
    {
      config: {
        rateLimit: featureFlags.enableRateLimiting ? { max: 5, timeWindow: '1 hour' } : false
      }
    },
    async (request) => {
      if (!featureFlags.enableAuth) {
        throw app.httpErrors.forbidden('Registration disabled');
      }
      const body = parseBody(app, RegisterRequestSchema, request.body);

      // Check if displayName is taken
      const existingDisplay = store.getIdentityByDisplayName(body.displayName);
      if (existingDisplay) {
        throw app.httpErrors.conflict('Display name already taken');
      }

      // If username provided, check if taken
      if (body.username) {
        const existingUsername = store.getIdentityByUsername(body.username);
        if (existingUsername) {
          throw app.httpErrors.conflict('Username already taken');
        }
      }

      // If invite code + username + password provided, create account directly
      if (body.inviteCode && body.username && body.password) {
        // Validate invite
        const inviteResult = store.useInvite(body.inviteCode);
        if (!inviteResult.ok) {
          throw app.httpErrors.badRequest(inviteResult.error ?? 'Invalid invite code');
        }

        // Validate password strength
        if (body.password.length < 8) {
          throw app.httpErrors.badRequest('Password must be at least 8 characters');
        }

        // Create identity with credentials
        const passwordHash = await hashPassword(body.password);
        const identity = store.createIdentityWithPassword(
          body.displayName,
          body.username,
          passwordHash,
          'human'
        );

        // Create session token and log them in immediately
        const sessionToken = generateToken('cforum_access');
        const refreshToken = generateToken('cforum_refresh');
        store.createAuthSession(sessionToken, identity.id);
        store.createRefreshSession(refreshToken, identity.id);
        const identityDto = mapIdentityToDto(mapIdentityRowToDomain(identity));

        return {
          token: sessionToken,
          refreshToken,
          identity: identityDto
        };
      }

      // Invite code present but missing credentials
      if (body.inviteCode) {
        throw app.httpErrors.badRequest('Username and password are required for invite registration');
      }

      // Create identity (without password)
      const identity = store.createIdentity(body.displayName, 'human');

      // Issue one-time login link
      const link = await linkIssuer.issue(identity.id);
      const identityDto = mapIdentityToDto(mapIdentityRowToDomain(identity));

      // Send verification email if email is provided
      if (body.email) {
        await emailService.sendVerificationEmail(body.email, link.url, body.displayName);
      }

      return {
        identity: identityDto,
        verifyUrl: link.url,
        expiresAt: link.expiresAt,
        emailSent: !!body.email
      };
    }
  );

  app.get('/auth/verify/:token', async (request) => {
    const { token } = request.params as { token: string };
    const result = await linkIssuer.verify(token);

    if (!result.ok || !result.userId) {
      throw app.httpErrors.badRequest('Invalid or expired verification link');
    }

    const identity = store.getIdentity(result.userId);
    if (!identity) {
      throw app.httpErrors.notFound('User not found');
    }

    // Create session token
    const sessionToken = generateToken('cforum_access');
    const refreshToken = generateToken('cforum_refresh');
    store.createAuthSession(sessionToken, identity.id);
    store.createRefreshSession(refreshToken, identity.id);
    const identityDto = mapIdentityToDto(mapIdentityRowToDomain(identity));

    return {
      token: sessionToken,
      refreshToken,
      identity: identityDto
    };
  });

  // Invite endpoints (admin only)
  app.post('/invites', async (request) => {
    const user = requireAdmin(request);
    const body = parseBody(app, CreateInviteRequestSchema, request.body);

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const invite = store.createInvite(user.identityId, body.maxUses ?? 1, expiresAt);

    return mapInviteToDto(mapInviteRowToDomain(invite));
  });

  app.get('/invites', async (request) => {
    requireAdmin(request);
    const page = Number((request.query as { page?: string }).page ?? 1);
    const pageSize = Number((request.query as { pageSize?: string }).pageSize ?? 50);

    const invites = store.listInvites(page, pageSize);
    return {
      page,
      pageSize,
      total: invites.length,
      items: invites.map((invite) => mapInviteToDto(mapInviteRowToDomain(invite)))
    };
  });

  app.delete('/invites/:inviteId', async (request) => {
    requireAdmin(request);
    const { inviteId } = request.params as { inviteId: string };

    const invite = store.getInvite(inviteId);
    if (!invite) {
      throw app.httpErrors.notFound('Invite not found');
    }

    store.deleteInvite(inviteId);
    return { ok: true };
  });

  app.get('/auth/invite/:code', async (request) => {
    const { code } = request.params as { code: string };
    const invite = store.getInviteByCode(code);

    if (!invite) {
      throw app.httpErrors.notFound('Invite not found');
    }

    // Check if expired
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      throw app.httpErrors.gone('Invite has expired');
    }

    // Check if exhausted
    if (invite.uses >= invite.max_uses) {
      throw app.httpErrors.gone('Invite has been fully used');
    }

    return {
      code: invite.code,
      valid: true,
      remainingUses: invite.max_uses - invite.uses,
      expiresAt: invite.expires_at
    };
  });
}
