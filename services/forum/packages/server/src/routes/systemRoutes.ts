import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DeploymentAdmissionAcquireRequestSchema,
  DeploymentAdmissionCancelRequestSchema,
} from '@irrigationreal/codex-forum-contracts';

import {
  mapDeploymentAdmissionCancelResponseToDto,
  mapDeploymentAdmissionResultToDto,
  mapDeploymentAdmissionStatusToDto,
} from '../mappers/dto';
import { DEPLOY_TOKEN } from '../runtimeConfig';
import { parseBody } from '../utils/validation';

import type { FastifyInstance } from 'fastify';

import type { ModelCatalogSnapshot } from '../modelCatalog';
import type { DeploymentAdmissionCoordinator } from '../services/deploymentAdmissionCoordinator';
import type { AccessHelpers } from '../utils/access';

type HeaderRequest = { headers: Record<string, string | string[] | undefined> };
type JsonObject = Record<string, unknown>;

export async function sendReadiness(
  readiness: (() => Promise<boolean>) | null | undefined,
  reply: { code(statusCode: number): unknown }
): Promise<{ ok: boolean }> {
  const ready = readiness ? await readiness().catch(() => false) : true;
  reply.code(ready ? 200 : 503);
  return { ok: ready };
}

export function registerSystemRoutes({
  app,
  modelCatalog,
  access,
  deploymentStatus,
  deploymentAdmission,
  readiness,
  deployToken = DEPLOY_TOKEN,
}: {
  app: FastifyInstance;
  modelCatalog?: { listModels: () => Promise<ModelCatalogSnapshot> } | null;
  access?: Pick<AccessHelpers, 'getCurrentUser' | 'requireScope'> | null;
  deploymentStatus?: (() => unknown) | null;
  deploymentAdmission?: Pick<DeploymentAdmissionCoordinator, 'acquire' | 'cancel' | 'getStatus'> | null;
  readiness?: (() => Promise<boolean>) | null;
  deployToken?: string | null;
}): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const openApiSpecPath = join(repoRoot, 'docs', 'openapi.json');
  const postmanCollectionPath = join(repoRoot, 'docs', 'postman', 'codex-forum.postman_collection.json');
  const buildInfoPath = join(repoRoot, 'build-info.json');

  let cachedOpenApi: JsonObject | null = null;
  let cachedPostmanCollection: JsonObject | null = null;
  let cachedBuildInfo: JsonObject | null = null;

  function defaultBuildInfo(): JsonObject {
    return { commit: null, source: null, date: null, label: 'local build' };
  }

  function loadJsonFile(path: string): JsonObject | null {
    try {
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
    } catch (err) {
      app.log.error({ err, path }, 'Failed to load JSON file');
      return null;
    }
  }

  function publicBuildInfo(): JsonObject {
    const info = cachedBuildInfo ?? defaultBuildInfo();
    return {
      label: typeof info['label'] === 'string' ? info['label'] : 'local build',
      commit: typeof info['commit'] === 'string' ? info['commit'] : null,
      source: typeof info['source'] === 'string' ? info['source'] : null,
      date: typeof info['date'] === 'string' ? info['date'] : null,
    };
  }

  function requireRead(request: Parameters<AccessHelpers['getCurrentUser']>[0]): void {
    if (!access) {
      throw app.httpErrors.internalServerError('access helpers not available');
    }
    access.requireScope(access.getCurrentUser(request), 'read');
  }

  function requestDeployToken(request: HeaderRequest): string | null {
    const deployHeader = request.headers['x-deploy-token'];
    if (typeof deployHeader === 'string' && deployHeader.trim()) return deployHeader.trim();

    const authHeader = request.headers['authorization'];
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof authValue === 'string' && authValue.startsWith('Bearer ')) {
      const token = authValue.slice('Bearer '.length).trim();
      return token ? token : null;
    }
    return null;
  }

  function tokensEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(actualBuffer, expectedBuffer);
  }

  function requireDeployToken(request: HeaderRequest): void {
    if (!deployToken) {
      throw app.httpErrors.serviceUnavailable('Deploy token is not configured');
    }
    const token = requestDeployToken(request);
    if (!token) {
      throw app.httpErrors.unauthorized('Deploy token required');
    }
    if (!tokensEqual(token, deployToken)) {
      throw app.httpErrors.forbidden('Invalid deploy token');
    }
  }

  app.get('/healthz', () => {
    return { ok: true };
  });

  app.get('/readyz', async (_request, reply) => sendReadiness(readiness, reply));

  app.get('/build', () => {
    cachedBuildInfo ??= loadJsonFile(buildInfoPath) ?? defaultBuildInfo();
    return publicBuildInfo();
  });

  app.get('/deploy/quiescence', (request) => {
    requireDeployToken(request);
    return deploymentStatus?.() ?? { safeToStop: true, blockers: [] };
  });

  app.post('/deploy/admission/acquire', async (request, reply) => {
    requireDeployToken(request);
    if (!deploymentAdmission) throw app.httpErrors.serviceUnavailable('Deployment admission is unavailable');
    const body = parseBody(app, DeploymentAdmissionAcquireRequestSchema, request.body);
    try {
      const result = await deploymentAdmission.acquire(body);
      if (!result.acquired) reply.code(409);
      return mapDeploymentAdmissionResultToDto(result);
    } catch (error) {
      if (error instanceof RangeError) throw app.httpErrors.badRequest(error.message);
      throw error;
    }
  });

  app.post('/deploy/admission/cancel', (request) => {
    requireDeployToken(request);
    if (!deploymentAdmission) throw app.httpErrors.serviceUnavailable('Deployment admission is unavailable');
    const body = parseBody(app, DeploymentAdmissionCancelRequestSchema, request.body);
    try {
      return mapDeploymentAdmissionCancelResponseToDto(deploymentAdmission.cancel(body.operationId));
    } catch (error) {
      if (error instanceof RangeError) throw app.httpErrors.badRequest(error.message);
      throw error;
    }
  });

  app.get('/deploy/admission', (request) => {
    requireDeployToken(request);
    if (!deploymentAdmission) throw app.httpErrors.serviceUnavailable('Deployment admission is unavailable');
    return mapDeploymentAdmissionStatusToDto(deploymentAdmission.getStatus());
  });

  app.get('/models', async (request) => {
    requireRead(request);
    if (!modelCatalog) {
      return { items: [], updatedAt: new Date().toISOString() };
    }
    return modelCatalog.listModels();
  });

  app.get('/openapi.json', (request, reply) => {
    requireRead(request);
    cachedOpenApi ??= loadJsonFile(openApiSpecPath);
    if (!cachedOpenApi) {
      throw app.httpErrors.notFound('OpenAPI spec not found');
    }
    reply.header('Cache-Control', 'public, max-age=60');
    return cachedOpenApi;
  });

  app.get('/postman/collection.json', (request, reply) => {
    requireRead(request);
    cachedPostmanCollection ??= loadJsonFile(postmanCollectionPath);
    if (!cachedPostmanCollection) {
      throw app.httpErrors.notFound('Postman collection not found');
    }
    reply.header('Cache-Control', 'public, max-age=60');
    return cachedPostmanCollection;
  });

  app.get('/docs', (_request, reply) => {
    return reply.redirect('/docs/api');
  });
}
