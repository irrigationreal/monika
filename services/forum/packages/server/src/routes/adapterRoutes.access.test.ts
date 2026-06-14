import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAdapterRoutes } from './adapterRoutes';

describe('Adapter routes access controls', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);

    const discordBridge = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      mapChannel: vi.fn(async () => {}),
      unmapChannel: vi.fn(() => {}),
      sendToThread: vi.fn(async () => 'msg-1'),
      isConnected: vi.fn(() => false),
      getStatus: vi.fn(() => ({ connected: false }))
    } as any;

    const matrixBridge = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      mapRoom: vi.fn(async () => {}),
      unmapRoom: vi.fn(() => {}),
      sendToThread: vi.fn(async () => 'evt-1'),
      sendToRoom: vi.fn(async () => 'evt-2'),
      isConnected: vi.fn(() => false),
      getStatus: vi.fn(() => ({ connected: false })),
      getJoinedRooms: vi.fn(() => []),
      getRoomInfo: vi.fn(() => null)
    } as any;

    registerAdapterRoutes({
      app,
      getDiscordBridge: () => discordBridge,
      getMatrixBridge: () => matrixBridge,
      defaultForumId: store.createForum('Default', null, null, null, null, 'active', 'public').id,
      access
    });

    await app.ready();
    return { app };
  }

  it('blocks non-admin access to adapter endpoints', async () => {
    const { app } = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const routes = [
      { method: 'GET', url: '/adapters/discord/status' },
      { method: 'POST', url: '/adapters/discord/connect' },
      { method: 'POST', url: '/adapters/discord/disconnect' },
      { method: 'POST', url: '/adapters/discord/map', payload: { channelId: 'chan-1' } },
      { method: 'DELETE', url: '/adapters/discord/map/chan-1' },
      { method: 'POST', url: '/adapters/discord/send', payload: { threadId: 'thread-1', content: 'hi' } },
      { method: 'GET', url: '/adapters/matrix/status' },
      { method: 'POST', url: '/adapters/matrix/connect' },
      { method: 'POST', url: '/adapters/matrix/disconnect' },
      { method: 'POST', url: '/adapters/matrix/map-room', payload: { roomId: '!room:example' } },
      { method: 'DELETE', url: '/adapters/matrix/map-room/!room:example' },
      { method: 'POST', url: '/adapters/matrix/send', payload: { roomId: '!room:example', content: 'hi' } },
      { method: 'GET', url: '/adapters/matrix/rooms' }
    ];

    for (const route of routes) {
      const guestRes = await app.inject({ method: route.method, url: route.url, payload: route.payload });
      expect(guestRes.statusCode, `${route.method} ${route.url} guest`).toBe(401);

      const humanRes = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
        headers: { authorization: 'Bearer human-token' }
      });
      expect(humanRes.statusCode, `${route.method} ${route.url} human`).toBe(403);
    }

    const adminRes = await app.inject({
      method: 'GET',
      url: '/adapters/discord/status',
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminRes.statusCode).toBe(200);
  });
});

