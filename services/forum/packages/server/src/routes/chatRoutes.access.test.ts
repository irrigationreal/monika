import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { StreamBus } from '../streamBus';
import { createAccessHelpers } from '../utils/access';
import { registerChatRoutes } from './chatRoutes';

describe('Chat route access controls', () => {
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
    registerChatRoutes({ app, store, access, bus: new StreamBus() });
    await app.ready();
    return app;
  }

  it('requires authentication for chat read surfaces', async () => {
    const app = await buildApp();
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('member-token', member.id);
    const category = store.createChatCategory({ name: 'Public Chat', visibility: 'public' });
    const room = store.createChatRoom({ categoryId: category.id, name: '#general', visibility: 'public' });
    store.createChatMessage({ roomId: room.id, authorId: member.id, authorName: member.display_name, body: 'hello' });

    const readUrls = [
      '/chat/categories',
      `/chat/rooms?categoryId=${category.id}`,
      `/chat/rooms/${room.id}/messages`,
      `/chat/rooms/${room.id}/stream`,
    ];

    for (const url of readUrls) {
      const guestRes = await app.inject({ method: 'GET', url });
      expect(guestRes.statusCode).toBe(401);
    }

    const categories = await app.inject({
      method: 'GET',
      url: '/chat/categories',
      headers: { authorization: 'Bearer member-token' },
    });
    expect(categories.statusCode).toBe(200);

    const rooms = await app.inject({
      method: 'GET',
      url: `/chat/rooms?categoryId=${category.id}`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(rooms.statusCode).toBe(200);

    const messages = await app.inject({
      method: 'GET',
      url: `/chat/rooms/${room.id}/messages`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(messages.statusCode).toBe(200);
  });
});
