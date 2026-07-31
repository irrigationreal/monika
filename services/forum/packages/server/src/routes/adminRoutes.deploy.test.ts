import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { createAccessHelpers } from '../utils/access';

type SpawnedChild = {
  stdout?: PassThrough;
  stderr?: PassThrough;
  on: (event: string, cb: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  unref: () => void;
};

function createFakeChild(): SpawnedChild {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: (event: string, cb: (...args: any[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit: (event: string, ...args: any[]) => {
      const list = handlers.get(event) ?? [];
      for (const cb of list) cb(...args);
    },
    unref: () => {}
  };
}

describe('Admin deploy endpoints', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['CODEX_FORUM_DEPLOY_SCRIPT'];
    delete process.env['CODEX_FORUM_DEPLOY_LOG'];
    delete process.env['CODEX_FORUM_DEPLOY_STATE_FILE'];
    delete process.env['CODEX_FORUM_DEPLOY_WORKDIR'];
  });

  it('starts a manual deploy and marks running=true', async () => {
    const scriptPath = `/tmp/codex-forum-deploy-script-${Date.now()}.sh`;
    const logPath = `/tmp/codex-forum-deploy-log-${Date.now()}.log`;
    const stateFile = `/tmp/codex-forum-deploy-state-${Date.now()}.json`;
    await import('node:fs').then(({ writeFileSync, chmodSync }) => {
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\n', 'utf8');
      chmodSync(scriptPath, 0o755);
    });
    process.env['CODEX_FORUM_DEPLOY_SCRIPT'] = scriptPath;
    process.env['CODEX_FORUM_DEPLOY_LOG'] = logPath;
    process.env['CODEX_FORUM_DEPLOY_STATE_FILE'] = stateFile;

    const child = createFakeChild();
    const spawn = vi.fn(() => child);
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn };
    });

    const { registerAdminRoutes } = await import('./adminRoutes');

    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);

    const pauseActiveThreads = vi.fn(async () => ({ paused: 0, skipped: 0 }));
    const codex = {
      pauseActiveThreads,
      listActiveTurns: vi.fn(() => []),
      listQueuedTurns: vi.fn(() => [])
    } as any;

    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/admin/deploy',
      headers: { authorization: `Bearer ${token}` }
    });

    expect(res.statusCode).toBe(200);
    expect(pauseActiveThreads).toHaveBeenCalledWith('deploy:manual');
    expect(spawn).toHaveBeenCalledTimes(1);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/admin/deploy/status',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({ running: true });

    // Simulate the deploy completing.
    child.emit('close', 0);
    const statusRes2 = await app.inject({
      method: 'GET',
      url: '/admin/deploy/status',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(statusRes2.json()).toMatchObject({ running: false, lastExitCode: 0 });
  });

  it('schedules deploy-on-finish, can cancel it, and triggers deploy once work drains', async () => {
    vi.useFakeTimers();

    const scriptPath = `/tmp/codex-forum-deploy-script-${Date.now()}.sh`;
    const logPath = `/tmp/codex-forum-deploy-log-${Date.now()}.log`;
    const stateFile = `/tmp/codex-forum-deploy-state-${Date.now()}.json`;
    await import('node:fs').then(({ writeFileSync, chmodSync }) => {
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\n', 'utf8');
      chmodSync(scriptPath, 0o755);
    });
    process.env['CODEX_FORUM_DEPLOY_SCRIPT'] = scriptPath;
    process.env['CODEX_FORUM_DEPLOY_LOG'] = logPath;
    process.env['CODEX_FORUM_DEPLOY_STATE_FILE'] = stateFile;

    const child = createFakeChild();
    const spawn = vi.fn(() => child);
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn };
    });

    const { registerAdminRoutes } = await import('./adminRoutes');

    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const admin = store.createIdentityWithPassword('Admin', 'admin', 'pw-hash', 'admin');
    const token = 'admin-token';
    store.createAuthSession(token, admin.id);

    let activeTurnsCount = 1;
    const codex = {
      pauseActiveThreads: vi.fn(async () => ({ paused: 0, skipped: 0 })),
      listActiveTurns: vi.fn(() => Array.from({ length: activeTurnsCount }, (_, i) => ({ topicId: `t${i}`, turnId: `turn${i}` }))),
      listQueuedTurns: vi.fn(() => []),
      getAgentdQuiescence: vi.fn(async () => ({ status: 'safe_to_stop', blockers: [] }))
    } as any;

    registerAdminRoutes({ app, store, db, access, codex });
    await app.ready();

    // Schedule
    const scheduleRes = await app.inject({
      method: 'POST',
      url: '/admin/deploy/on-finish',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(scheduleRes.statusCode).toBe(200);

    const status1 = await app.inject({
      method: 'GET',
      url: '/admin/deploy/status',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(status1.json()).toMatchObject({ deployOnFinishRequestedAt: expect.any(String) });

    // Cancel
    const cancelRes = await app.inject({
      method: 'POST',
      url: '/admin/deploy/on-finish/cancel',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(cancelRes.statusCode).toBe(200);
    const status2 = await app.inject({
      method: 'GET',
      url: '/admin/deploy/status',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(status2.json()).toMatchObject({ deployOnFinishRequestedAt: null });

    // Re-schedule and allow drain -> should deploy
    const scheduleRes2 = await app.inject({
      method: 'POST',
      url: '/admin/deploy/on-finish',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(scheduleRes2.statusCode).toBe(200);

    // While active turns exist, timer should not deploy.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(spawn).toHaveBeenCalledTimes(0);

    // Drain work and advance: should deploy.
    activeTurnsCount = 0;
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.runOnlyPendingTimersAsync();
    await vi.runAllTicks();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(codex.pauseActiveThreads).toHaveBeenCalledWith('deploy:on_finish');

    // A quiescence deferral is not a lost one-shot request. The timer keeps the
    // durable intent and will retry after the blocker clears.
    child.emit('close', 75);
    const deferred = await app.inject({
      method: 'GET', url: '/admin/deploy/status', headers: { authorization: `Bearer ${token}` }
    });
    expect(deferred.json()).toMatchObject({
      deployOnFinishRequestedAt: expect.any(String),
      deployOnFinishLastError: expect.stringContaining('exit 75')
    });
  });
});
