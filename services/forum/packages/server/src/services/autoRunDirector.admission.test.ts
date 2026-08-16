import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { AutoRunDirector } from './autoRunDirector';
import { DeploymentAdmissionCoordinator } from './deploymentAdmissionCoordinator';

import type { PausableSync } from './deploymentAdmissionCoordinator';

describe('AutoRunDirector deployment admission', () => {
  let db: Database.Database;
  let store: ForumStore;
  let director: AutoRunDirector;
  let coordinator: DeploymentAdmissionCoordinator | null;
  let topicId: string;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'author', 'human');
    store.createIdentity('Director', 'director', 'robot');
    const created = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'Opening', authorId: author.id });
    topicId = created.topic.id;
    store.upsertTopicAutoRun({ topicId, enabled: true, context: 'Continue', maxReplies: 3 });
    director = new AutoRunDirector(store, { emit: vi.fn() } as never, {
      workDir: '/tmp',
      apiBaseUrl: 'http://localhost',
      defaultWorker: 'echs',
      defaultModel: null,
      defaultReasoningEffort: null,
      autoStartOnAssistantReply: false,
      echs: null,
    });
    (director as unknown as { runPrompt: ReturnType<typeof vi.fn> }).runPrompt = vi.fn().mockResolvedValue({
      output: JSON.stringify({ action: 'reply', reply: 'Please continue with the next step.' }),
      directorThreadId: null,
    });
    dispatch = vi.fn().mockResolvedValue(undefined);
    director.setRobotDispatcher(dispatch);
    coordinator = null;
  });

  afterEach(async () => {
    coordinator?.close();
    await director.stop();
    db.close();
  });

  function postCount(): number {
    return (db.prepare('select count(*) as count from posts where topic_id = ?').get(topicId) as { count: number })
      .count;
  }

  it('blocks acquired admission before publishing or dispatching a Director reply', async () => {
    coordinator = new DeploymentAdmissionCoordinator(store, null, () => []);
    await coordinator.acquire({ operationId: 'auto-run-acquired', waitTimeoutMs: 100, leaseMs: 60_000 });
    const before = postCount();

    await expect(director.runManual({ topicId })).rejects.toMatchObject({ statusCode: 503, retryAfter: 1 });

    expect(postCount()).toBe(before);
    expect((director as unknown as { runPrompt: ReturnType<typeof vi.fn> }).runPrompt).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('blocks acquisition while Director model work is already in flight', async () => {
    coordinator = new DeploymentAdmissionCoordinator(store, null, () => []);
    let resolvePrompt!: (value: { output: string; directorThreadId: null }) => void;
    const promptStarted = Promise.withResolvers<void>();
    (director as unknown as { runPrompt: ReturnType<typeof vi.fn> }).runPrompt = vi.fn(() => {
      promptStarted.resolve();
      return new Promise((resolve) => (resolvePrompt = resolve));
    });

    const run = director.runManual({ topicId });
    await promptStarted.promise;
    await expect(
      coordinator.acquire({ operationId: 'deploy-during-director', waitTimeoutMs: 100, leaseMs: 60_000 })
    ).resolves.toMatchObject({
      acquired: false,
      state: 'blocked',
      blockers: [{ code: 'in_flight_robot_work', count: 1 }],
    });

    resolvePrompt({
      output: JSON.stringify({ action: 'idle' }),
      directorThreadId: null,
    });
    await run;
  });

  it('revokes preparing admission and publishes and dispatches the Director reply', async () => {
    let resolveIdle!: (idle: boolean) => void;
    const sync: PausableSync = {
      pause: vi.fn(),
      resume: vi.fn(),
      waitForIdle: vi.fn(() => new Promise<boolean>((resolve) => (resolveIdle = resolve))),
    };
    coordinator = new DeploymentAdmissionCoordinator(store, sync, () => []);
    const acquisition = coordinator.acquire({
      operationId: 'auto-run-preparing',
      waitTimeoutMs: 100,
      leaseMs: 60_000,
    });
    const before = postCount();

    await director.runManual({ topicId });
    resolveIdle(true);

    expect(postCount()).toBe(before + 1);
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(acquisition).resolves.toMatchObject({ acquired: false, state: 'revoked' });
  });
});
