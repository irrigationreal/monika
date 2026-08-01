import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { CompactionConflictError, CompactionService } from './compactionService';

function seed(store: ForumStore, db: Database.Database, activity = 'idle') {
  const forum = store.createForum('Forum');
  const admin = store.createIdentity('Admin', 'admin');
  const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'start', authorId: admin.id });
  const session = store.ensureSession({ topicId: topic.id });
  store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
  store.upsertPiSessionLink({
    piSessionId: 'pi-1',
    piSessionPath: '/tmp/pi.jsonl',
    topicId: topic.id,
    sessionId: session.id,
    kind: 'forum',
  });
  db.prepare(
    `insert into pi_session_heads (pi_session_id, leaf_entry_id, active_entry_ids_json, observed_at) values (?, ?, '[]', ?)`
  ).run('pi-1', 'leaf-1', new Date().toISOString());
  store.upsertRobotState({ topicId: topic.id, sessionId: session.id, activity, model: null, reasoningEffort: null });
  return { topic, admin, session };
}

describe('CompactionService', () => {
  let db: Database.Database;
  let store: ForumStore;
  const services: CompactionService[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.stop()));
    db.close();
  });

  function service(
    agent: {
      getTopicCompactionLeaf: (topicId: string) => Promise<string | null>;
      compactTopicConversation: (topicId: string, input: any) => Promise<Record<string, unknown>>;
    },
    wake = vi.fn()
  ): CompactionService {
    const result = new CompactionService(store, agent, { wake }, { intervalMs: 60_000 });
    services.push(result);
    return result;
  }

  it('accepts promptly, completes in the worker, creates one recovery dispatch, and stays idempotent', async () => {
    const { topic, admin } = seed(store, db);
    let finish!: () => void;
    const compactTopicConversation = vi.fn(
      () => new Promise<Record<string, unknown>>((resolve) => (finish = () => resolve({ ok: true })))
    );
    const wake = vi.fn();
    const subject = service(
      { getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'), compactTopicConversation },
      wake
    );
    subject.start();
    const request = {
      operationId: 'op-1',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'Recover context.',
    };

    const accepted = await subject.enqueue(request);
    expect(accepted.status).toBe('pending');
    await vi.waitFor(() => expect(store.getCompactionOperation('op-1')?.status).toBe('running'));
    expect(await subject.enqueue(request)).toMatchObject({ id: 'op-1', status: 'running' });

    finish();
    await vi.waitFor(() => expect(store.getCompactionOperation('op-1')?.status).toBe('succeeded'));
    const completed = subject.get(topic.id, 'op-1');
    expect(completed.recoveryPostId).toBeTruthy();
    expect(store.getPost(completed.recoveryPostId!)?.author_id).toBe(admin.id);
    expect(store.getPostDispatchByPost(completed.recoveryPostId!)).toMatchObject({ status: 'pending' });
    expect(store.listTopicOperationalEvents(topic.id)).toHaveLength(1);
    expect(compactTopicConversation).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('records a terminal failure without creating a recovery post', async () => {
    const { topic, admin } = seed(store, db);
    const compactTopicConversation = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('leaf changed'), { status: 409 }));
    const subject = service({
      getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'),
      compactTopicConversation,
    });
    subject.start();
    const before = store.listPosts(topic.id, 1, 100).length;
    await subject.enqueue({ operationId: 'op-fail', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'Never posted' });
    await vi.waitFor(() => expect(store.getCompactionOperation('op-fail')?.status).toBe('failed'));
    expect(store.getCompactionOperation('op-fail')?.recoveryPostId).toBeNull();
    expect(store.listPosts(topic.id, 1, 100).length).toBe(before);
    expect(store.listTopicOperationalEvents(topic.id)[0]).toMatchObject({ type: 'compaction', status: 'failed' });
    expect(compactTopicConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertain transport failures pending for canonical reconciliation', async () => {
    const { topic, admin } = seed(store, db);
    const compactTopicConversation = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(Object.assign(new Error('conversation busy'), { status: 409 }));
    const subject = service({
      getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'),
      compactTopicConversation,
    });
    subject.start();
    await subject.enqueue({
      operationId: 'op-uncertain',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'recover',
    });
    await vi.waitFor(() => expect(compactTopicConversation).toHaveBeenCalledTimes(1));
    expect(store.getCompactionOperation('op-uncertain')).toMatchObject({ status: 'pending' });
    const row = db.prepare('select error_message, next_attempt_at from compaction_operations where id = ?').get('op-uncertain') as any;
    expect(row.error_message).toContain('connection reset');
    expect(row.next_attempt_at).toBeTruthy();
    expect(store.listTopicOperationalEvents(topic.id)).toEqual([]);
  });

  it('treats conversation_busy as uncertain reconciliation rather than terminal failure', async () => {
    const { topic, admin } = seed(store, db);
    const compactTopicConversation = vi.fn().mockRejectedValue(
      Object.assign(new Error('conversation busy'), {
        status: 409,
        details: { error: 'conversation_busy' },
      })
    );
    const subject = service({ getTopicCompactionLeaf: vi.fn(), compactTopicConversation });
    subject.start();
    await subject.enqueue({ operationId: 'op-busy-reconcile', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'recover' });
    await vi.waitFor(() => expect(compactTopicConversation).toHaveBeenCalledTimes(1));
    expect(store.getCompactionOperation('op-busy-reconcile')).toMatchObject({ status: 'pending' });
    expect(store.listTopicOperationalEvents(topic.id)).toEqual([]);
  });

  it('atomically allows only one active compaction for concurrent requests', async () => {
    const { topic, admin } = seed(store, db);
    const subject = service({
      getTopicCompactionLeaf: vi.fn(),
      compactTopicConversation: vi.fn().mockResolvedValue({ ok: true }),
    });
    const outcomes = await Promise.allSettled([
      subject.enqueue({ operationId: 'op-a', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'a' }),
      subject.enqueue({ operationId: 'op-b', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'b' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CompactionConflictError);
  });

  it('rejects concurrent same-id requests with different payloads', async () => {
    const { topic, admin } = seed(store, db);
    const subject = service({ getTopicCompactionLeaf: vi.fn(), compactTopicConversation: vi.fn() });
    await subject.enqueue({ operationId: 'op-same', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'a' });
    await expect(
      subject.enqueue({ operationId: 'op-same', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'different' })
    ).rejects.toBeInstanceOf(CompactionConflictError);
  });

  it('requeues interrupted running work on startup and relies on expected-leaf reconciliation', async () => {
    const { topic, admin, session } = seed(store, db);
    store.createCompactionOperation({
      id: 'op-recovered',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('op-recovered');
    const compactTopicConversation = vi.fn().mockResolvedValue({ already_completed: true });
    const subject = service({ getTopicCompactionLeaf: vi.fn(), compactTopicConversation });

    expect(subject.start()).toBe(1);
    await vi.waitFor(() => expect(store.getCompactionOperation('op-recovered')?.status).toBe('succeeded'));
    expect(compactTopicConversation).toHaveBeenCalledWith(topic.id, expect.objectContaining({ expectedLeafId: 'leaf-1' }));
  });

  it('hydrates active/latest state and allows an admin retry of a terminal checkpoint dispatch', async () => {
    const { topic, admin, session } = seed(store, db);
    store.createCompactionOperation({
      id: 'op-checkpoint',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('op-checkpoint');
    const completed = store.finishCompactionSuccess('op-checkpoint');
    const dispatch = store.getPostDispatchByPost(completed.recoveryPostId!);
    db.prepare("update post_dispatches set status = 'failed', error_message = 'provider unavailable' where id = ?").run(dispatch!.id);
    const wake = vi.fn();
    const subject = service({ getTopicCompactionLeaf: vi.fn(), compactTopicConversation: vi.fn() }, wake);

    expect(subject.getState(topic.id)).toMatchObject({
      active: null,
      latest: { id: 'op-checkpoint', status: 'succeeded' },
      checkpointDispatch: { status: 'failed', error_message: 'provider unavailable' },
    });
    expect(subject.retryCheckpoint(topic.id, 'op-checkpoint').checkpointDispatch).toMatchObject({ status: 'pending' });
    expect(subject.retryCheckpoint(topic.id, 'op-checkpoint').checkpointDispatch).toMatchObject({ status: 'pending' });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('rejects locked topics before reserving a compaction operation', async () => {
    const { topic, admin } = seed(store, db);
    store.updateTopicStatus(topic.id, 'locked');
    const subject = service({
      getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'),
      compactTopicConversation: vi.fn(),
    });
    await expect(
      subject.enqueue({ operationId: 'op-locked', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'x' })
    ).rejects.toBeInstanceOf(CompactionConflictError);
    expect(store.getCompactionOperation('op-locked')).toBeNull();
  });

  it('rejects non-idle topics before creating an operation', async () => {
    const { topic, admin } = seed(store, db, 'thinking');
    const subject = service({
      getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'),
      compactTopicConversation: vi.fn(),
    });
    await expect(
      subject.enqueue({ operationId: 'op-busy', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'x' })
    ).rejects.toBeInstanceOf(CompactionConflictError);
    expect(store.getCompactionOperation('op-busy')).toBeNull();
  });
});
