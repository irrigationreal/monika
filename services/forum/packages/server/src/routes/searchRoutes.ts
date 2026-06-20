import type { FastifyInstance } from 'fastify';
import type { FeatureFlags } from '../config';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';
import { mapPostRowToDomain, mapTopicRowToDomain } from '../mappers/db';
import { mapPostToDto, mapTopicToDto } from '../mappers/dto';

export function registerSearchRoutes({
  app,
  store,
  featureFlags,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  featureFlags: FeatureFlags;
  access: AccessHelpers;
}): void {
  const { getCurrentUser, getIdentityFromRequest, canViewForum } = access;
  const allowedScopes = new Set(['all', 'topics', 'posts']);

  app.get(
    '/search',
    {
      config: {
        rateLimit: featureFlags.enableRateLimiting
          ? {
              max: 60,
              timeWindow: '1 minute',
              keyGenerator: (request) => {
                const user = getCurrentUser(request);
                return user ? `identity:${user.identityId}` : `ip:${request.ip}`;
              }
            }
          : false
      }
    },
    (request) => {
      if (!featureFlags.enableSearch) {
        throw app.httpErrors.forbidden('Search disabled');
      }
      const requestQuery = request.query as { q?: string; scope?: string; limit?: string | number; forumId?: string };
      const query = requestQuery.q;
      const requestedScope = requestQuery.scope ?? 'all';
      if (!allowedScopes.has(requestedScope)) {
        throw app.httpErrors.badRequest('Invalid search scope');
      }
      const scope = requestedScope as 'all' | 'topics' | 'posts';
      const requestedLimit = Number(requestQuery.limit ?? 50);
      if (!Number.isFinite(requestedLimit)) {
        throw app.httpErrors.badRequest('Invalid search limit');
      }
      const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
      const identity = getIdentityFromRequest(request);
      const forumAccess = new Map<string, boolean>();
      const canViewForumId = (forumId: string | null | undefined): boolean => {
        if (!forumId) return false;
        if (forumAccess.has(forumId)) {
          return forumAccess.get(forumId) ?? false;
        }
        const forum = store.getForum(forumId);
        if (!forum) {
          forumAccess.set(forumId, false);
          return false;
        }
        const allowed = canViewForum(forum, identity);
        forumAccess.set(forumId, allowed);
        return allowed;
      };

      if (!query || query.trim().length < 2) {
        return { topics: [], posts: [] };
      }

      const visibleForumIds = store
        .listForums({ includeArchived: true })
        .filter((forum) => canViewForum(forum, identity))
        .map((forum) => forum.id);
      const requestedForumId = requestQuery.forumId?.trim();
      const searchableForumIds = requestedForumId
        ? visibleForumIds.includes(requestedForumId)
          ? [requestedForumId]
          : []
        : visibleForumIds;

      const results = store.search(query.trim(), scope, limit, { forumIds: searchableForumIds });
      return {
        topics: results.topics
          .filter((row) => canViewForumId(row.forum_id))
          .map((row) => {
            const topic = mapTopicRowToDomain(row);
            return mapTopicToDto({ ...topic, robotMode: topic.robotMode ?? null });
          }),
        posts: results.posts
          .filter((row) => {
            const topic = store.getTopic(row.topic_id);
            return topic ? canViewForumId(topic.forum_id) : false;
          })
          .map((row) => {
            const post = mapPostRowToDomain(row);
            const body = row.body.length > 200 ? `${row.body.slice(0, 200)}...` : row.body;
            return mapPostToDto({ ...post, body, silent: post.silent ?? false });
          })
      };
    }
  );
}
