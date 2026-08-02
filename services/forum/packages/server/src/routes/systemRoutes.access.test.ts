import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  async function buildApp(opts: { deployToken?: string | null } = {}) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const modelCatalog = {
      listModels: vi.fn(async () => ({
        items: [{ id: 'codex/gpt-5.6-sol', family: 'codex', label: 'GPT 5.6 Sol' }],
        updatedAt: '2026-06-20T00:00:00.000Z'
      }))
    };
    registerSystemRoutes({
      app,
      access,
      modelCatalog,
      deployToken: 'deployToken' in opts ? opts.deployToken : 'deploy-secret',
      deploymentStatus: () => ({
        safeToStop: false,
        blockers: [{ code: 'active_robot_turns', count: 1 }],
        robot: { activeTurns: 1, queuedTurns: 0 },
        piSessionSync: { enabled: true, running: false, intervalMs: 60000 }
      })
    });
    await app.ready();
    return { app, modelCatalog };
  }

  it('keeps public health minimal', async () => {
    const { app } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body).not.toContain('deployment');
    expect(res.body).not.toContain('echs');
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
      url: '/robot-attachments?topicId=public-topic&path=private-output.txt'
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
      headers: { authorization: 'Bearer wrong' }
    });
    expect(badRes.statusCode).toBe(403);

    const goodRes = await app.inject({
      method: 'GET',
      url: '/deploy/quiescence',
      headers: { authorization: 'Bearer deploy-secret' }
    });
    expect(goodRes.statusCode).toBe(200);
    expect(goodRes.json()).toMatchObject({ safeToStop: false, robot: { activeTurns: 1, queuedTurns: 0 } });
  });

  it('fails deploy quiescence closed when the deploy token is not configured', async () => {
    const { app } = await buildApp({ deployToken: null });

    const res = await app.inject({
      method: 'GET',
      url: '/deploy/quiescence',
      headers: { authorization: 'Bearer deploy-secret' }
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
      headers: { authorization: 'Bearer human-token' }
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
        headers: { authorization: 'Bearer member-token' }
      });
      expect(memberRes.statusCode).toBe(200);
    }
  });
});
