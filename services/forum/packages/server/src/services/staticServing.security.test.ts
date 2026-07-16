import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

describe('@fastify/static security regression', () => {
  let tmpRoot: string;
  let avatarDir: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'forum-static-security-'));
    avatarDir = join(tmpRoot, 'avatars');
    mkdirSync(avatarDir);
    writeFileSync(join(avatarDir, 'ok.png'), 'PNG_CONTENT');
    writeFileSync(join(tmpRoot, 'secret.txt'), 'TOP_SECRET');
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(fastifyStatic, {
      root: avatarDir,
      prefix: '/uploads/avatars/',
      decorateReply: false,
    });
    await app.ready();
    return app;
  }

  async function expectRejected(url: string): Promise<void> {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('TOP_SECRET');
    expect(response.body).not.toContain('PNG_CONTENT');
  }

  it('serves a legitimate file under the configured prefix', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/uploads/avatars/ok.png' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('PNG_CONTENT');
  });

  it.each([
    ['/uploads/avatars/../secret.txt', 'dot-segment traversal'],
    ['/uploads/avatars/%2e%2e%2fsecret.txt', 'encoded traversal'],
    ['/uploads/avatars/%252e%252e%252fsecret.txt', 'double-encoded traversal'],
    ['/uploads/avatars/..%5csecret.txt', 'encoded backslash traversal'],
    ['/uploads/avatars/ok.png%00.html', 'null-byte suffix'],
    ['/uploads%2favatars%2f..%2fsecret.txt', 'encoded prefix bypass'],
    ['/secret.txt', 'request outside the static prefix'],
  ])('rejects %s (%s)', async (url) => {
    await expectRejected(url);
  });
});
