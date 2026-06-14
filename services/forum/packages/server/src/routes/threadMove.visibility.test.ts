import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';
import { registerAttachmentRoutes } from './attachmentRoutes';
import { createStreamBus } from '../streamBus';

describe('Thread move visibility + attachments', () => {
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
    const bus = createStreamBus(false);
    registerForumRoutes({
      app,
      store,
      featureFlags,
      codex: {} as any,
      webhookService: { dispatch: () => {} } as any,
      bus,
      access,
      webIdentityId: store.createIdentity('web', 'human').id
    });
    registerAttachmentRoutes({ app, store, access });
    await app.ready();
    return app;
  }

  it('members -> public makes topic and attachments visible to anonymous', async () => {
    const app = await buildApp();

    const forumMembers = store.createForum('Members', null, null, null, null, 'active', 'members');
    const forumPublic = store.createForum('Public', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');

    const { topic } = store.createTopic({ forumId: forumMembers.id, title: 'T', body: 'P', authorId: author.id });
    const postId = store.getLatestPostId(topic.id) as string;
    const storagePath = join(tmpdir(), `cforum-attach-${topic.id}.txt`);
    writeFileSync(storagePath, 'hello', 'utf8');
    const attachment = store.createAttachment({
      postId,
      filename: 'test.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      storagePath
    });

    const resBefore = await app.inject({ method: 'GET', url: `/topics/${topic.id}` });
    expect(resBefore.statusCode).toBe(404);

    const resAttachBefore = await app.inject({ method: 'GET', url: `/attachments/${attachment.id}` });
    expect(resAttachBefore.statusCode).toBe(404);

    store.moveTopic({
      topicId: topic.id,
      toForumId: forumPublic.id,
      movedBy: author.id,
      markerBody: 'Automatic post: moved.'
    });

    const resAfter = await app.inject({ method: 'GET', url: `/topics/${topic.id}` });
    expect(resAfter.statusCode).toBe(200);

    const resAttachAfter = await app.inject({ method: 'GET', url: `/attachments/${attachment.id}` });
    expect(resAttachAfter.statusCode).toBe(200);
  });

  it('public -> admin hides topic and attachments from non-admin', async () => {
    const app = await buildApp();

    const forumPublic = store.createForum('Public', null, null, null, null, 'active', 'public');
    const forumAdmin = store.createForum('Admins', null, null, null, null, 'active', 'admin');
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);

    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forumPublic.id, title: 'T', body: 'P', authorId: author.id });
    const postId = store.getLatestPostId(topic.id) as string;
    const storagePath = join(tmpdir(), `cforum-attach-${topic.id}.bin`);
    writeFileSync(storagePath, 'hello', 'utf8');
    const attachment = store.createAttachment({
      postId,
      filename: 'test.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 5,
      storagePath
    });

    const resBefore = await app.inject({ method: 'GET', url: `/topics/${topic.id}` });
    expect(resBefore.statusCode).toBe(200);

    store.moveTopic({
      topicId: topic.id,
      toForumId: forumAdmin.id,
      movedBy: admin.id,
      markerBody: 'Automatic post: moved.'
    });

    const resAfterAnon = await app.inject({ method: 'GET', url: `/topics/${topic.id}` });
    expect(resAfterAnon.statusCode).toBe(404);

    const resAttachAfterAnon = await app.inject({ method: 'GET', url: `/attachments/${attachment.id}` });
    expect(resAttachAfterAnon.statusCode).toBe(404);

    const resAfterAdmin = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(resAfterAdmin.statusCode).toBe(200);
  });
});
