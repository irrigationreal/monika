import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeploymentAdmissionCancelResponseDtoSchema,
  DeploymentAdmissionResultDtoSchema,
  DeploymentAdmissionStatusDtoSchema,
} from '@irrigationreal/codex-forum-contracts';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';
import { registerSystemRoutes } from './systemRoutes';

describe('System route access controls', () => {
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

  async function buildApp(opts: { deployToken?: string | null; ready?: boolean } = {}) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const modelCatalog = {
      listModels: vi.fn(async () => ({
        items: [{ id: 'codex/gpt-5.6-sol', family: 'codex', label: 'GPT 5.6 Sol' }],
        updatedAt: '2026-06-20T00:00:00.000Z',
      })),
    };
    const deploymentAdmission = {
      acquire: vi.fn(async ({ operationId }: { operationId: string }) => ({
        acquired: true,
        operationId,
        state: 'acquired' as const,
        blockers: [],
        expiresAt: '2026-06-20T00:01:00.000Z',
      })),
      cancel: vi.fn((operationId: string) => ({ ok: true as const, released: true, operationId })),
      getStatus: vi.fn(() => ({ state: 'idle' as const, operationId: null, expiresAt: null })),
    };
    registerSystemRoutes({
      app,
      access,
      modelCatalog,
      deploymentAdmission,
      deployToken: 'deployToken' in opts ? opts.deployToken : 'deploy-secret',
      readiness: async () => opts.ready ?? true,
      deploymentStatus: () => ({
        safeToStop: false,
        blockers: [{ code: 'active_robot_turns', count: 1 }],
        robot: { activeTurns: 1, queuedTurns: 0 },
        piSessionSync: { enabled: true, running: false, intervalMs: 60000 },
      }),
    });
    await app.ready();
    return { app, modelCatalog, deploymentAdmission };
  }

  it('keeps public health minimal', async () => {
    const { app } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body).not.toContain('deployment');
    expect(res.body).not.toContain('echs');
  });

  it('reports minimal backend readiness without exposing diagnostics', async () => {
    const readyApp = await buildApp({ ready: true });
    const ready = await readyApp.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true });

    const unavailableApp = await buildApp({ ready: false });
    const unavailable = await unavailableApp.app.inject({ method: 'GET', url: '/readyz' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ ok: false });
  });

  it('keeps public build metadata limited to client-safe fields', async () => {
    const { app } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/build' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['commit', 'date', 'label', 'source']);
  });

  it('does not expose the retired filesystem-path robot attachment route', async () => {
    const { app } = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/robot-attachments?topicId=public-topic&path=private-output.txt',
    });

    expect(res.statusCode).toBe(404);
  });

  it('requires a deploy token for deploy quiescence', async () => {
    const { app } = await buildApp();

    const guestRes = await app.inject({ method: 'GET', url: '/deploy/quiescence' });
    expect(guestRes.statusCode).toBe(401);

    const badRes = await app.inject({
      method: 'GET',
      url: '/deploy/quiescence',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(badRes.statusCode).toBe(403);

    const goodRes = await app.inject({
      method: 'GET',
      url: '/deploy/quiescence',
      headers: { authorization: 'Bearer deploy-secret' },
    });
    expect(goodRes.statusCode).toBe(200);
    expect(goodRes.json()).toMatchObject({ safeToStop: false, robot: { activeTurns: 1, queuedTurns: 0 } });
  });

  it('requires the deploy token for admission acquire and cancel', async () => {
    const { app, deploymentAdmission } = await buildApp();
    const payload = { operationId: 'deploy-auth', waitTimeoutMs: 1000, leaseMs: 60_000 };

    const guest = await app.inject({ method: 'POST', url: '/deploy/admission/acquire', payload });
    expect(guest.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/deploy/admission/acquire',
      headers: { authorization: 'Bearer wrong' },
      payload,
    });
    expect(bad.statusCode).toBe(403);
    const acquired = await app.inject({
      method: 'POST',
      url: '/deploy/admission/acquire',
      headers: { 'x-deploy-token': 'deploy-secret' },
      payload,
    });
    expect(acquired.statusCode).toBe(200);
    expect(DeploymentAdmissionResultDtoSchema.parse(acquired.json())).toEqual({
      acquired: true,
      operationId: 'deploy-auth',
      state: 'acquired',
      blockers: [],
      expiresAt: '2026-06-20T00:01:00.000Z',
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/deploy/admission/cancel',
      headers: { authorization: 'Bearer deploy-secret' },
      payload: { operationId: 'deploy-auth' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(DeploymentAdmissionCancelResponseDtoSchema.parse(cancelled.json())).toEqual({
      ok: true,
      released: true,
      operationId: 'deploy-auth',
    });
    expect(deploymentAdmission.cancel).toHaveBeenCalledWith('deploy-auth');

    const status = await app.inject({
      method: 'GET',
      url: '/deploy/admission',
      headers: { authorization: 'Bearer deploy-secret' },
    });
    expect(status.statusCode).toBe(200);
    expect(DeploymentAdmissionStatusDtoSchema.parse(status.json())).toEqual({
      state: 'idle',
      operationId: null,
      expiresAt: null,
    });
  });

  it('rejects a zero admission wait timeout at the contracts boundary', async () => {
    const { app, deploymentAdmission } = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/deploy/admission/acquire',
      headers: { authorization: 'Bearer deploy-secret' },
      payload: { operationId: 'deploy-zero', waitTimeoutMs: 0, leaseMs: 60_000 },
    });

    expect(response.statusCode).toBe(400);
    expect(deploymentAdmission.acquire).not.toHaveBeenCalled();
  });

  it('fails deploy quiescence closed when the deploy token is not configured', async () => {
    const { app } = await buildApp({ deployToken: null });

    const res = await app.inject({
      method: 'GET',
      url: '/deploy/quiescence',
      headers: { authorization: 'Bearer deploy-secret' },
    });

    expect(res.statusCode).toBe(503);
  });

  it('requires authenticated read access for model catalog', async () => {
    const { app, modelCatalog } = await buildApp();
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('human-token', human.id);

    const guestRes = await app.inject({ method: 'GET', url: '/models' });
    expect(guestRes.statusCode).toBe(401);
    expect(modelCatalog.listModels).not.toHaveBeenCalled();

    const humanRes = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: 'Bearer human-token' },
    });
    expect(humanRes.statusCode).toBe(200);
    expect(humanRes.json()).toMatchObject({ items: [{ id: 'codex/gpt-5.6-sol' }] });
  });

  it('requires authentication for API documentation assets', async () => {
    const { app } = await buildApp();
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('member-token', member.id);

    for (const url of ['/openapi.json', '/postman/collection.json']) {
      const guestRes = await app.inject({ method: 'GET', url });
      expect(guestRes.statusCode).toBe(401);

      const memberRes = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer member-token' },
      });
      expect(memberRes.statusCode).toBe(200);
    }
  });
});
