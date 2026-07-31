import { AdminAnalyticsDtoSchema, AdminAnalyticsQuerySchema } from '@irrigationreal/codex-forum-contracts';

import { parseBody } from '../utils/validation';

import type { FastifyInstance } from 'fastify';

import type { AnalyticsService } from '../services/analyticsService';
import type { AccessHelpers } from '../utils/access';

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export function registerAnalyticsRoutes({
  app,
  access,
  service,
}: {
  app: FastifyInstance;
  access: AccessHelpers;
  service: AnalyticsService;
}): void {
  app.get('/admin/analytics', async (request) => {
    access.requireAdmin(request);
    const query = parseBody(app, AdminAnalyticsQuerySchema, request.query);
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    if (toMs <= fromMs) throw app.httpErrors.badRequest('to must be after from');
    if (toMs - fromMs > MAX_RANGE_MS) throw app.httpErrors.badRequest('analytics range cannot exceed 366 days');
    try {
      const result = await service.getAnalytics({
        window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), bucket: query.bucket },
        forumId: query.forumId ?? null,
      });
      return AdminAnalyticsDtoSchema.parse(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'forum not found')
        throw app.httpErrors.notFound('forum not found');
      throw error;
    }
  });
}
