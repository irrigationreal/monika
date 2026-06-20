import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentTypeForPath, resolveRobotAttachmentPath } from '../utils/attachments';

import type { FastifyInstance } from 'fastify';

import type { EchsClient } from '../echsClient';
import type { ModelCatalogSnapshot } from '../modelCatalog';
import type { AccessHelpers } from '../utils/access';

export function registerSystemRoutes({
  app,
  modelCatalog,
  echsClient,
  access,
  deploymentStatus,
}: {
  app: FastifyInstance;
  modelCatalog?: { listModels: () => Promise<ModelCatalogSnapshot> } | null;
  echsClient?: EchsClient | null;
  access?: Pick<AccessHelpers, 'getCurrentUser' | 'requireScope' | 'requireTopicVisible'> | null;
  deploymentStatus?: (() => unknown) | null;
}): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const openApiSpecPath = join(repoRoot, 'docs', 'openapi.json');
  const postmanCollectionPath = join(repoRoot, 'docs', 'postman', 'codex-forum.postman_collection.json');
  const buildInfoPath = join(repoRoot, 'build-info.json');

  let cachedOpenApi: unknown | null = null;
  let cachedPostmanCollection: unknown | null = null;
  let cachedBuildInfo: unknown | null | undefined;

  function defaultBuildInfo(): unknown {
    return { commit: null, source: null, date: null, label: 'local build' };
  }

  function loadJsonFile(path: string): unknown | null {
    try {
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch (err) {
      app.log.error({ err, path }, 'Failed to load JSON file');
      return null;
    }
  }

  app.get('/robot-attachments', async (request, reply) => {
    const query = request.query as { path?: string; name?: string; topicId?: string };
    const pathParam = query.path?.toString() ?? '';
    if (!pathParam) {
      throw app.httpErrors.badRequest('path is required');
    }

    const topicId = query.topicId?.toString() ?? '';
    if (!topicId) {
      throw app.httpErrors.badRequest('topicId is required');
    }
    if (!access?.requireTopicVisible) {
      throw app.httpErrors.internalServerError('access helpers not available');
    }
    // Always enforce topic visibility. This protects against blind file path
    // guessing for private topics.
    access.requireTopicVisible(topicId, request);

    const resolvedPath = resolveRobotAttachmentPath(pathParam);
    if (!resolvedPath) {
      throw app.httpErrors.forbidden('invalid attachment path');
    }
    if (!existsSync(resolvedPath)) {
      throw app.httpErrors.notFound('attachment file not found');
    }
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) {
      throw app.httpErrors.notFound('attachment file not found');
    }
    const rawName = query.name?.toString() || resolvedPath.split('/').pop() || 'attachment';
    const safeName = rawName.replace(/[\r\n"]/g, '');
    reply.header('Content-Type', contentTypeForPath(resolvedPath));
    reply.header('Content-Disposition', `inline; filename="${safeName}"`);
    return reply.send(createReadStream(resolvedPath));
  });

  app.get('/healthz', async () => {
    const echs = echsClient ? await echsClient.checkHealth() : undefined;
    cachedBuildInfo ??= loadJsonFile(buildInfoPath) ?? defaultBuildInfo();
    return {
      ok: true,
      echs: echs ?? { status: 'unreachable' },
      deployment: deploymentStatus?.() ?? null,
      build: cachedBuildInfo,
    };
  });

  app.get('/build', async () => {
    cachedBuildInfo ??= loadJsonFile(buildInfoPath) ?? defaultBuildInfo();
    return cachedBuildInfo;
  });

  app.get('/deploy/quiescence', async () => {
    return deploymentStatus?.() ?? { safeToStop: true, blockers: [] };
  });

  app.get('/models', async () => {
    if (!modelCatalog) {
      return { items: [], updatedAt: new Date().toISOString() };
    }
    return modelCatalog.listModels();
  });

  app.get('/openapi.json', async (request, reply) => {
    if (!access?.getCurrentUser || !access.requireScope) {
      throw app.httpErrors.internalServerError('access helpers not available');
    }
    access.requireScope(access.getCurrentUser(request), 'read');
    cachedOpenApi ??= loadJsonFile(openApiSpecPath);
    if (!cachedOpenApi) {
      throw app.httpErrors.notFound('OpenAPI spec not found');
    }
    reply.header('Cache-Control', 'public, max-age=60');
    return cachedOpenApi;
  });

  app.get('/postman/collection.json', async (request, reply) => {
    if (!access?.getCurrentUser || !access.requireScope) {
      throw app.httpErrors.internalServerError('access helpers not available');
    }
    access.requireScope(access.getCurrentUser(request), 'read');
    cachedPostmanCollection ??= loadJsonFile(postmanCollectionPath);
    if (!cachedPostmanCollection) {
      throw app.httpErrors.notFound('Postman collection not found');
    }
    reply.header('Cache-Control', 'public, max-age=60');
    return cachedPostmanCollection;
  });

  app.get('/docs', async (_request, reply) => {
    return reply.redirect('/docs/api');
  });
}
