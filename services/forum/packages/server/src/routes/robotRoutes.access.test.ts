import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { redactStreamEventForPublic, registerRobotRoutes } from './robotRoutes';

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
      pauseActiveThreads: vi.fn(async () => ({ paused: 0, skipped: 0 })),
      getStreamLiveness: vi.fn(() => ({ connected: false })),
      getTopicContext: vi.fn(async () => null)
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

  function createTopicWithTrace() {
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    const { topic, post } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    const plan = store.createPlan({
      topicId: topic.id,
      sessionId: session.id,
      content: 'secret plan content',
      summary: 'secret plan summary',
      parentPostId: post.id,
      visibility: 'internal'
    });
    store.createToolRun({
      topicId: topic.id,
      sessionId: session.id,
      tool: 'bash',
      parentPostId: post.id,
      command: 'cat /secret/path',
      outputSummary: 'secret output',
      visibility: 'internal'
    });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'running_tools',
      model: 'secret-model',
      reasoningEffort: 'xhigh',
      currentPlanId: plan.id
    });
    return { topic };
  }

  it('redacts robot state details for unauthenticated public readers', async () => {
    const app = await buildApp();
    const { topic } = createTopicWithTrace();

    const guestRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`
    });
    expect(guestRes.statusCode).toBe(200);
    expect(guestRes.json()).toEqual({
      topicId: topic.id,
      activity: 'thinking',
      lastUpdatedAt: expect.any(String),
      currentPlan: null,
      recentToolRuns: []
    });
    expect(guestRes.json()).not.toHaveProperty('sessionId');
    expect(guestRes.json()).not.toHaveProperty('model');
    expect(guestRes.json()).not.toHaveProperty('reasoningEffort');
    expect(guestRes.json()).not.toHaveProperty('context');
    expect(guestRes.json()).not.toHaveProperty('stream');

    const authRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
      headers: { authorization: 'Bearer author-token' }
    });
    expect(authRes.statusCode).toBe(200);
    const authBody = authRes.json() as any;
    expect(authBody.sessionId).toBeTruthy();
    expect(authBody.model).toBe('secret-model');
    expect(authBody.reasoningEffort).toBe('xhigh');
    expect(authBody.currentPlan?.content).toBe('secret plan content');
    expect(authBody.currentPlan?.summary).toBe('secret plan summary');
    expect(authBody.recentToolRuns).toHaveLength(1);
    expect(authBody.recentToolRuns[0].command).toBe('cat /secret/path');
    expect(authBody.recentToolRuns[0].outputSummary).toBe('secret output');
  });

  it('does not expose stale idle current plans to authenticated readers', async () => {
    const app = await buildApp();
    const { topic } = createTopicWithTrace();
    db.prepare("update robot_state set activity = 'idle' where topic_id = ?").run(topic.id);

    const authRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
      headers: { authorization: 'Bearer author-token' }
    });

    expect(authRes.statusCode).toBe(200);
    const body = authRes.json() as any;
    expect(body.activity).toBe('idle');
    expect(body.currentPlan).toBeNull();
  });

  it('does not expose robot state for private topics to unauthenticated readers', async () => {
    const app = await buildApp();
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const admin = store.createIdentity('Admin', 'admin');
    const { topic } = store.createTopic({ forumId: adminForum.id, title: 'Secret', body: 'starter', authorId: admin.id });

    const guestRes = await app.inject({ method: 'GET', url: `/topics/${topic.id}/state?view=full` });
    expect(guestRes.statusCode).toBe(404);
  });

  it('redacts public robot stream events and preserves completion signals only', () => {
    expect(redactStreamEventForPublic({ type: 'reasoning_delta', data: { delta: 'secret reasoning' } })).toBeNull();
    expect(redactStreamEventForPublic({ type: 'assistant_delta', data: { delta: 'secret draft' } })).toBeNull();
    expect(redactStreamEventForPublic({ type: 'tool_started', data: { toolRunId: 'tool-1', tool: 'Bash' } })).toBeNull();
    expect(redactStreamEventForPublic({ type: 'assistant_error', data: { error: 'secret stack' } })).toBeNull();
    expect(redactStreamEventForPublic({ type: 'assistant_message', data: { text: 'final text' } })).toEqual({
      type: 'assistant_message',
      data: {}
    });
    expect(redactStreamEventForPublic({
      type: 'state',
      data: {
        topicId: 'topic-1',
        sessionId: 'session-1',
        activity: 'running_tools',
        model: 'secret-model',
        reasoningEffort: 'xhigh',
        currentPlan: { content: 'secret plan' },
        recentToolRuns: [{ command: 'cat /secret' }],
        assistantText: 'secret live text'
      }
    })).toEqual({
      type: 'state',
      data: {
        topicId: 'topic-1',
        activity: 'thinking',
        lastUpdatedAt: null,
        currentPlan: null,
        recentToolRuns: []
      }
    });
  });

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
