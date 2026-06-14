import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerRobotRoutes } from './robotRoutes';

describe('Robot routes access controls', () => {
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
    const codex = {
      interruptTopic: vi.fn(async () => ({ ok: true })),
      sendUserMessage: vi.fn(async () => {}),
      listActiveTurns: vi.fn(() => []),
      listQueuedTurns: vi.fn(() => []),
      pauseActiveThreads: vi.fn(async () => ({ paused: 0, skipped: 0 }))
    } as any;
    const bus = { subscribe: vi.fn(() => () => {}) } as any;
    const autoRunDirector = {
      runManual: vi.fn(async () => ({ ok: true, message: 'ok' })),
      handleAssistantReply: vi.fn(async () => {})
    } as any;
    registerRobotRoutes({ app, store, codex, bus, access, autoRunDirector });
    await app.ready();
    return app;
  }

  it('requires authentication to interrupt/continue robot', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

    const guestInterrupt = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/robot/interrupt`
    });
    expect(guestInterrupt.statusCode).toBe(401);

    const guestContinue = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/robot/continue`
    });
    expect(guestContinue.statusCode).toBe(401);

    const authorInterrupt = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/robot/interrupt`,
      headers: { authorization: 'Bearer author-token' }
    });
    expect(authorInterrupt.statusCode).toBe(200);
  });

  it('restricts session inspector and externals to admins', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentity('Admin', 'admin');
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('member-token', member.id);

    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });

    const guestInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`
    });
    expect(guestInspector.statusCode).toBe(401);

    const memberInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`,
      headers: { authorization: 'Bearer member-token' }
    });
    expect(memberInspector.statusCode).toBe(403);

    const adminInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminInspector.statusCode).toBe(200);

    const memberSession = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/session`,
      headers: { authorization: 'Bearer member-token' }
    });
    expect(memberSession.statusCode).toBe(403);

    const adminSession = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/session`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminSession.statusCode).toBe(200);

    const memberSessionById = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}`,
      headers: { authorization: 'Bearer member-token' }
    });
    expect(memberSessionById.statusCode).toBe(403);

    const adminSessionById = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminSessionById.statusCode).toBe(200);

    const memberExternals = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/externals`,
      headers: { authorization: 'Bearer member-token' },
      payload: { surfaceId: 'ext', surfaceKind: 'discord', externalId: '123', kind: 'topic' }
    });
    expect(memberExternals.statusCode).toBe(403);

    const adminExternals = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/externals`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { surfaceId: 'ext', surfaceKind: 'discord', externalId: '123', kind: 'topic' }
    });
    expect(adminExternals.statusCode).toBe(200);
  });
});
