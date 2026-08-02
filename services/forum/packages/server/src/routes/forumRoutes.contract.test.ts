import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ForumDtoSchema,
  PageResponsePostDtoSchema,
  PageResponseTopicDtoSchema,
  PostDtoSchema,
  TopicDtoSchema,
} from '@irrigationreal/codex-forum-contracts';
import { MessageDraftService } from '@irrigationreal/codex-forum-core';

import { ForumQueries } from '../core/queries';
import { ForumStoreRuntime } from '../core/runtime';
import { createCoreServices } from '../core/services';
import { migrate } from '../db';
import { SqliteStatsReadModel } from '../readModels/statsReadModel';
import { SqliteMessageDraftRepository } from '../repositories/sqliteMessageDraftRepository';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';

type Issue = { path: Array<string | number>; message: string };
type SchemaResult<T> = { success: true; data: T } | { success: false; error: { issues: Issue[] } };
type SchemaType<T = unknown> = { safeParse: (data: unknown) => SchemaResult<T> };

function formatZodIssues(issues: Issue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

function assertSchema(schema: SchemaType, payload: unknown, context: string) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const detail = formatZodIssues(result.error.issues);
    const formattedPayload = JSON.stringify(payload, null, 2);
    throw new Error(`Contract mismatch for ${context}\n${detail}\nPayload: ${formattedPayload}`);
  }
}

describe('Forum routes contract conformance', () => {
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

  async function buildApp(webhookDispatch: () => void = () => {}) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags = { enableRateLimiting: false, useRedisStreamBus: false } as any;
    const codex = {
      sendUserMessage: vi.fn(async () => {}),
      steerUserMessage: vi.fn(async () => {}),
      isThreadLoaded: vi.fn(async () => false),
    } as any;
    const core = createCoreServices(db);
    const queries = new ForumQueries(db);
    const runtime = new ForumStoreRuntime(store);
    const statsReadModel = new SqliteStatsReadModel(db);

    registerForumRoutes({
      app,
      store,
      core,
      queries,
      runtime,
      statsReadModel,
      featureFlags,
      codex,
      webhookService: { dispatch: webhookDispatch } as any,
      access,
      webIdentityId: store.createIdentity('web', 'human').id,
    });
    await app.ready();
    return app;
  }

  function createSession(identityId: string) {
    const token = `${identityId}-token`;
    store.createAuthSession(token, identityId);
    return token;
  }

  function drafts() {
    return new MessageDraftService(new SqliteMessageDraftRepository(db));
  }

  it('GET /forums conforms to ForumDto[]', async () => {
    const app = await buildApp();
    store.createForum('General', null, null, null, null, 'active', 'public');

    const res = await app.inject({ method: 'GET', url: '/forums' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(ForumDtoSchema.array(), body, 'GET /forums');
  });

  it('GET /forums/:forumId/topics conforms to PageResponseTopicDto', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    store.createTopic({ forumId: forum.id, title: 'Hello', body: 'First post', authorId: author.id });

    const res = await app.inject({ method: 'GET', url: `/forums/${forum.id}/topics` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(PageResponseTopicDtoSchema, body, 'GET /forums/:forumId/topics');
  });

  it('GET /topics/:topicId/posts conforms to PageResponsePostDto', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Hello', body: 'First post', authorId: author.id });
    store.createPost({ topicId: topic.id, body: 'Reply', parentPostId: null, authorId: author.id });

    const res = await app.inject({ method: 'GET', url: `/topics/${topic.id}/posts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(PageResponsePostDtoSchema, body, 'GET /topics/:topicId/posts');
  });

  it('POST /forums/:forumId/topics conforms to TopicDto', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const token = createSession(author.id);

    const res = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'New topic', body: 'Hello world' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(TopicDtoSchema, body, 'POST /forums/:forumId/topics');
  });

  it('POST /topics/:topicId/posts conforms to PostDto', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Hello', body: 'First post', authorId: author.id });
    const token = createSession(author.id);

    const res = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Reply' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(PostDtoSchema, body, 'POST /topics/:topicId/posts');
  });

  it('atomically consumes an exact reply draft while stale and legacy requests behave safely', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Hello', body: 'First post', authorId: author.id });
    const token = createSession(author.id);
    const draft = await drafts().saveReply(author.id, topic.id, 0, { body: 'private reply' });
    const before = db.prepare('select count(*) count from posts where topic_id = ?').get(topic.id) as { count: number };

    const stale = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Reply', draft: { id: draft.id, revision: draft.revision + 1 } },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (db.prepare('select count(*) count from posts where topic_id = ?').get(topic.id) as { count: number }).count
    ).toBe(before.count);
    expect(await drafts().getReply(author.id, topic.id)).not.toBeNull();

    const exact = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Reply', draft: { id: draft.id, revision: draft.revision } },
    });
    expect(exact.statusCode).toBe(200);
    expect(await drafts().getReply(author.id, topic.id)).toBeNull();

    const legacy = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Legacy client reply' },
    });
    expect(legacy.statusCode).toBe(200);
  });

  it('atomically consumes only the owner’s exact new-thread draft', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const other = store.createIdentity('Other', 'human');
    const token = createSession(author.id);
    const draft = await drafts().saveNewThread(author.id, forum.id, 0, { title: 'Draft title', body: 'private body' });
    const before = (db.prepare('select count(*) count from topics').get() as { count: number }).count;

    const foreign = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${createSession(other.id)}` },
      payload: { title: 'Foreign', body: 'Must not publish', draft: { id: draft.id, revision: draft.revision } },
    });
    expect(foreign.statusCode).toBe(409);
    expect((db.prepare('select count(*) count from topics').get() as { count: number }).count).toBe(before);

    const exact = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Published', body: 'Published body', draft: { id: draft.id, revision: draft.revision } },
    });
    expect(exact.statusCode).toBe(200);
    expect(await drafts().get(author.id, draft.id)).toBeNull();
  });

  it('contains post-commit webhook failures and still reports truthful publication success', async () => {
    const app = await buildApp(() => {
      throw new Error('webhook failure');
    });
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const token = createSession(author.id);
    const created = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Committed', body: 'Webhook cannot undo this' },
    });
    expect(created.statusCode).toBe(200);
    expect((db.prepare('select count(*) count from topics').get() as { count: number }).count).toBe(1);
  });

  it('rolls back publication and preserves both draft kinds when a required projection write fails', async () => {
    const app = await buildApp();
    const forum = store.createForum('General', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const token = createSession(author.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Existing', body: 'starter', authorId: author.id });
    const replyDraft = await drafts().saveReply(author.id, topic.id, 0, { body: 'reply draft' });
    const beforePosts = (
      db.prepare('select count(*) count from posts where topic_id = ?').get(topic.id) as { count: number }
    ).count;
    vi.spyOn(store, 'createSessionMessage').mockImplementationOnce(() => {
      throw new Error('projection failure');
    });
    const reply = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Reply', draft: { id: replyDraft.id, revision: replyDraft.revision } },
    });
    expect(reply.statusCode).toBe(500);
    expect(
      (db.prepare('select count(*) count from posts where topic_id = ?').get(topic.id) as { count: number }).count
    ).toBe(beforePosts);
    expect(await drafts().getReply(author.id, topic.id)).not.toBeNull();

    const threadDraft = await drafts().saveNewThread(author.id, forum.id, 0, { title: 'Thread draft', body: 'body' });
    const beforeTopics = (db.prepare('select count(*) count from topics').get() as { count: number }).count;
    vi.spyOn(store, 'createSessionMessage').mockImplementationOnce(() => {
      throw new Error('projection failure');
    });
    const thread = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Thread', body: 'Thread body', draft: { id: threadDraft.id, revision: threadDraft.revision } },
    });
    expect(thread.statusCode).toBe(500);
    expect((db.prepare('select count(*) count from topics').get() as { count: number }).count).toBe(beforeTopics);
    expect(store.listTopics(forum.id).some((item) => item.title === 'Thread')).toBe(false);
    expect(await drafts().get(author.id, threadDraft.id)).not.toBeNull();
  });
});
