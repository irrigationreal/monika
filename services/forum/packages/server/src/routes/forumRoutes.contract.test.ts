import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ForumDtoSchema,
  PageResponsePostDtoSchema,
  PageResponseTopicDtoSchema,
  PostDtoSchema,
  TopicDtoSchema
} from '@irrigationreal/codex-forum-contracts';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createCoreServices } from '../core/services';
import { ForumQueries } from '../core/queries';
import { ForumStoreRuntime } from '../core/runtime';
import { SqliteStatsReadModel } from '../readModels/statsReadModel';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';

type Issue = { path: Array<string | number>; message: string };
type SchemaResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: Issue[] } };
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

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags = { enableRateLimiting: false, useRedisStreamBus: false } as any;
    const codex = {
      sendUserMessage: vi.fn(async () => {}),
      steerUserMessage: vi.fn(async () => {}),
      isThreadLoaded: vi.fn(async () => false)
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
      webhookService: { dispatch: () => {} } as any,
      access,
      webIdentityId: store.createIdentity('web', 'human').id
    });
    await app.ready();
    return app;
  }

  function createSession(identityId: string) {
    const token = `${identityId}-token`;
    store.createAuthSession(token, identityId);
    return token;
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
      payload: { title: 'New topic', body: 'Hello world' }
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
      payload: { body: 'Reply' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    assertSchema(PostDtoSchema, body, 'POST /topics/:topicId/posts');
  });
});
