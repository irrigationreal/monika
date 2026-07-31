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
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });
  afterEach(() => db.close());

  it('persists success atomically, creates one recovery dispatch, and is idempotent', async () => {
    const { topic, admin } = seed(store, db);
    const compactTopicConversation = vi.fn().mockResolvedValue({ ok: true });
    const wake = vi.fn();
    const service = new CompactionService(
      store,
      { getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'), compactTopicConversation },
      { wake }
    );
    const request = {
      operationId: 'op-1',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'Recover context.',
    };

    const first = await service.compact(request);
    const second = await service.compact(request);

    expect(first.status).toBe('succeeded');
    expect(first.recoveryPostId).toBeTruthy();
    expect(store.getPost(first.recoveryPostId!)?.author_id).toBe(admin.id);
    expect(store.getPostDispatchByPost(first.recoveryPostId!)).toMatchObject({ status: 'pending' });
    expect(store.listTopicOperationalEvents(topic.id)).toHaveLength(1);
    expect(compactTopicConversation).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('records a terminal failure without creating a recovery post', async () => {
    const { topic, admin } = seed(store, db);
    const service = new CompactionService(
      store,
      {
        getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'),
        compactTopicConversation: vi.fn().mockRejectedValue(new Error('leaf changed')),
      },
      { wake: vi.fn() }
    );
    const before = store.listPosts(topic.id, 1, 100).length;
    const result = await service.compact({
      operationId: 'op-fail',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'Never posted',
    });
    expect(result.status).toBe('failed');
    expect(result.recoveryPostId).toBeNull();
    expect(store.listPosts(topic.id, 1, 100).length).toBe(before);
    expect(store.listTopicOperationalEvents(topic.id)[0]).toMatchObject({ type: 'compaction', status: 'failed' });
  });

  it('allows only one running compaction per topic after concurrent leaf checks', async () => {
    const { topic, admin } = seed(store, db);
    const leafResolvers: Array<() => void> = [];
    let finishCompaction!: () => void;
    const service = new CompactionService(
      store,
      {
        getTopicCompactionLeaf: vi.fn(
          () => new Promise<string>((resolve) => leafResolvers.push(() => resolve('leaf-1')))
        ),
        compactTopicConversation: vi.fn(
          () =>
            new Promise<Record<string, unknown>>((resolve) => {
              finishCompaction = () => resolve({ ok: true });
            })
        ),
      },
      { wake: vi.fn() }
    );

    const first = service.compact({
      operationId: 'op-a',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'recover a',
    });
    const second = service.compact({
      operationId: 'op-b',
      topicId: topic.id,
      initiatedBy: admin.id,
      recoveryPrompt: 'recover b',
    });
    expect(leafResolvers).toHaveLength(2);
    leafResolvers.forEach((resolve) => resolve());
    await expect(second).rejects.toBeInstanceOf(CompactionConflictError);
    finishCompaction();
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    expect(
      store
        .listPosts(topic.id, 1, 100)
        .map((post) => post.body)
        .filter((body) => body.startsWith('recover'))
    ).toEqual(['recover a']);
  });

  it('rejects non-idle topics before creating an operation', async () => {
    const { topic, admin } = seed(store, db, 'thinking');
    const service = new CompactionService(
      store,
      { getTopicCompactionLeaf: vi.fn().mockResolvedValue('leaf-1'), compactTopicConversation: vi.fn() },
      { wake: vi.fn() }
    );
    await expect(
      service.compact({ operationId: 'op-busy', topicId: topic.id, initiatedBy: admin.id, recoveryPrompt: 'x' })
    ).rejects.toBeInstanceOf(CompactionConflictError);
    expect(store.getCompactionOperation('op-busy')).toBeNull();
  });
});
