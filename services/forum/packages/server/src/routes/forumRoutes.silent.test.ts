import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createCoreServices } from '../core/services';
import { ForumQueries } from '../core/queries';
import { ForumStoreRuntime } from '../core/runtime';
import { SqliteStatsReadModel } from '../readModels/statsReadModel';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';
import { createStreamBus } from '../streamBus';

describe('Forum routes silent posts', () => {
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

  async function buildApp(codexOverrides?: Partial<any>) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags = { enableRateLimiting: false, useRedisStreamBus: false } as any;
    const bus = createStreamBus(false);
    const codex = {
      sendUserMessage: vi.fn(async () => {}),
      steerUserMessage: vi.fn(async () => {}),
      isThreadLoaded: vi.fn(async () => false),
      ...codexOverrides
    } as any;
    const core = createCoreServices(db);
    const queries = new ForumQueries(db);
    const runtime = new ForumStoreRuntime(store);
    const statsReadModel = new SqliteStatsReadModel(db);
    const postDispatchService = { wake: vi.fn() };
    registerForumRoutes({
      app,
      store,
      core,
      queries,
      runtime,
      statsReadModel,
      featureFlags,
      codex,
      webhookService: { dispatch: () => {} } as any,
      bus,
      postDispatchService,
      access,
      webIdentityId: store.createIdentity('web', 'human').id
    });
    await app.ready();
    return { app, codex, postDispatchService };
  }

  function countDispatches(): number {
    return (db.prepare('select count(*) as count from post_dispatches').get() as { count: number }).count;
  }

  it('creates silent replies without dispatching the robot and queues non-silent replies while busy', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'hello', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
      currentPlanId: null
    });

    const resSilent = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'silent reply', silent: true }
    });
    expect(resSilent.statusCode).toBe(200);
    const created = resSilent.json() as { id: string; silent?: boolean };
    expect(created.silent).toBe(true);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);

    const resNonSilent = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'normal reply' }
    });
    expect(resNonSilent.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
    expect(countDispatches()).toBe(1);
  });

  it('creates silent topics without dispatching the robot', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const res = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Silent topic', body: 'starter', silent: true }
    });

    expect(res.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
  });

  it('skips the robot when topic robotMode is off', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const { topic } = store.createTopic({
      forumId: forum.id,
      title: 'No robot',
      body: 'starter',
      authorId: author.id,
      robotMode: 'off'
    });

    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
      currentPlanId: null
    });

    const res = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'no robot please' }
    });

    expect(res.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
  });

  it('dispatches only when @robot is mentioned in mention-only topics', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const { topic } = store.createTopic({
      forumId: forum.id,
      title: 'Mention only',
      body: 'starter',
      authorId: author.id,
      robotMode: 'mention'
    });

    const resNoMention = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'hello there' }
    });
    expect(resNoMention.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);

    const resMention = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'hey @robot can you help?' }
    });
    expect(resMention.statusCode).toBe(200);
    expect(countDispatches()).toBe(1);
  });

  it('detects @robot mentions across common punctuation and ignores email addresses', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const { topic } = store.createTopic({
      forumId: forum.id,
      title: 'Mention only',
      body: 'starter',
      authorId: author.id,
      robotMode: 'mention'
    });

    const cases = [
      { body: '(@robot) ping', shouldDispatch: true },
      { body: 'hello,@robot', shouldDispatch: true },
      { body: 'hey @Robot can you help?', shouldDispatch: true },
      { body: 'email me foo@robot.com', shouldDispatch: false },
      { body: 'contact: foo@robot', shouldDispatch: false }
    ];

    for (const testCase of cases) {
      codex.sendUserMessage.mockClear();
      codex.steerUserMessage.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: `/topics/${topic.id}/posts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: testCase.body }
      });
      expect(res.statusCode).toBe(200);
      const dispatchCount = countDispatches();
      expect(dispatchCount).toBe(testCase.shouldDispatch ? 1 : 0);
      db.prepare('delete from post_dispatches').run();
      expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
      expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
      expect((res.json() as any)?.body).toBe(testCase.body);
    }
  });

  it('bypasses busy guard for mention-only posts and records a dispatch when mentioned', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const { topic } = store.createTopic({
      forumId: forum.id,
      title: 'Mention only',
      body: 'starter',
      authorId: author.id,
      robotMode: 'mention'
    });

    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
      currentPlanId: null
    });

    const resNoMention = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'just chatting' }
    });
    expect(resNoMention.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);

    const resMention = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '@robot please respond' }
    });
    expect(resMention.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
    expect(countDispatches()).toBe(1);
  });

  it('can create mention-only topics and dispatches only if the starter post includes @robot', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const resNoMention = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Mention only', body: 'starter', robotMode: 'mention' }
    });
    expect(resNoMention.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);

    const resMention = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Mention only', body: 'starter (@robot)', robotMode: 'mention' }
    });
    expect(resMention.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(countDispatches()).toBe(1);
  });

  it('never dispatches for robotMode=off topics even if @robot is included', async () => {
    const { app, codex } = await buildApp();

    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'human', 'pw-hash', 'author');
    const token = 'author-token';
    store.createAuthSession(token, author.id);

    const resOff = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Off', body: 'starter @robot', robotMode: 'off' }
    });
    expect(resOff.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);

    const createdTopic = resOff.json() as { id: string };
    const resReply = await app.inject({
      method: 'POST',
      url: `/topics/${createdTopic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'reply @robot still should not dispatch' }
    });
    expect(resReply.statusCode).toBe(200);
    expect(codex.sendUserMessage).toHaveBeenCalledTimes(0);
    expect(codex.steerUserMessage).toHaveBeenCalledTimes(0);
  });
});
