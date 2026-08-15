import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { generateTtsMp3 } from '../tts';
import { createAccessHelpers } from '../utils/access';
import { registerAttachmentRoutes } from './attachmentRoutes';

const { uploadsDir } = vi.hoisted(() => ({
  uploadsDir: `/tmp/codex-tts-repair-${crypto.randomUUID()}`,
}));

vi.mock('../runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimeConfig')>();
  return {
    ...actual,
    TTS_AVAILABLE: true,
    TTS_SCRIPT: '/mock/tts',
    UPLOADS_DIR: uploadsDir,
  };
});

vi.mock('../tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts')>();
  return {
    ...actual,
    generateTtsMp3: vi.fn(async (opts: { outPath: string }) => {
      mkdirSync(dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, 'mock-audio');
      return { ok: true };
    }),
  };
});

describe('TTS attachment repair', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    rmSync(uploadsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    db.close();
    rmSync(uploadsDir, { recursive: true, force: true });
    vi.mocked(generateTtsMp3).mockClear();
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    registerAttachmentRoutes({ app, store, access: createAccessHelpers(app, store) });
    await app.ready();
    return app;
  }

  it('regenerates missing bytes and reuses the shared TTS blob and association', async () => {
    const app = await buildApp();
    const robot = store.createIdentity('Robot', 'robot');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const { post } = store.createTopic({
      forumId: forum.id,
      title: 'TTS',
      body: 'Read this aloud',
      authorId: robot.id,
    });

    const first = await app.inject({ method: 'POST', url: `/posts/${post.id}/tts` });
    expect(first.statusCode).toBe(200);
    const attachmentId = (first.json() as { id: string }).id;
    const originalBlob = store.getAttachmentBlob(attachmentId)!;
    expect(existsSync(originalBlob.storage_path)).toBe(true);

    unlinkSync(originalBlob.storage_path);
    store.markBlobMissing(originalBlob.id);
    const repaired = await app.inject({ method: 'POST', url: `/posts/${post.id}/tts` });
    expect(repaired.statusCode).toBe(200);
    expect((repaired.json() as { id: string }).id).toBe(attachmentId);
    expect(store.getAttachmentBlob(attachmentId)).toMatchObject({ id: originalBlob.id, state: 'ready' });
    expect(existsSync(originalBlob.storage_path)).toBe(true);
    expect(vi.mocked(generateTtsMp3)).toHaveBeenCalledTimes(2);

    const download = await app.inject({ method: 'GET', url: `/attachments/${attachmentId}` });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('mock-audio');
    await app.close();
  });
});
