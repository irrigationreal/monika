import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isApiRequestUrl, normalizeApiPrefix, registerSpaFallback, registerStaticAssets } from './staticServing';

import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

const API_PREFIX = '/internal/api';
const AVATAR_CONTENT = 'PNG_CONTENT';
const FRONTEND_CONTENT = '<!doctype html><title>Forum frontend</title>';
const ASSET_CONTENT = 'FRONTEND_ASSET';
const SECRET_CONTENT = 'TOP_SECRET';

interface RawResponse {
  statusCode: number;
  body: string;
}

describe('@fastify/static security regression', () => {
  let tmpRoot: string;
  let avatarDir: string;
  let publicDir: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'forum-static-security-'));
    avatarDir = join(tmpRoot, 'avatars');
    publicDir = join(tmpRoot, 'public');
    mkdirSync(avatarDir);
    mkdirSync(join(publicDir, 'assets'), { recursive: true });
    writeFileSync(join(avatarDir, 'ok.png'), AVATAR_CONTENT);
    writeFileSync(join(avatarDir, '.hidden'), SECRET_CONTENT);
    writeFileSync(join(publicDir, 'index.html'), FRONTEND_CONTENT);
    writeFileSync(join(publicDir, '.env'), SECRET_CONTENT);
    writeFileSync(join(publicDir, 'assets', 'app.js'), ASSET_CONTENT);
    writeFileSync(join(tmpRoot, 'secret.txt'), SECRET_CONTENT);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function buildApp(apiPrefix = API_PREFIX): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    apps.push(app);
    const publicIndex = await registerStaticAssets(app, { avatarsDir: avatarDir, publicDir });
    registerSpaFallback(app, { apiPrefix, publicIndex });
    await app.ready();
    return app;
  }

  async function rawGet(app: FastifyInstance, path: string): Promise<RawResponse> {
    if (!app.server.listening) {
      await app.listen({ host: '127.0.0.1', port: 0 });
    }
    const address = app.server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          method: 'GET',
          path,
          headers: { accept: 'application/octet-stream' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      request.on('error', reject);
      request.end();
    });
  }

  it.each([
    ['/uploads/avatars/ok.png', AVATAR_CONTENT],
    ['/assets/app.js', ASSET_CONTENT],
  ])('serves the intended static file at %s', async (url, expectedBody) => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(expectedBody);
  });

  it.each(['/uploads/avatars/.hidden', '/.env'])(
    'denies hidden files under the public static roots: %s',
    async (url) => {
      const app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { accept: 'application/octet-stream' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(SECRET_CONTENT);
    }
  );

  it('rejects a non-leading dot-segment route over raw HTTP', async () => {
    const app = await buildApp();

    // Raw HTTP is intentional: Fastify injection and WHATWG clients normalize
    // this path before routing. @fastify/static 9 served the asset with 200;
    // v10.1.2 rejects the same wire path before it can bypass route guards.
    const response = await rawGet(app, '/foo/../assets/app.js');

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(ASSET_CONTENT);
  });

  it.each([
    '/uploads/avatars/%2e%2e%2fsecret.txt',
    '/uploads/avatars/%252e%252e%252fsecret.txt',
    '/uploads/avatars/..%5csecret.txt',
    '/uploads/avatars/ok.png%00.html',
    '/uploads%2favatars%2f..%2fsecret.txt',
    '/secret.txt',
  ])('does not serve content outside the configured static roots: %s', async (url) => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'application/octet-stream' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.body).not.toContain(SECRET_CONTENT);
    expect(response.body).not.toContain(AVATAR_CONTENT);
    expect(response.body).not.toContain(ASSET_CONTENT);
  });

  it.each(['/uploads/avatars/missing.png', '/assets/missing.js'])(
    'returns 404 for missing static file %s',
    async (url) => {
      const app = await buildApp();
      const response = await app.inject({ method: 'GET', url, headers: { accept: '*/*' } });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(FRONTEND_CONTENT);
    }
  );

  it('serves the frontend only as an HTML navigation fallback', async () => {
    const app = await buildApp();

    const navigation = await app.inject({
      method: 'GET',
      url: '/topics/example',
      headers: { accept: 'text/html' },
    });
    const nonNavigation = await app.inject({
      method: 'GET',
      url: '/topics/example',
      headers: { accept: 'application/json' },
    });
    const nonGetNavigation = await app.inject({
      method: 'POST',
      url: '/topics/example',
      headers: { accept: 'text/html' },
    });

    expect(navigation.statusCode).toBe(200);
    expect(navigation.headers['content-type']).toContain('text/html');
    expect(navigation.body).toBe(FRONTEND_CONTENT);
    expect(nonNavigation.statusCode).toBe(404);
    expect(nonGetNavigation.statusCode).toBe(404);
  });

  it.each([
    '/internal/api?view=summary',
    '/internal/api/missing?view=summary',
    '/%69nternal/%61pi/missing?view=summary',
    '/internal%2Fapi/missing?view=summary',
  ])('does not apply the SPA fallback to configurable API pathname %s', async (url) => {
    const app = await buildApp(API_PREFIX);
    const response = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(FRONTEND_CONTENT);
  });

  it('does not apply the SPA fallback when a non-default API prefix has a trailing slash', async () => {
    const app = await buildApp(`${API_PREFIX}/`);
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/missing?view=summary`,
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(FRONTEND_CONTENT);
  });
});

describe('API prefix handling', () => {
  it('normalizes leading and trailing slashes', () => {
    expect(normalizeApiPrefix(' internal/api/ ')).toBe(API_PREFIX);
    expect(normalizeApiPrefix(`${API_PREFIX}//`)).toBe(API_PREFIX);
    expect(normalizeApiPrefix('/')).toBe('');
  });

  it('classifies query strings and encoded pathname segments using a non-default prefix', () => {
    expect(isApiRequestUrl('/internal/api?view=summary', API_PREFIX)).toBe(true);
    expect(isApiRequestUrl('/%69nternal/%61pi/messages', API_PREFIX)).toBe(true);
    expect(isApiRequestUrl('/internal%2Fapi/messages', API_PREFIX)).toBe(true);
    expect(isApiRequestUrl('/internal/api/messages', `${API_PREFIX}/`)).toBe(true);
    expect(isApiRequestUrl('/topics/internal/api', API_PREFIX)).toBe(false);
  });
});
