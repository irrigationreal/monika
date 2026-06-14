import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAttachmentRoutes } from './attachmentRoutes';
import { USER_FILES_DIR } from '../runtimeConfig';

describe('Attachment routes access controls', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    mkdirSync(USER_FILES_DIR, { recursive: true });
  });

  afterEach(() => {
    db.close();
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    registerAttachmentRoutes({ app, store, access });
    await app.ready();
    return app;
  }

  it('restricts chunked attachment uploads to the post author', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    store.createAuthSession('other-token', other.id);

    const { post } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

    const otherStart = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/attachments/chunked/start`,
      headers: { authorization: 'Bearer other-token' },
      payload: { filename: 'file.txt', sizeBytes: 10 }
    });
    expect(otherStart.statusCode).toBe(403);

    const authorStart = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/attachments/chunked/start`,
      headers: { authorization: 'Bearer author-token' },
      payload: { filename: 'file.txt', sizeBytes: 10 }
    });
    expect(authorStart.statusCode).toBe(200);
  });

  it('restricts user file downloads and deletes to owners/admins', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'owner', 'pw-hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('owner-token', owner.id);
    store.createAuthSession('other-token', other.id);
    store.createAuthSession('admin-token', admin.id);

    const storagePath = join(USER_FILES_DIR, 'test-file.txt');
    writeFileSync(storagePath, 'hello');
    const file = store.createUserFile({
      identityId: owner.id,
      filename: 'test-file.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      storagePath
    });

    const guestRes = await app.inject({ method: 'GET', url: `/user-files/${file.id}` });
    expect(guestRes.statusCode).toBe(401);

    const otherRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer other-token' }
    });
    expect(otherRes.statusCode).toBe(403);

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer owner-token' }
    });
    expect(ownerRes.statusCode).toBe(200);

    const adminRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminRes.statusCode).toBe(200);

    const otherDelete = await app.inject({
      method: 'DELETE',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer other-token' }
    });
    expect(otherDelete.statusCode).toBe(403);

    const adminDelete = await app.inject({
      method: 'DELETE',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer admin-token' }
    });
    expect(adminDelete.statusCode).toBe(200);

    if (storagePath && storagePath.includes(USER_FILES_DIR)) {
      try {
        unlinkSync(storagePath);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

