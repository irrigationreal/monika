import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForumQueries } from '../core/queries';
import { ForumStoreRuntime } from '../core/runtime';
import { createCoreServices } from '../core/services';
import { migrate } from '../db';
import { SqliteStatsReadModel } from '../readModels/statsReadModel';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';

function operation(sourceTopicId: string) {
  return {
    id: 'clone-one',
    sourceTopicId,
    expectedLeafId: 'leaf',
    initiatedBy: 'admin',
    title: 'Copy',
    status: 'pending' as const,
    childTopicId: null,
    childSessionId: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

describe('forum clone routes', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  async function buildApp(cloneService: any) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    registerForumRoutes({
      app,
      store,
      core: createCoreServices(db),
      queries: new ForumQueries(db),
      runtime: new ForumStoreRuntime(store),
      statsReadModel: new SqliteStatsReadModel(db),
      featureFlags: { enableRateLimiting: false, useRedisStreamBus: false } as any,
      codex: { sendUserMessage: vi.fn(), steerUserMessage: vi.fn(), isThreadLoaded: vi.fn() } as any,
      cloneService,
      access: createAccessHelpers(app, store),
      webIdentityId: store.createIdentity('web', 'human').id,
    } as any);
    await app.ready();
    return app;
  }

  function token(identityId: string): string {
    const value = `${identityId}-token`;
    store.createAuthSession(value, identityId);
    return value;
  }

  it('is admin-only and accepts a validated durable clone operation without dispatching', async () => {
    const admin = store.createIdentity('Admin', 'admin');
    const member = store.createIdentity('Member', 'human');
    const forum = store.createForum('Forum');
    const created = store.createTopic({ forumId: forum.id, title: 'Parent', body: 'Body', authorId: admin.id });
    const accepted = operation(created.topic.id);
    const cloneService = {
      enqueue: vi.fn().mockResolvedValue(accepted),
      state: vi.fn().mockReturnValue({ active: accepted, latest: accepted }),
      get: vi.fn().mockReturnValue(accepted),
    };
    const app = await buildApp(cloneService);

    const forbidden = await app.inject({
      method: 'POST',
      url: `/topics/${created.topic.id}/clones`,
      headers: { authorization: `Bearer ${token(member.id)}` },
      payload: { operationId: 'clone-one', title: 'Copy' },
    });
    expect(forbidden.statusCode).toBe(403);

    const adminToken = token(admin.id);
    const response = await app.inject({
      method: 'POST',
      url: `/topics/${created.topic.id}/clones`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { operationId: 'clone-one', title: '  Copy  ' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toContain('/clones/clone-one');
    expect(response.json()).toMatchObject({ id: 'clone-one', status: 'pending', childTopicId: null });
    expect(cloneService.enqueue).toHaveBeenCalledWith({
      operationId: 'clone-one',
      topicId: created.topic.id,
      initiatedBy: admin.id,
      title: 'Copy',
    });

    const state = await app.inject({
      method: 'GET',
      url: `/topics/${created.topic.id}/clones`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ active: { id: 'clone-one' }, latest: { id: 'clone-one' } });
    expect(db.prepare('select count(*) as count from post_dispatches').get()).toEqual({ count: 0 });
    await app.close();
  });

  it('rejects malformed ids/titles and scopes operation reads to the source topic', async () => {
    const admin = store.createIdentity('Admin', 'admin');
    const forum = store.createForum('Forum');
    const created = store.createTopic({ forumId: forum.id, title: 'Parent', body: 'Body', authorId: admin.id });
    const cloneService = {
      enqueue: vi.fn(),
      state: vi.fn(),
      get: vi.fn(() => {
        throw new Error('wrong topic');
      }),
    };
    const app = await buildApp(cloneService);
    const auth = { authorization: `Bearer ${token(admin.id)}` };

    const invalid = await app.inject({
      method: 'POST',
      url: `/topics/${created.topic.id}/clones`,
      headers: auth,
      payload: { operationId: '../unsafe', title: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(cloneService.enqueue).not.toHaveBeenCalled();
    await app.close();
  });
});
