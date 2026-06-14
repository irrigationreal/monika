import type { FastifyInstance } from 'fastify';
import type { IdentityRow, TopicRow as DbTopicRow, PostRow as DbPostRow } from '../db';
import type { ForumStore } from '../store';
import { type AuthContext, type AuthScope, hashToken, isTokenExpired, parseScopes } from './auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HeadersRequest = { headers: Record<string, unknown>; query?: unknown };

export function createAccessHelpers(app: FastifyInstance, store: ForumStore): {
  getCurrentUser: (request: HeadersRequest) => AuthContext | null;
  requireScope: (context: AuthContext | null, scope: AuthScope) => AuthContext;
  requireAdmin: (request: HeadersRequest) => AuthContext;
  requireModerator: (request: HeadersRequest, tenantId?: string | null) => AuthContext;
  getIdentityFromRequest: (request: HeadersRequest) => IdentityRow | null;
  canViewForum: (forum: { visibility: string; tenant_id: string | null }, identity: IdentityRow | null) => boolean;
  canViewTopic: (_topic: { forum_id: string }, forum: { visibility: string; tenant_id: string | null }, identity: IdentityRow | null) => boolean;
  canCreateTopic: (forum: { visibility: string; tenant_id: string | null }, identity: IdentityRow | null) => boolean;
  canPostTopic: (_topic: { forum_id: string }, forum: { visibility: string; tenant_id: string | null }, identity: IdentityRow | null) => boolean;
  requireForumVisible: (forum: { visibility: string; tenant_id: string | null }, identity: IdentityRow | null) => void;
  requireTopicVisible: (topicId: string, request: HeadersRequest) => DbTopicRow;
  requirePostVisible: (postId: string, request: HeadersRequest) => DbPostRow;
} {
  function hasScope(context: AuthContext, scope: AuthScope): boolean {
    if (context.scopes === null) return true;
    const scopes = context.scopes;
    if (scopes.includes('*')) return true;
    if (scopes.includes('admin')) return true;
    if (scope === 'read') {
      return scopes.includes('read') || scopes.includes('write');
    }
    return scopes.includes(scope);
  }

  function requireScope(context: AuthContext | null, scope: AuthScope): AuthContext {
    if (!context) {
      throw app.httpErrors.unauthorized('Authentication required');
    }
    if (!hasScope(context, scope)) {
      throw app.httpErrors.forbidden('Insufficient scope');
    }
    return context;
  }

  function resolveAuthContext(request: HeadersRequest): AuthContext | null {
    const authHeader = request.headers['authorization'] as string | string[] | undefined;
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const bearerToken = authValue?.startsWith('Bearer ') ? authValue.slice(7) : null;
    const apiKeyHeader = request.headers['x-api-key'];
    const apiKeyToken = typeof apiKeyHeader === 'string' ? apiKeyHeader : null;
    // Support token via query param for SSE endpoints (EventSource can't send headers)
    const queryObj = request.query as Record<string, unknown> | undefined;
    const queryToken = typeof queryObj?.['token'] === 'string' ? queryObj['token'] : null;

    // Check bearer token or query token for session auth
    const sessionToken = bearerToken ?? queryToken;
    if (sessionToken) {
      const session = store.getAuthSession(sessionToken);
      if (session) {
        return { identityId: session.identity_id, authType: 'session', scopes: null, tokenId: session.token };
      }
    }

    const tokensToCheck = [bearerToken, apiKeyToken, queryToken].filter((token): token is string => Boolean(token));
    for (const rawToken of tokensToCheck) {
      const tokenHash = hashToken(rawToken);
      const apiKey = store.getApiKeyByHash(tokenHash);
      if (apiKey && !apiKey.revoked_at && !isTokenExpired(apiKey.expires_at)) {
        store.touchApiKeyLastUsed(apiKey.id);
        return {
          identityId: apiKey.identity_id,
          authType: 'apiKey',
          scopes: parseScopes(JSON.parse(apiKey.scopes_json)),
          tokenId: apiKey.id
        };
      }
      const impersonation = store.getImpersonationTokenByHash(tokenHash);
      if (impersonation && !impersonation.revoked_at && !isTokenExpired(impersonation.expires_at)) {
        store.touchImpersonationTokenLastUsed(impersonation.id);
        return {
          identityId: impersonation.impersonated_identity_id,
          ownerIdentityId: impersonation.owner_identity_id,
          authType: 'impersonation',
          scopes: parseScopes(JSON.parse(impersonation.scopes_json)),
          tokenId: impersonation.id
        };
      }
    }

    return null;
  }

  function getCurrentUser(request: HeadersRequest): AuthContext | null {
    return resolveAuthContext(request);
  }

  function requireAdmin(request: HeadersRequest): AuthContext {
    const user = requireScope(getCurrentUser(request), 'admin');
    const identity = store.getIdentity(user.identityId);
    if (!identity || identity.kind !== 'admin') {
      throw app.httpErrors.forbidden('Admin access required');
    }
    return user;
  }

  function requireModerator(request: HeadersRequest, tenantId?: string | null): AuthContext {
    const user = requireScope(getCurrentUser(request), 'write');
    const identity = store.getIdentity(user.identityId);
    if (identity?.kind === 'admin') {
      return user;
    }
    const allowed =
      store.hasPermission(user.identityId, 'mod.sticky', tenantId) ||
      store.hasPermission(user.identityId, 'mod.all', tenantId) ||
      store.hasPermission(user.identityId, 'admin.write', tenantId) ||
      store.hasPermission(user.identityId, 'admin.all', tenantId) ||
      store.hasPermission(user.identityId, '*', tenantId);
    if (!allowed) {
      throw app.httpErrors.forbidden('Moderator access required');
    }
    return user;
  }

  function getIdentityFromRequest(request: HeadersRequest): IdentityRow | null {
    const user = getCurrentUser(request);
    if (!user) {
      return null;
    }
    return store.getIdentity(user.identityId);
  }

  function canViewForum(
    forum: { visibility: string; tenant_id: string | null },
    identity: ReturnType<ForumStore['getIdentity']>
  ): boolean {
    if (!forum.visibility || forum.visibility === 'public') {
      return true;
    }
    if (forum.visibility === 'members') {
      return Boolean(identity);
    }
    if (forum.visibility === 'admin') {
      if (!identity) return false;
      if (identity.kind === 'admin') return true;
      return (
        store.hasPermission(identity.id, 'admin.all', identity.tenant_id) ||
        store.hasPermission(identity.id, 'admin.read', identity.tenant_id) ||
        store.hasPermission(identity.id, '*', identity.tenant_id)
      );
    }
    return true;
  }

  function canViewTopic(
    _topic: { forum_id: string },
    forum: { visibility: string; tenant_id: string | null },
    identity: ReturnType<ForumStore['getIdentity']>
  ): boolean {
    return canViewForum(forum, identity);
  }

  function canCreateTopic(
    forum: { visibility: string; tenant_id: string | null },
    identity: ReturnType<ForumStore['getIdentity']>
  ): boolean {
    if (!identity) return false;
    return canViewForum(forum, identity);
  }

  function canPostTopic(
    _topic: { forum_id: string },
    forum: { visibility: string; tenant_id: string | null },
    identity: ReturnType<ForumStore['getIdentity']>
  ): boolean {
    if (!identity) return false;
    return canViewForum(forum, identity);
  }

  function requireForumVisible(
    forum: { visibility: string; tenant_id: string | null },
    identity: ReturnType<ForumStore['getIdentity']>
  ): void {
    if (!canViewForum(forum, identity)) {
      throw app.httpErrors.notFound('Forum not found');
    }
  }

  function requireTopicVisible(topicId: string, request: HeadersRequest): DbTopicRow {
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(topic.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(topic, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    return topic;
  }

  function requirePostVisible(postId: string, request: HeadersRequest): DbPostRow {
    const post = store.getPost(postId);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(post.topic_id, request);
    return post;
  }

  return {
    getCurrentUser,
    requireScope,
    requireAdmin,
    requireModerator,
    getIdentityFromRequest,
    canViewForum,
    canViewTopic,
    canCreateTopic,
    canPostTopic,
    requireForumVisible,
    requireTopicVisible,
    requirePostVisible
  };
}

export type AccessHelpers = ReturnType<typeof createAccessHelpers>;
export type { AuthContext, AuthScope };
