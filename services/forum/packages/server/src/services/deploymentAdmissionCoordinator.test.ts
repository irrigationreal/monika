import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { DeploymentAdmissionCoordinator, DispatchAdmissionFencedError } from './deploymentAdmissionCoordinator';

import type { PausableSync } from './deploymentAdmissionCoordinator';

describe('DeploymentAdmissionCoordinator', () => {
  let db: Database.Database;
  let store: ForumStore;
  let sync: PausableSync & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
  let coordinator: DeploymentAdmissionCoordinator;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    sync = {
      pause: vi.fn(),
      resume: vi.fn(),
      waitForIdle: vi.fn(async () => true),
    };
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);
  });

  afterEach(() => {
    coordinator.close();
    db.close();
    vi.useRealTimers();
  });

  function dispatchFixture() {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Human', `human-${randomUUID()}`, 'human');
    const created = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'Opening', authorId: author.id });
    const session = store.ensureSession({ topicId: created.topic.id });
    return { ...created, session };
  }

  it('pauses sync, waits boundedly, and idempotently retains an acquired lease', async () => {
    const first = coordinator.acquire({ operationId: 'deploy-1', waitTimeoutMs: 1234, leaseMs: 60_000 });
    const duplicate = coordinator.acquire({ operationId: 'deploy-1', waitTimeoutMs: 1234, leaseMs: 60_000 });

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({ acquired: true, operationId: 'deploy-1', state: 'acquired' });
    expect(sync.pause).toHaveBeenCalledOnce();
    expect(sync.waitForIdle).toHaveBeenCalledWith(1234);
    await expect(coordinator.acquire({ operationId: 'deploy-1', waitTimeoutMs: 1, leaseMs: 1 })).resolves.toMatchObject(
      { acquired: true, operationId: 'deploy-1' }
    );
    expect(sync.pause).toHaveBeenCalledOnce();
  });

  it('renews a same-owner acquired lease and rejects reuse after expiry', async () => {
    vi.useFakeTimers();
    await coordinator.acquire({ operationId: 'deploy-renew', waitTimeoutMs: 100, leaseMs: 1000 });
    const firstExpiry = coordinator.getStatus().expiresAt;

    await vi.advanceTimersByTimeAsync(500);
    const renewed = await coordinator.acquire({ operationId: 'deploy-renew', waitTimeoutMs: 100, leaseMs: 2000 });
    expect(renewed.acquired).toBe(true);
    expect(renewed.expiresAt).not.toBe(firstExpiry);

    await vi.advanceTimersByTimeAsync(1500);
    expect(coordinator.getStatus().state).toBe('acquired');
    await vi.advanceTimersByTimeAsync(501);
    expect(coordinator.getStatus().state).toBe('idle');
    await expect(
      coordinator.acquire({ operationId: 'deploy-renew', waitTimeoutMs: 100, leaseMs: 2000 })
    ).resolves.toMatchObject({ acquired: false, state: 'expired' });
  });

  it('tracks in-flight robot work as a blocker until its idempotent release', async () => {
    const release = coordinator.beginRobotWork();
    const acquisition = await coordinator.acquire({
      operationId: 'deploy-work-blocked',
      waitTimeoutMs: 100,
      leaseMs: 60_000,
    });

    expect(acquisition).toMatchObject({
      acquired: false,
      state: 'blocked',
      blockers: [{ code: 'in_flight_robot_work', count: 1 }],
    });
    release();
    release();
    await expect(
      coordinator.acquire({ operationId: 'deploy-after-release', waitTimeoutMs: 100, leaseMs: 60_000 })
    ).resolves.toMatchObject({ acquired: true });
  });

  it('lets robot work revoke PREPARING and rejects it while ACQUIRED', async () => {
    let resolveIdle!: (idle: boolean) => void;
    sync.waitForIdle = vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve)));
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);

    const acquisition = coordinator.acquire({ operationId: 'deploy-work-race', waitTimeoutMs: 100, leaseMs: 60_000 });
    const release = coordinator.beginRobotWork();
    resolveIdle(true);
    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'revoked' });
    release();
    sync.waitForIdle = vi.fn(async () => true);

    await coordinator.acquire({ operationId: 'deploy-work-fenced', waitTimeoutMs: 100, leaseMs: 60_000 });
    expect(() => coordinator.beginRobotWork()).toThrow(DispatchAdmissionFencedError);
  });

  it('lets a dispatch revoke PREPARING and resumes sync before admitting durable intent', async () => {
    let resolveIdle!: (idle: boolean) => void;
    sync.waitForIdle = vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve)));
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);
    const fixture = dispatchFixture();

    const acquisition = coordinator.acquire({
      operationId: 'deploy-preparing',
      waitTimeoutMs: 30_000,
      leaseMs: 60_000,
    });
    const dispatch = store.createPostDispatch({
      topicId: fixture.topic.id,
      postId: fixture.post.id,
      sessionId: fixture.session.id,
    });
    resolveIdle(true);

    expect(dispatch.status).toBe('pending');
    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'revoked' });
    expect(sync.resume).toHaveBeenCalled();
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('rejects non-positive wait timeouts', () => {
    expect(() => coordinator.acquire({ operationId: 'deploy-zero-wait', waitTimeoutMs: 0, leaseMs: 60_000 })).toThrow(
      /waitTimeoutMs/
    );
    expect(sync.pause).not.toHaveBeenCalled();
  });

  it('rejects new dispatch creation while ACQUIRED with retryable semantics and no row', async () => {
    const fixture = dispatchFixture();
    await coordinator.acquire({ operationId: 'deploy-fenced', waitTimeoutMs: 100, leaseMs: 60_000 });

    expect(() =>
      store.createPostDispatch({
        topicId: fixture.topic.id,
        postId: fixture.post.id,
        sessionId: fixture.session.id,
      })
    ).toThrow(DispatchAdmissionFencedError);
    expect(store.getPostDispatchByPost(fixture.post.id)).toBeNull();
    expect(coordinator.cancel('deploy-fenced')).toMatchObject({ ok: true, released: true });
    expect(sync.resume).toHaveBeenCalled();
  });

  it('blocks new compaction and fork durable intent while ACQUIRED but preserves same-operation reads', async () => {
    const fixture = dispatchFixture();
    const forkFixture = dispatchFixture();
    for (const item of [fixture, forkFixture]) {
      store.upsertRobotState({
        topicId: item.topic.id,
        sessionId: item.session.id,
        activity: 'idle',
        currentPlanId: null,
      });
    }
    const compactionInput = {
      id: 'compaction-existing',
      topicId: fixture.topic.id,
      sessionId: fixture.session.id,
      initiatedBy: fixture.post.author_id,
      expectedLeafId: 'leaf',
      recoveryPrompt: 'recover',
    };
    const forkInput = {
      id: 'fork-existing',
      sourceTopicId: forkFixture.topic.id,
      sourceSessionId: forkFixture.session.id,
      sourcePiSessionId: 'pi-source',
      sourcePiSessionPath: '/tmp/source.jsonl',
      boundaryPostId: forkFixture.post.id,
      boundaryPiMessageId: 'message',
      boundaryEntryId: 'entry',
      expectedLeafId: 'leaf',
      initiatedBy: forkFixture.post.author_id,
      title: 'Fork',
      openingBody: 'Opening',
      prestagedAttachments: [],
    };
    expect(store.enqueueCompactionOperationIfIdle(compactionInput)?.id).toBe(compactionInput.id);
    expect(store.enqueueForkOperation(forkInput).id).toBe(forkInput.id);
    await coordinator.acquire({ operationId: 'deploy-operations', waitTimeoutMs: 100, leaseMs: 60_000 });

    expect(store.enqueueCompactionOperationIfIdle(compactionInput)).toBeNull();
    expect(store.enqueueForkOperation(forkInput).id).toBe(forkInput.id);
    expect(() => store.enqueueCompactionOperationIfIdle({ ...compactionInput, id: 'compaction-fenced' })).toThrow(
      DispatchAdmissionFencedError
    );
    expect(store.getCompactionOperation('compaction-fenced')).toBeNull();
    expect(() => store.enqueueForkOperation({ ...forkInput, id: 'fork-fenced' })).toThrow(DispatchAdmissionFencedError);
    expect(store.getForkOperation('fork-fenced')).toBeNull();
  });

  it('lets new compaction intent revoke PREPARING and proceed', async () => {
    let resolveIdle!: (idle: boolean) => void;
    sync.waitForIdle = vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve)));
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);
    const fixture = dispatchFixture();
    store.upsertRobotState({
      topicId: fixture.topic.id,
      sessionId: fixture.session.id,
      activity: 'idle',
      currentPlanId: null,
    });

    const acquisition = coordinator.acquire({
      operationId: 'deploy-preparing-compaction',
      waitTimeoutMs: 100,
      leaseMs: 60_000,
    });
    const operation = store.enqueueCompactionOperationIfIdle({
      id: 'compaction-admitted',
      topicId: fixture.topic.id,
      sessionId: fixture.session.id,
      initiatedBy: fixture.post.author_id,
      expectedLeafId: 'leaf',
      recoveryPrompt: 'recover',
    });
    resolveIdle(true);

    expect(operation?.id).toBe('compaction-admitted');
    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'revoked' });
  });

  it('keeps external adapter topic publication behind the shared store guard', async () => {
    const forum = store.createForum('External');
    const author = store.createIdentity('External Human', `external-${randomUUID()}`, 'human');
    await coordinator.acquire({ operationId: 'deploy-external', waitTimeoutMs: 100, leaseMs: 60_000 });

    expect(() =>
      store.createExternalTopicWithDispatch({
        topic: { forumId: forum.id, title: 'External topic', body: 'Opening', authorId: author.id },
        externalRef: {
          surfaceId: 'matrix:test',
          surfaceKind: 'matrix',
          externalId: 'event-1',
          kind: 'topic',
        },
        dispatch: true,
      })
    ).toThrow(DispatchAdmissionFencedError);
    expect(db.prepare("select count(*) as count from topics where title = 'External topic'").get()).toEqual({
      count: 0,
    });
  });

  it('allows idempotent lookup of an existing non-actionable dispatch while ACQUIRED', async () => {
    const fixture = dispatchFixture();
    const existing = store.createPostDispatch({
      topicId: fixture.topic.id,
      postId: fixture.post.id,
      sessionId: fixture.session.id,
    });
    db.prepare("update post_dispatches set status = 'dispatched' where id = ?").run(existing.id);
    await coordinator.acquire({ operationId: 'deploy-existing', waitTimeoutMs: 100, leaseMs: 60_000 });

    expect(
      store.createPostDispatch({
        topicId: fixture.topic.id,
        postId: fixture.post.id,
        sessionId: fixture.session.id,
      }).id
    ).toBe(existing.id);
    expect(coordinator.getStatus().state).toBe('acquired');
  });

  it('replays cancellation for the same preparing operation without reacquiring', async () => {
    let resolveIdle!: (idle: boolean) => void;
    sync.waitForIdle = vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve)));
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);

    const acquisition = coordinator.acquire({
      operationId: 'deploy-cancel-replay',
      waitTimeoutMs: 100,
      leaseMs: 60_000,
    });
    expect(coordinator.cancel('deploy-cancel-replay')).toMatchObject({ released: true });
    resolveIdle(true);

    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'cancelled' });
    await expect(
      coordinator.acquire({ operationId: 'deploy-cancel-replay', waitTimeoutMs: 100, leaseMs: 60_000 })
    ).resolves.toMatchObject({ acquired: false, state: 'cancelled' });
    expect(sync.pause).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending acquisition when the coordinator closes', async () => {
    let resolveIdle!: (idle: boolean) => void;
    sync.waitForIdle = vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve)));
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);

    const acquisition = coordinator.acquire({ operationId: 'deploy-close', waitTimeoutMs: 100, leaseMs: 60_000 });
    coordinator.close();
    resolveIdle(true);

    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'cancelled' });
    expect(coordinator.getStatus()).toMatchObject({ state: 'idle', operationId: null });
  });

  it('admits robot intent at the expiry boundary instead of throwing a stale fence', async () => {
    vi.useFakeTimers();
    const fixture = dispatchFixture();
    await coordinator.acquire({ operationId: 'deploy-expiry-race', waitTimeoutMs: 100, leaseMs: 1000 });

    // Move the clock to the lease boundary without running the expiry timer;
    // the admission assertion itself must close this race.
    vi.setSystemTime(Date.now() + 1000);
    expect(
      store.createPostDispatch({
        topicId: fixture.topic.id,
        postId: fixture.post.id,
        sessionId: fixture.session.id,
      })
    ).toMatchObject({ status: 'pending' });
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('expires a lease automatically and makes cancellation idempotent and operation-scoped', async () => {
    vi.useFakeTimers();
    await coordinator.acquire({ operationId: 'deploy-expiry', waitTimeoutMs: 100, leaseMs: 1000 });

    expect(() => coordinator.cancel('other-operation')).toThrow(/another operation/);
    await vi.advanceTimersByTimeAsync(1001);
    expect(coordinator.getStatus()).toMatchObject({ state: 'idle', operationId: null });
    expect(sync.resume).toHaveBeenCalled();
    expect(coordinator.cancel('deploy-expiry')).toEqual({ ok: true, released: false, operationId: 'deploy-expiry' });
    expect(coordinator.cancel('deploy-expiry')).toEqual({ ok: true, released: false, operationId: 'deploy-expiry' });
  });

  it('reopens when sync wait times out or durable work blocks acquisition', async () => {
    sync.waitForIdle = vi.fn(async () => false);
    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);
    await expect(
      coordinator.acquire({ operationId: 'deploy-timeout', waitTimeoutMs: 25, leaseMs: 60_000 })
    ).resolves.toMatchObject({
      acquired: false,
      state: 'blocked',
      blockers: [{ code: 'pi_session_sync_wait_timeout' }],
    });
    expect(coordinator.getStatus().state).toBe('idle');

    coordinator.close();
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => [
      { code: 'actionable_post_dispatches', count: 1 },
    ]);
    sync.waitForIdle = vi.fn(async () => true);
    await expect(
      coordinator.acquire({ operationId: 'deploy-blocked', waitTimeoutMs: 25, leaseMs: 60_000 })
    ).resolves.toMatchObject({ acquired: false, state: 'blocked', blockers: [{ code: 'actionable_post_dispatches' }] });
    expect(sync.resume).toHaveBeenCalled();
  });
});
