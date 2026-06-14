import type { FastifyInstance } from 'fastify';
import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AccessHelpers } from '../utils/access';
import type { NotificationRow } from '../db';
import { nowIso } from '../db';

function parseBooleanFlag(value?: string): boolean {
  return value === 'true' || value === '1';
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return parsed ?? null;
  } catch {
    return null;
  }
}

export function registerNotificationRoutes({
  app,
  store,
  bus,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  bus: StreamBusInterface;
  access: AccessHelpers;
}): void {
  const { getCurrentUser, requireScope, requireTopicVisible, canViewTopic, getIdentityFromRequest } = access;

  const mapNotification = (row: NotificationRow) => {
    return {
      id: row.id,
      identityId: row.identity_id,
      type: row.type,
      actorId: row.actor_id,
      topicId: row.topic_id,
      postId: row.post_id,
      payload: parsePayload(row.payload_json),
      createdAt: row.created_at,
      readAt: row.read_at
    };
  };

  app.get('/notifications', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const query = request.query as { page?: string; pageSize?: string; unreadOnly?: string };
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 50);
    const unreadOnly = parseBooleanFlag(query.unreadOnly);

    const items = store.listNotifications(user.identityId, { page, pageSize, unreadOnly });
    const total = store.countNotifications(user.identityId, unreadOnly);

    return {
      page,
      pageSize,
      total,
      items: items.map((row) => mapNotification(row))
    };
  });

  app.patch('/notifications/:id', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { id } = request.params as { id: string };
    const body = request.body as { readAt?: string | null };
    const existing = store.getNotification(id);
    if (!existing) {
      throw app.httpErrors.notFound('notification not found');
    }
    if (existing.identity_id !== user.identityId) {
      throw app.httpErrors.notFound('notification not found');
    }
    const readAt = body?.readAt === undefined ? nowIso() : body.readAt;
    const updated = store.markNotificationRead(id, readAt ?? null);
    if (!updated) {
      throw app.httpErrors.notFound('notification not found');
    }
    return mapNotification(updated);
  });

  app.post('/notifications/mark-all-read', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const readCount = store.markAllNotificationsRead(user.identityId);
    return { ok: true, readCount };
  });

  app.get('/notifications/stream', async (request, reply) => {
    const user = requireScope(getCurrentUser(request), 'read');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.write('retry: 1000\n\n');

    const keepAliveMs = 15_000;
    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        // Ignore write errors; the close handler will clean up.
      }
    }, keepAliveMs);

    const channel = `notify:${user.identityId}`;
    const unsubscribe = bus.subscribe(channel, (event) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
    });

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get('/topics/:topicId/unread', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const unread = store.getTopicUnread(user.identityId, topicId);
    return unread;
  });

  app.put('/topics/:topicId/read', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const body = request.body as { lastReadPostId?: string | null; lastReadAt?: string | null };
    if (!body || (body.lastReadPostId === undefined && body.lastReadAt === undefined)) {
      throw app.httpErrors.badRequest('lastReadPostId or lastReadAt is required');
    }
    store.upsertTopicRead({
      identityId: user.identityId,
      topicId,
      ...(body.lastReadPostId !== undefined ? { lastReadPostId: body.lastReadPostId } : {}),
      ...(body.lastReadAt !== undefined ? { lastReadAt: body.lastReadAt } : {})
    });
    return store.getTopicUnread(user.identityId, topicId);
  });

  app.get('/topics/:topicId/subscription', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const existing = store.getTopicSubscription(user.identityId, topicId);
    const subscription =
      existing ?? store.upsertTopicSubscription({ identityId: user.identityId, topicId, mode: 'off' });
    return {
      topicId: subscription.topic_id,
      identityId: subscription.identity_id,
      mode: subscription.mode as 'watching' | 'muted' | 'off',
      createdAt: subscription.created_at,
      updatedAt: subscription.updated_at
    };
  });

  app.put('/topics/:topicId/subscription', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const body = request.body as { mode?: 'watching' | 'muted' | 'off' };
    if (!body?.mode || !['watching', 'muted', 'off'].includes(body.mode)) {
      throw app.httpErrors.badRequest('mode must be watching, muted, or off');
    }
    const subscription = store.upsertTopicSubscription({
      identityId: user.identityId,
      topicId,
      mode: body.mode
    });
    return {
      topicId: subscription.topic_id,
      identityId: subscription.identity_id,
      mode: subscription.mode as 'watching' | 'muted' | 'off',
      createdAt: subscription.created_at,
      updatedAt: subscription.updated_at
    };
  });

  app.get('/me/subscriptions', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const identity = getIdentityFromRequest(request);
    const subscriptions = store.listSubscriptionsByIdentity(user.identityId);
    const visible = subscriptions.filter((subscription) => {
      const topic = store.getTopic(subscription.topic_id);
      if (!topic) return false;
      const forum = store.getForum(topic.forum_id);
      if (!forum) return false;
      return canViewTopic(topic, forum, identity);
    });
    return {
      items: visible.map((subscription) => ({
        topicId: subscription.topic_id,
        identityId: subscription.identity_id,
        mode: subscription.mode as 'watching' | 'muted' | 'off',
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at
      }))
    };
  });
}
