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

  it('interrupts robot first, moves topic, and creates a marker post', async () => {
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

    let interruptSawForumId: string | null = null;
    const codex = {
      interruptTopic: vi.fn(async (topicId: string) => {
        const row = store.getTopic(topicId);
        interruptSawForumId = row?.forum_id ?? null;
        return { ok: true, message: 'Interrupt sent.' };
      })
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
    expect(interruptSawForumId).toBe(forumA.id);
    expect(codex.interruptTopic).toHaveBeenCalledTimes(1);

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

    const codex = { interruptTopic: vi.fn(async () => ({ ok: true, message: 'ok' })) } as any;
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
