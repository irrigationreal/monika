import http from 'node:http';

import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { SseLifecycleRegistry } from '../services/sseLifecycle';
import { ForumStore } from '../store';
import { StreamBus } from '../streamBus';
import { createAccessHelpers } from '../utils/access';
import { registerChatRoutes } from './chatRoutes';
import { registerNotificationRoutes } from './notificationRoutes';
import { registerRobotRoutes } from './robotRoutes';

import type { AddressInfo } from 'node:net';

import type { StreamEvent } from '../streamBus';

class ObservedBus extends StreamBus {
  readonly events: Array<{ channel: string; event: StreamEvent }> = [];
  unsubscribes = 0;

  override emit(channel: string, event: StreamEvent): void {
    this.events.push({ channel, event });
    super.emit(channel, event);
  }

  override subscribe(channel: string, handler: (event: StreamEvent) => void): () => void {
    const unsubscribe = super.subscribe(channel, handler);
    return () => {
      this.unsubscribes += 1;
      unsubscribe();
    };
  }
}

type OpenStream = { request: http.ClientRequest; response: http.IncomingMessage };

async function openStream(port: number, path: string, token: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${token}` } },
      (response) => {
        response.once('data', () => resolve({ request, response }));
        response.once('error', reject);
      }
    );
    request.once('error', reject);
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

describe('forum SSE lifecycle', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  async function buildApp() {
    const db = new Database(':memory:');
    migrate(db);
    const store = new ForumStore(db);
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const bus = new ObservedBus();
    const sseLifecycle = new SseLifecycleRegistry();
    const codex = {
      interruptTopic: vi.fn(async () => ({ ok: true })),
      sendUserMessage: vi.fn(async () => {}),
      listActiveTurns: vi.fn(() => []),
      listQueuedTurns: vi.fn(() => []),
      pauseActiveThreads: vi.fn(async () => ({ paused: 0, skipped: 0 })),
      getStreamLiveness: vi.fn(() => ({ connected: false })),
      getTopicContext: vi.fn(async () => null),
    } as any;
    const autoRunDirector = {
      runManual: vi.fn(async () => ({ ok: true, message: 'ok' })),
      handleAssistantReply: vi.fn(async () => {}),
    } as any;

    registerChatRoutes({ app, store, access, bus, sseLifecycle });
    registerNotificationRoutes({ app, store, access, bus, sseLifecycle });
    registerRobotRoutes({ app, store, codex, bus, access, autoRunDirector, sseLifecycle });
    app.addHook('preClose', () => sseLifecycle.closeAll());

    const identity = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    const token = 'member-token';
    store.createAuthSession(token, identity.id);
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: identity.id });
    const category = store.createChatCategory({ name: 'Chat', visibility: 'public' });
    const room = store.createChatRoom({ categoryId: category.id, name: '#general', visibility: 'public' });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await app.close();
      db.close();
    });
    return {
      app,
      bus,
      sseLifecycle,
      token,
      topicId: topic.id,
      roomId: room.id,
      port,
      markClosed: () => {
        closed = true;
      },
    };
  }

  it('registers all three browser streams and lets app.close finish with real sockets open', async () => {
    const harness = await buildApp();
    const streams = await Promise.all([
      openStream(harness.port, '/notifications/stream', harness.token),
      openStream(harness.port, `/topics/${harness.topicId}/state/stream`, harness.token),
      openStream(harness.port, `/chat/rooms/${harness.roomId}/stream`, harness.token),
    ]);
    expect(harness.sseLifecycle.size).toBe(3);

    await expect(harness.app.close()).resolves.toBeUndefined();
    harness.markClosed();
    expect(harness.sseLifecycle.size).toBe(0);
    expect(harness.bus.unsubscribes).toBe(3);
    for (const stream of streams) stream.response.destroy();
  });

  it('cleans up a broken stream and emits chat departure exactly once', async () => {
    const harness = await buildApp();
    const stream = await openStream(harness.port, `/chat/rooms/${harness.roomId}/stream`, harness.token);
    stream.response.destroy();
    stream.request.destroy();
    await waitFor(() => harness.sseLifecycle.size === 0);

    harness.sseLifecycle.closeAll();
    const parts = harness.bus.events.filter(({ event }) => event.type === 'chat_part');
    const typingStops = harness.bus.events.filter(
      ({ event }) => event.type === 'chat_typing' && (event.data as { isTyping?: boolean }).isTyping === false
    );
    expect(parts).toHaveLength(1);
    expect(typingStops).toHaveLength(1);
    expect(harness.bus.unsubscribes).toBe(1);
  });

  it('allows an ordinary finite request to drain before app.close resolves', async () => {
    const app = Fastify({ logger: false });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    app.get('/finite', async () => {
      entered();
      await blocked;
      return { ok: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const responsePromise = new Promise<number>((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/finite', agent: false }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
    });
    await started;

    let closed = false;
    const closePromise = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    release();
    expect(await responsePromise).toBe(200);
    await closePromise;
    expect(closed).toBe(true);
  });

  it('rejects stream registration after shutdown admission closes', async () => {
    const harness = await buildApp();
    harness.sseLifecycle.closeAll();

    const response = await fetch(`http://127.0.0.1:${harness.port}/notifications/stream`, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    expect(response.status).toBe(503);
    expect(harness.sseLifecycle.size).toBe(0);
  });
});
