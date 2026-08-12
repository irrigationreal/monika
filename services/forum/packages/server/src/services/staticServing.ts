import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';

import type { FastifyInstance } from 'fastify';

export interface StaticServingOptions {
  avatarsDir: string;
  publicDir: string;
  apiPrefix: string;
}

function requestPathname(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://forum.local').pathname;
  } catch {
    pathname = rawUrl.split(/[?#]/u, 1)[0] ?? '';
  }

  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function normalizeApiPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || /^\/+$/u.test(trimmed)) return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, '');
}

export function isApiRequestUrl(rawUrl: string, apiPrefix: string): boolean {
  const normalizedPrefix = normalizeApiPrefix(apiPrefix);
  if (!normalizedPrefix) return false;
  const pathname = requestPathname(rawUrl);
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

export async function registerStaticAssets(
  app: FastifyInstance,
  options: Pick<StaticServingOptions, 'avatarsDir' | 'publicDir'>
): Promise<string> {
  await app.register(fastifyStatic, {
    root: options.avatarsDir,
    prefix: '/uploads/avatars/',
    decorateReply: false,
    dotfiles: 'deny',
  });

  const publicIndex = join(options.publicDir, 'index.html');
  if (existsSync(options.publicDir)) {
    await app.register(fastifyStatic, {
      root: options.publicDir,
      prefix: '/',
      decorateReply: false,
      dotfiles: 'deny',
    });
  }
  return publicIndex;
}

export function registerSpaFallback(
  app: FastifyInstance,
  options: Pick<StaticServingOptions, 'apiPrefix'> & { publicIndex: string }
): void {
  app.setNotFoundHandler((request, reply) => {
    const wantsHtml = request.headers.accept?.includes('text/html') ?? false;
    const isApi = isApiRequestUrl(request.url, options.apiPrefix);
    if (request.method === 'GET' && wantsHtml && !isApi && existsSync(options.publicIndex)) {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(readFileSync(options.publicIndex, 'utf8'));
    }
    return reply.status(404).send({ code: 'not_found', message: 'Not Found' });
  });
}
