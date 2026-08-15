import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { USER_FILES_DIR } from '../runtimeConfig';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerAttachmentRoutes } from './attachmentRoutes';

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
    await app.register(multipart, { limits: { fileSize: 250 * 1024 * 1024 } });
    const access = createAccessHelpers(app, store);
    registerAttachmentRoutes({ app, store, access });
    await app.ready();
    return app;
  }

  it('serves standalone files according to private, members, and public visibility', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'visibility-owner', 'pw-hash', 'human');
    const member = store.createIdentityWithPassword('Member', 'visibility-member', 'pw-hash', 'human');
    store.createAuthSession('visibility-member-token', member.id);
    for (const visibility of ['members', 'public'] as const) {
      const path = join(USER_FILES_DIR, `${visibility}-${owner.id}.txt`);
      writeFileSync(path, visibility);
      const file = store.createUserFile({
        identityId: owner.id,
        filename: `${visibility}.txt`,
        mimeType: 'text/plain',
        sizeBytes: visibility.length,
        storagePath: path,
        sha256: `${visibility}-sha`,
        visibility,
        expiresAt: null,
      });
      const guest = await app.inject({ method: 'GET', url: `/user-files/${file.id}` });
      expect(guest.statusCode).toBe(visibility === 'public' ? 200 : 404);
      const signedIn = await app.inject({
        method: 'GET',
        url: `/user-files/${file.id}`,
        headers: { authorization: 'Bearer visibility-member-token' },
      });
      expect(signedIn.statusCode).toBe(200);
      unlinkSync(path);
    }
  });

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
      payload: { filename: 'file.txt', sizeBytes: 10 },
    });
    expect(otherStart.statusCode).toBe(403);

    const authorStart = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/attachments/chunked/start`,
      headers: { authorization: 'Bearer author-token' },
      payload: { filename: 'file.txt', sizeBytes: 10 },
    });
    expect(authorStart.statusCode).toBe(200);
  });

  it('lists topic attachments in one visibility-checked response', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'members');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    const { post: firstPost } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'starter',
      authorId: author.id,
    });
    const secondPost = store.createPost({ topicId: firstPost.topic_id, authorId: author.id, body: 'followup' });
    const attachment = store.createAttachment({
      postId: firstPost.id,
      filename: 'file.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      storagePath: '/tmp/file.txt',
    });

    const guest = await app.inject({ method: 'GET', url: `/topics/${firstPost.topic_id}/attachments` });
    expect(guest.statusCode).toBe(404);

    const member = await app.inject({
      method: 'GET',
      url: `/topics/${firstPost.topic_id}/attachments`,
      headers: { authorization: 'Bearer author-token' },
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toEqual({
      itemsByPostId: {
        [firstPost.id]: [
          expect.objectContaining({
            id: attachment.id,
            postId: firstPost.id,
            filename: 'file.txt',
          }),
        ],
        [secondPost.id]: [],
      },
    });
  });

  it('derives access from the union of live post associations', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'union-owner', 'pw-hash', 'human');
    const restricted = store.createForum('Restricted', null, null, null, null, 'active', 'admin');
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const restrictedPost = store.createTopic({
      forumId: restricted.id,
      title: 'Private',
      body: 'body',
      authorId: owner.id,
    }).post;
    const publicPost = store.createTopic({
      forumId: publicForum.id,
      title: 'Public',
      body: 'body',
      authorId: owner.id,
    }).post;
    const storagePath = join(USER_FILES_DIR, `union-${owner.id}.txt`);
    writeFileSync(storagePath, 'shared');
    const privateAssociation = store.createAttachment({
      postId: restrictedPost.id,
      filename: 'shared.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storagePath,
      sha256: 'union-sha',
      ownerIdentityId: owner.id,
    });
    const publicAssociation = store.createAttachment({
      postId: publicPost.id,
      filename: 'shared.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storagePath,
      sha256: 'union-sha',
      ownerIdentityId: owner.id,
    });
    expect((await app.inject({ method: 'GET', url: `/attachments/${privateAssociation.id}` })).statusCode).toBe(200);
    store.deleteAttachment(publicAssociation.id);
    expect((await app.inject({ method: 'GET', url: `/attachments/${privateAssociation.id}` })).statusCode).toBe(404);
    unlinkSync(storagePath);
  });

  it('paginates the owner library with opaque stable cursors', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'page-owner', 'pw-hash', 'human');
    store.createAuthSession('page-owner-token', owner.id);
    for (const [index, createdAt] of [
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ].entries()) {
      const path = join(USER_FILES_DIR, `page-${String(index)}`);
      writeFileSync(path, 'x');
      const file = store.createUserFile({
        identityId: owner.id,
        filename: `${String(index)}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 1,
        storagePath: path,
        sha256: `page-${String(index)}`,
      });
      db.prepare('update user_files set created_at = ?, updated_at = ? where id = ?').run(
        createdAt,
        createdAt,
        file.id
      );
    }
    const legacy = await app.inject({
      method: 'GET',
      url: '/user-files',
      headers: { authorization: 'Bearer page-owner-token' },
    });
    expect(legacy.statusCode).toBe(200);
    expect((legacy.json() as Array<{ filename: string }>).map((item) => item.filename)).toEqual([
      '0.txt',
      '1.txt',
      '2.txt',
    ]);

    const first = await app.inject({
      method: 'GET',
      url: '/user-files/page?limit=2',
      headers: { authorization: 'Bearer page-owner-token' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { items: Array<{ filename: string }>; nextCursor: string | null };
    expect(firstBody.items.map((item) => item.filename)).toEqual(['0.txt', '1.txt']);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await app.inject({
      method: 'GET',
      url: `/user-files/page?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      headers: { authorization: 'Bearer page-owner-token' },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { items: Array<{ filename: string }> }).items.map((item) => item.filename)).toEqual([
      '2.txt',
    ]);
    const malformed = await app.inject({
      method: 'GET',
      url: '/user-files/page?cursor=not-a-cursor',
      headers: { authorization: 'Bearer page-owner-token' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('uploads and deduplicates real multipart files, then patches visibility and retention', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'multipart-owner', 'pw-hash', 'human');
    store.createAuthSession('multipart-owner-token', owner.id);
    const boundary = '----codex-user-file-boundary';
    const multipartBody = (visibility?: string, expiration?: string, filename = 'actual.txt') =>
      Buffer.from(
        [
          `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\n${visibility ?? 'private'}\r\n`,
          `--${boundary}\r\nContent-Disposition: form-data; name="expiration"\r\n\r\n${expiration ?? 'one_month'}\r\n`,
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\nactual-bytes\r\n`,
          `--${boundary}--\r\n`,
        ].join('')
      );
    const upload = async (visibility?: string, expiration?: string, filename?: string) =>
      app.inject({
        method: 'POST',
        url: '/user-files',
        headers: {
          authorization: 'Bearer multipart-owner-token',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(visibility, expiration, filename),
      });
    const first = await upload();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const file = first.json() as {
      id: string;
      revision: number;
      visibility: string;
      expiresAt: string;
      deduplicated?: boolean;
    };
    expect(file.visibility).toBe('private');
    expect(Date.parse(file.expiresAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    const repeated = await upload('public', 'one_year', 'later-name.txt');
    expect(repeated.statusCode).toBe(200);
    expect((repeated.json() as { id: string; deduplicated?: boolean }).id).toBe(file.id);
    expect((repeated.json() as { filename: string }).filename).toBe('actual.txt');
    expect((repeated.json() as { deduplicated?: boolean }).deduplicated).toBe(true);
    const download = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer multipart-owner-token' },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('actual.txt');
    expect(download.headers['content-disposition']).not.toContain('later-name.txt');
    const repeatedBody = repeated.json() as { revision: number };
    const patch = await app.inject({
      method: 'PATCH',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer multipart-owner-token' },
      payload: { expectedRevision: repeatedBody.revision, visibility: 'members', expiration: 'six_months' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.headers['cache-control']).toBe('private, no-store');
    expect(patch.json()).toEqual(expect.objectContaining({ visibility: 'members', standalone: true }));
    const blob = store.getUserFileBlob(file.id);
    if (blob?.storage_path)
      try {
        unlinkSync(blob.storage_path);
      } catch {
        /* cleanup */
      }
  });

  it('does not treat impersonation credentials as owner-library authority', async () => {
    const app = await buildApp();
    const owner = store.createIdentityWithPassword('Owner', 'impersonated-owner', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    const token = 'impersonation-secret';
    const now = new Date().toISOString();
    db.prepare(
      `insert into impersonation_tokens
       (id, owner_identity_id, impersonated_identity_id, label, token_hash, token_prefix, scopes_json, created_at)
       values ('imp-file', ?, ?, 'files', ?, 'imp', '["read","write"]', ?)`
    ).run(admin.id, owner.id, createHash('sha256').update(token).digest('hex'), now);
    const storagePath = join(USER_FILES_DIR, `imp-${owner.id}`);
    writeFileSync(storagePath, 'private');
    const file = store.createUserFile({
      identityId: owner.id,
      filename: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: 7,
      storagePath,
      sha256: 'imp-private',
      visibility: 'private',
    });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/user-files', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/user-files/${file.id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/user-files/${file.id}`, headers })).statusCode).toBe(403);
    unlinkSync(storagePath);
  });

  it('keeps private user file downloads and mutations owner-only', async () => {
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
      storagePath,
    });

    const guestRes = await app.inject({ method: 'GET', url: `/user-files/${file.id}` });
    expect(guestRes.statusCode).toBe(404);

    const otherRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer other-token' },
    });
    expect(otherRes.statusCode).toBe(404);

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { cookie: 'cforum_session=owner-token' },
    });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.headers['cache-control']).toBe('private, no-store');
    expect(ownerRes.headers['x-content-type-options']).toBe('nosniff');
    expect(ownerRes.headers['content-disposition']).toContain('test-file.txt');

    const adminRes = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminRes.statusCode).toBe(404);

    const otherDelete = await app.inject({
      method: 'DELETE',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer other-token' },
    });
    expect(otherDelete.statusCode).toBe(404);

    const adminDelete = await app.inject({
      method: 'DELETE',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminDelete.statusCode).toBe(404);

    const ownerDelete = await app.inject({
      method: 'DELETE',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(ownerDelete.statusCode).toBe(200);
    const deletedDownload = await app.inject({
      method: 'GET',
      url: `/user-files/${file.id}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(deletedDownload.statusCode).toBe(404);

    if (storagePath && storagePath.includes(USER_FILES_DIR)) {
      try {
        unlinkSync(storagePath);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
