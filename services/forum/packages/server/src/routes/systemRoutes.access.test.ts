import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerSystemRoutes } from './systemRoutes';

describe('System route access controls', () => {
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
    registerSystemRoutes({ app, access });
    await app.ready();
    return app;
  }

  it('requires authentication for API documentation assets', async () => {
    const app = await buildApp();
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('member-token', member.id);

    for (const url of ['/openapi.json', '/postman/collection.json']) {
      const guestRes = await app.inject({ method: 'GET', url });
      expect(guestRes.statusCode).toBe(401);

      const memberRes = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer member-token' },
      });
      expect(memberRes.statusCode).toBe(200);
    }
  });
});
