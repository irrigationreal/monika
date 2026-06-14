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
  const { getIdentityFromRequest, canViewForum } = access;

  app.get('/search', async (request) => {
    if (!featureFlags.enableSearch) {
      throw app.httpErrors.forbidden('Search disabled');
    }
    const query = (request.query as { q?: string }).q;
    const scope = (request.query as { scope?: string }).scope as 'all' | 'topics' | 'posts' | undefined;
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
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

    const results = store.search(query.trim(), scope ?? 'all', Math.min(limit, 100));
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
  });
}
