import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopicPostDispatchProjectionDtoSchema } from '@irrigationreal/codex-forum-contracts';

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
      getTopicContext: vi.fn(async () => null),
    } as any;
    const bus = { subscribe: vi.fn(() => () => {}) } as any;
    const autoRunDirector = {
      runManual: vi.fn(async () => ({ ok: true, message: 'ok' })),
      handleAssistantReply: vi.fn(async () => {}),
    } as any;
    registerRobotRoutes({ app, store, codex, bus, access, autoRunDirector });
    await app.ready();
    return app;
  }

  function createTopicWithTrace() {
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'starter',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    const plan = store.createPlan({
      topicId: topic.id,
      sessionId: session.id,
      content: 'secret plan content',
      summary: 'secret plan summary',
      parentPostId: post.id,
      visibility: 'internal',
    });
    store.createToolRun({
      topicId: topic.id,
      sessionId: session.id,
      tool: 'bash',
      parentPostId: post.id,
      command: 'cat /secret/path',
      outputSummary: 'secret output',
      visibility: 'internal',
    });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'running_tools',
      model: 'secret-model',
      reasoningEffort: 'xhigh',
      currentPlanId: plan.id,
    });
    return { topic, post, session };
  }

  it('keeps post dispatch diagnostics admin-only and returns sanitized attempt history', async () => {
    const app = await buildApp();
    const { topic, post, session } = createTopicWithTrace();
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const dispatch = store.createPostDispatch({ topicId: topic.id, postId: post.id, sessionId: session.id });
    const claimed = store.claimPostDispatch(dispatch.id, dispatch)!;
    store.markPostDispatchFailed(dispatch.id, claimed.claim_token!, 'reset\u0000with\nsecret detail', {
      retryAt: '2030-01-01T00:00:00.000Z',
      classification: 'transport',
    });

    for (const [headers, status] of [
      [undefined, 401],
      [{ authorization: 'Bearer author-token' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'GET', url: `/topics/${topic.id}/post-dispatches`, headers });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('secret detail');
    }
    const response = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/post-dispatches`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(response.statusCode).toBe(200);
    const body = TopicPostDispatchProjectionDtoSchema.parse(response.json());
    expect(body).toMatchObject({ topicId: topic.id, polling: true, current: [{ postId: post.id, attemptCount: 1 }] });
    expect(body.attempts[0]).toMatchObject({ event: 'retry_scheduled', classification: 'transport' });
    expect(response.body).not.toContain('\\u0000');
  });

  it('redacts robot state details for guests and authenticated non-admins', async () => {
    const app = await buildApp();
    const { topic } = createTopicWithTrace();
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    store.createAuthSession('admin-token', admin.id);

    const guestRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
    });
    expect(guestRes.statusCode).toBe(200);
    expect(guestRes.json()).toEqual({
      topicId: topic.id,
      activity: 'thinking',
      lastUpdatedAt: expect.any(String),
      currentPlan: null,
      recentToolRuns: [],
    });
    expect(guestRes.json()).not.toHaveProperty('sessionId');
    expect(guestRes.json()).not.toHaveProperty('model');
    expect(guestRes.json()).not.toHaveProperty('reasoningEffort');
    expect(guestRes.json()).not.toHaveProperty('context');
    expect(guestRes.json()).not.toHaveProperty('stream');

    const authRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
      headers: { authorization: 'Bearer author-token' },
    });
    expect(authRes.statusCode).toBe(200);
    expect(authRes.json()).toEqual(guestRes.json());
    const memberTraceRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/trace`,
      headers: { authorization: 'Bearer author-token' },
    });
    expect(memberTraceRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminRes.statusCode).toBe(200);
    const adminBody = adminRes.json() as any;
    expect(adminBody.sessionId).toBeTruthy();
    expect(adminBody.model).toBe('secret-model');
    expect(adminBody.reasoningEffort).toBe('xhigh');
    expect(adminBody.currentPlan?.content).toBe('secret plan content');
    expect(adminBody.currentPlan?.summary).toBe('secret plan summary');
    expect(adminBody.currentPlan?.parentPostId).toBe(adminBody.recentToolRuns[0].parentPostId);
    expect(adminBody.recentToolRuns).toHaveLength(1);
    expect(adminBody.recentToolRuns[0].command).toBe('cat /secret/path');
    expect(adminBody.recentToolRuns[0].outputSummary).toBe('secret output');
  });

  it('returns complete admin topic traces with deterministic newest-first tool ordering', async () => {
    const app = await buildApp();
    const { topic, post, session } = createTopicWithTrace();
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    store.createAuthSession('admin-token', admin.id);

    let olderSameTimeToolId = '';
    let newerSameTimeToolId = '';
    for (let index = 0; index < 51; index++) {
      store.createPlan({
        topicId: topic.id,
        sessionId: session.id,
        content: `plan ${index}`,
        summary: `plan ${index}`,
        parentPostId: post.id,
        visibility: 'internal',
      });
      const tool = store.createToolRun({
        topicId: topic.id,
        sessionId: session.id,
        tool: 'read',
        parentPostId: post.id,
        command: `read ${index}`,
        outputSummary: `output ${index}`,
        visibility: 'internal',
      });
      if (index === 49) olderSameTimeToolId = tool.id;
      if (index === 50) newerSameTimeToolId = tool.id;
    }
    db.prepare('update tool_runs set started_at = ? where id in (?, ?)').run(
      '2026-01-01T00:00:00.000Z',
      olderSameTimeToolId,
      newerSameTimeToolId
    );

    const response = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/trace`,
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body.toolRuns).toHaveLength(52);
    expect(body.plans).toHaveLength(52);
    const tiedTools = body.toolRuns.filter((tool: { id: string }) =>
      [olderSameTimeToolId, newerSameTimeToolId].includes(tool.id)
    );
    expect(tiedTools.map((tool: { id: string }) => tool.id)).toEqual([newerSameTimeToolId, olderSameTimeToolId]);
  });

  it('does not expose stale idle current plans to authenticated readers', async () => {
    const app = await buildApp();
    const { topic } = createTopicWithTrace();
    db.prepare("update robot_state set activity = 'idle' where topic_id = ?").run(topic.id);

    const authRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/state?view=full&include=plan,toolRuns`,
      headers: { authorization: 'Bearer author-token' },
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
    const { topic } = store.createTopic({
      forumId: adminForum.id,
      title: 'Secret',
      body: 'starter',
      authorId: admin.id,
    });

    const guestRes = await app.inject({ method: 'GET', url: `/topics/${topic.id}/state?view=full` });
    expect(guestRes.statusCode).toBe(404);
  });

  it('redacts public robot stream events and preserves completion signals only', () => {
    expect(redactStreamEventForPublic({ type: 'reasoning_delta', data: { delta: 'secret reasoning' } })).toBeNull();
    expect(
      redactStreamEventForPublic({ type: 'tool_started', data: { toolRunId: 'tool-1', tool: 'Bash' } })
    ).toBeNull();
    expect(redactStreamEventForPublic({ type: 'assistant_error', data: { error: 'secret stack' } })).toBeNull();
    expect(redactStreamEventForPublic({ type: 'assistant_message', data: { text: 'final text' } })).toEqual({
      type: 'assistant_message',
      data: {},
    });
    expect(
      redactStreamEventForPublic({
        type: 'state',
        data: {
          topicId: 'topic-1',
          sessionId: 'session-1',
          activity: 'running_tools',
          model: 'secret-model',
          reasoningEffort: 'xhigh',
          currentPlan: { content: 'secret plan' },
          recentToolRuns: [{ command: 'cat /secret' }],
        },
      })
    ).toEqual({
      type: 'state',
      data: {
        topicId: 'topic-1',
        activity: 'thinking',
        lastUpdatedAt: null,
        currentPlan: null,
        recentToolRuns: [],
      },
    });
  });

  it('requires authentication to interrupt robot', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

    const guestInterrupt = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/robot/interrupt`,
    });
    expect(guestInterrupt.statusCode).toBe(401);

    const authorInterrupt = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/robot/interrupt`,
      headers: { authorization: 'Bearer author-token' },
    });
    expect(authorInterrupt.statusCode).toBe(200);
  });

  it('refuses manual auto-run dispatch while cancellation is unresolved', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({ topicId: topic.id, sessionId: session.id, activity: 'stopping' });
    const response = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/auto-run/run`,
      headers: { authorization: 'Bearer admin-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/dispatch is fenced/);
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
    store.upsertPiSessionLink({
      piSessionId: 'pi-session',
      piSessionPath: '/app/.pi/agent/sessions/topic.jsonl',
      topicId: topic.id,
      sessionId: session.id,
      cwd: '/workspace/monika',
      parentPiSessionId: 'pi-parent',
      parentPiSessionPath: '/app/.pi/agent/sessions/parent.jsonl',
      lineageKind: 'handoff',
      lineageSource: 'forum',
    });

    const guestInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`,
    });
    expect(guestInspector.statusCode).toBe(401);

    const memberInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(memberInspector.statusCode).toBe(403);

    const adminInspector = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/inspector`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminInspector.statusCode).toBe(200);

    const guestSession = await app.inject({ method: 'GET', url: `/topics/${topic.id}/session` });
    expect(guestSession.statusCode).toBe(401);

    const memberSession = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/session`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(memberSession.statusCode).toBe(403);

    const adminSession = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/session`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminSession.statusCode).toBe(200);
    expect(adminSession.json()).toMatchObject({
      piSession: {
        id: 'pi-session',
        path: '/app/.pi/agent/sessions/topic.jsonl',
        cwd: '/workspace/monika',
        parentId: 'pi-parent',
        parentPath: '/app/.pi/agent/sessions/parent.jsonl',
        lineageKind: 'handoff',
        lineageSource: 'forum',
      },
    });

    const memberSessionById = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(memberSessionById.statusCode).toBe(403);

    const adminSessionById = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminSessionById.statusCode).toBe(200);

    const memberExternals = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/externals`,
      headers: { authorization: 'Bearer member-token' },
      payload: { surfaceId: 'ext', surfaceKind: 'discord', externalId: '123', kind: 'topic' },
    });
    expect(memberExternals.statusCode).toBe(403);

    const adminExternals = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/externals`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { surfaceId: 'ext', surfaceKind: 'discord', externalId: '123', kind: 'topic' },
    });
    expect(adminExternals.statusCode).toBe(200);
  });
});
