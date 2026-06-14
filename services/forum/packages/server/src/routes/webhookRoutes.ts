import type { FastifyInstance } from 'fastify';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';

export function registerWebhookRoutes({
  app,
  store,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
}): void {
  const { requireAdmin } = access;

  // Webhook management endpoints (admin only)
  app.post('/webhooks', async (request) => {
    requireAdmin(request);
    const body = request.body as { url?: string; secret?: string; events?: string[] };

    if (!body?.url || !body?.secret || !body?.events) {
      throw app.httpErrors.badRequest('url, secret, and events are required');
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      throw app.httpErrors.badRequest('events must be a non-empty array');
    }

    const webhook = store.createWebhook(body.url, body.secret, body.events);
    return {
      id: webhook.id,
      url: webhook.url,
      events: JSON.parse(webhook.events),
      enabled: Boolean(webhook.enabled),
      createdAt: webhook.created_at,
      updatedAt: webhook.updated_at
    };
  });

  app.get('/webhooks', async (request) => {
    requireAdmin(request);
    const webhooks = store.listWebhooks();
    return webhooks.map((webhook) => ({
      id: webhook.id,
      url: webhook.url,
      events: JSON.parse(webhook.events),
      enabled: Boolean(webhook.enabled),
      createdAt: webhook.created_at,
      updatedAt: webhook.updated_at
    }));
  });

  app.patch('/webhooks/:webhookId', async (request) => {
    requireAdmin(request);
    const { webhookId } = request.params as { webhookId: string };
    const body = request.body as { url?: string; secret?: string; events?: string[]; enabled?: boolean };

    if (body.events !== undefined && (!Array.isArray(body.events) || body.events.length === 0)) {
      throw app.httpErrors.badRequest('events must be a non-empty array');
    }

    try {
      const webhook = store.updateWebhook(webhookId, body);
      return {
        id: webhook.id,
        url: webhook.url,
        events: JSON.parse(webhook.events),
        enabled: Boolean(webhook.enabled),
        createdAt: webhook.created_at,
        updatedAt: webhook.updated_at
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'webhook not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.delete('/webhooks/:webhookId', async (request) => {
    requireAdmin(request);
    const { webhookId } = request.params as { webhookId: string };

    const webhook = store.getWebhook(webhookId);
    if (!webhook) {
      throw app.httpErrors.notFound('Webhook not found');
    }

    store.deleteWebhook(webhookId);
    return { ok: true };
  });
}
