import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAdminRoutes } from './adminRoutes';

describe('Admin move topic endpoint', () => {
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

  it('moves topic and creates a marker post when no assistant turn is active', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);

    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);

    const { topic } = store.createTopic({ forumId: forumA.id, title: 'Topic', body: 'hello', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.setSessionPersonasSyncedAt(session.id, new Date().toISOString());

    const codex = {
      listActiveTurns: vi.fn(() => []),
      interruptTopic: vi.fn(async () => ({ ok: true, message: 'Interrupt sent.' }))
    } as any;

    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/topics/${topic.id}/move`,
      headers: { authorization: `Bearer ${token}` },
      payload: { forumId: forumB.id }
    });

    expect(res.statusCode).toBe(200);
    expect(codex.interruptTopic).toHaveBeenCalledTimes(0);

    const body = res.json() as { topic: { id: string; forumId: string }; move: { id: string; needsReprompt: boolean } };
    expect(body.topic.id).toBe(topic.id);
    expect(body.topic.forumId).toBe(forumB.id);
    expect(body.move.needsReprompt).toBe(true);

    const posts = store.listPosts(topic.id, 1, 50);
    expect(posts.some((p) => p.body.startsWith('Automatic post:'))).toBe(true);

    const pending = store.getPendingTopicMove(topic.id);
    expect(pending?.needsReprompt).toBe(true);

    const updatedSession = store.getSession(session.id);
    expect(updatedSession?.personas_synced_at).toBeNull();
  });

  it('rejects moves while an assistant turn is active', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);

    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);
    const { topic } = store.createTopic({ forumId: forumA.id, title: 'Topic', body: 'hello', authorId: admin.id });

    const codex = {
      listActiveTurns: vi.fn(() => [
        { threadId: 'thread-1', topicId: topic.id, sessionId: 'session-1', turnId: 'turn-1', parentPostId: null }
      ]),
      interruptTopic: vi.fn(async () => ({ ok: true, message: 'Interrupt sent.' }))
    } as any;

    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/topics/${topic.id}/move`,
      headers: { authorization: `Bearer ${token}` },
      payload: { forumId: forumB.id }
    });

    expect(res.statusCode).toBe(409);
    expect(store.getTopic(topic.id)?.forum_id).toBe(forumA.id);
    expect(codex.interruptTopic).toHaveBeenCalledTimes(0);
  });

  it('silently moves without creating a marker post or pending reprompt', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);

    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);
    const { topic } = store.createTopic({ forumId: forumA.id, title: 'Topic', body: 'hello', authorId: admin.id });
    const beforePosts = store.listPosts(topic.id, 1, 50);

    const codex = {
      listActiveTurns: vi.fn(() => []),
      interruptTopic: vi.fn(async () => ({ ok: true, message: 'Interrupt sent.' }))
    } as any;

    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/topics/${topic.id}/move`,
      headers: { authorization: `Bearer ${token}` },
      payload: { forumId: forumB.id, silent: true }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { topic: { forumId: string }; move: { markerPostId: string | null; needsReprompt: boolean; silent: boolean } };
    expect(body.topic.forumId).toBe(forumB.id);
    expect(body.move.markerPostId).toBeNull();
    expect(body.move.needsReprompt).toBe(false);
    expect(body.move.silent).toBe(true);
    expect(store.listPosts(topic.id, 1, 50)).toHaveLength(beforePosts.length);
    expect(store.getPendingTopicMove(topic.id)).toBeNull();
    expect(codex.interruptTopic).toHaveBeenCalledTimes(0);
  });

  it('rejects non-admin access', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);

    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const user = store.createIdentityWithPassword('User', 'user', 'pw-hash', 'human');
    const token = 'user-token';
    store.createAuthSession(token, user.id);

    const { topic } = store.createTopic({ forumId: forumA.id, title: 'Topic', body: 'hello', authorId: user.id });

    const codex = { listActiveTurns: vi.fn(() => []), interruptTopic: vi.fn(async () => ({ ok: true, message: 'ok' })) } as any;
    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/topics/${topic.id}/move`,
      headers: { authorization: `Bearer ${token}` },
      payload: { forumId: forumB.id }
    });

    expect(res.statusCode).toBe(403);
  });
});
