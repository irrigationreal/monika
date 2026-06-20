import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function multipartFileBody(filename: string, content: string): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----codex-forum-test-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: text/plain',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8'
  );
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  };
}

async function buildApp(internalToken: string | null) {
  vi.resetModules();
  vi.unstubAllEnvs();

  const uploadsDir = mkdtempSync(join(tmpdir(), 'codex-forum-pending-attachments-'));
  vi.stubEnv('CODEX_FORUM_UPLOADS_DIR', uploadsDir);
  vi.stubEnv('CODEX_FORUM_INTERNAL_API_TOKEN', internalToken ?? '');

  const [{ default: Fastify }, { default: sensible }, { default: multipart }, { default: Database }, { migrate }, { ForumStore }, { createAccessHelpers }, { registerAttachmentRoutes }] =
    await Promise.all([
      import('fastify'),
      import('@fastify/sensible'),
      import('@fastify/multipart'),
      import('better-sqlite3'),
      import('../db'),
      import('../store'),
      import('../utils/access'),
      import('./attachmentRoutes'),
    ]);

  const db = new Database(':memory:');
  migrate(db);
  const store = new ForumStore(db);
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 250 * 1024 * 1024 } });
  const access = createAccessHelpers(app, store);
  registerAttachmentRoutes({ app, store, access });
  await app.ready();

  return { app, db, store, uploadsDir };
}

async function closeHarness(harness: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.uploadsDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
}

describe('agent pending attachment route', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('fails closed when the internal API token is not configured', async () => {
    const harness = await buildApp(null);
    try {
      const forum = harness.store.createForum('Forum', null, null, null, null, 'active', 'public');
      const author = harness.store.createIdentity('Author', 'human');
      const { topic } = harness.store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });
      const file = multipartFileBody('hello.txt', 'hello');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/agent/topics/${topic.id}/pending-attachments`,
        headers: file.headers,
        payload: file.body,
      });

      expect(res.statusCode).toBe(503);
      const row = harness.db.prepare('select count(*) as count from pending_attachments').get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      await closeHarness(harness);
    }
  });

  it('rejects missing or wrong internal API tokens', async () => {
    const harness = await buildApp('secret-token');
    try {
      const forum = harness.store.createForum('Forum', null, null, null, null, 'active', 'public');
      const author = harness.store.createIdentity('Author', 'human');
      const { topic } = harness.store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

      for (const headers of [{}, { 'x-internal-token': 'wrong' }, { authorization: 'Bearer wrong' }]) {
        const file = multipartFileBody('hello.txt', 'hello');
        const res = await harness.app.inject({
          method: 'POST',
          url: `/agent/topics/${topic.id}/pending-attachments`,
          headers: { ...file.headers, ...headers },
          payload: file.body,
        });
        expect(res.statusCode).toBe(401);
      }

      const row = harness.db.prepare('select count(*) as count from pending_attachments').get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      await closeHarness(harness);
    }
  });

  it('accepts the preferred x-internal-token header', async () => {
    const harness = await buildApp('secret-token');
    try {
      const forum = harness.store.createForum('Forum', null, null, null, null, 'active', 'public');
      const author = harness.store.createIdentity('Author', 'human');
      const { topic } = harness.store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });
      const file = multipartFileBody('hello.txt', 'hello');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/agent/topics/${topic.id}/pending-attachments`,
        headers: { ...file.headers, 'x-internal-token': 'secret-token' },
        payload: file.body,
      });

      expect(res.statusCode).toBe(200);
      const parsed = res.json() as { id: string; reference: string; filename: string; sha256: string };
      expect(parsed.filename).toBe('hello.txt');
      expect(parsed.reference).toBe(`[forum-attachment id="${parsed.id}"]`);
      expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(harness.store.getPendingAttachment(parsed.id)).not.toBeNull();
    } finally {
      await closeHarness(harness);
    }
  });

  it('keeps Authorization Bearer compatibility for existing internal callers', async () => {
    const harness = await buildApp('secret-token');
    try {
      const forum = harness.store.createForum('Forum', null, null, null, null, 'active', 'public');
      const author = harness.store.createIdentity('Author', 'human');
      const { topic } = harness.store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });
      const file = multipartFileBody('hello.txt', 'hello');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/agent/topics/${topic.id}/pending-attachments`,
        headers: { ...file.headers, authorization: 'Bearer secret-token' },
        payload: file.body,
      });

      expect(res.statusCode).toBe(200);
      const parsed = res.json() as { id: string };
      expect(harness.store.getPendingAttachment(parsed.id)).not.toBeNull();
    } finally {
      await closeHarness(harness);
    }
  });
});
