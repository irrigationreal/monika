import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { actionablePostDispatchBlocker, nonIdleRobotStateBlocker } from './services/deploymentBlockerDiagnostics';
import { ForumStore } from './store';

describe('global actionable durable dispatch blocker', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  function fixture(title: string) {
    const forum = store.createForum(`${title} forum`);
    const author = store.createIdentity(`${title} author`, `${title.toLowerCase()}-author`, 'human');
    const created = store.createTopic({ forumId: forum.id, title, body: 'body', authorId: author.id });
    const session = store.ensureSession({ topicId: created.topic.id });
    return { ...created, session };
  }

  it('counts pending and running fork operations as deployment blockers', () => {
    const source = fixture('Fork source');
    store.upsertRobotState({
      topicId: source.topic.id,
      sessionId: source.session.id,
      activity: 'idle',
      currentPlanId: null,
    });
    const operation = store.enqueueForkOperation({
      id: 'fork-blocker',
      sourceTopicId: source.topic.id,
      sourceSessionId: source.session.id,
      sourcePiSessionId: 'pi-source',
      sourcePiSessionPath: '/tmp/source.jsonl',
      boundaryPostId: source.post.id,
      boundaryPiMessageId: 'message',
      boundaryEntryId: 'entry',
      expectedLeafId: 'leaf',
      initiatedBy: source.post.author_id,
      title: 'Fork',
      openingBody: 'Opening',
      requestedModel: 'openai/gpt-5.6-terra',
      model: 'openai/gpt-5.6-terra',
      reasoningEffort: 'high',
      prestagedAttachments: [],
    });

    expect(() =>
      store.enqueueForkOperation({
        id: 'fork-blocker',
        sourceTopicId: source.topic.id,
        sourceSessionId: source.session.id,
        sourcePiSessionId: 'pi-source',
        sourcePiSessionPath: '/tmp/source.jsonl',
        boundaryPostId: source.post.id,
        boundaryPiMessageId: 'message',
        boundaryEntryId: 'entry',
        expectedLeafId: 'leaf',
        initiatedBy: source.post.author_id,
        title: 'Fork',
        openingBody: 'Opening',
        requestedModel: 'anthropic/claude-sonnet-4-6',
        model: 'anthropic/claude-sonnet-4-6',
        reasoningEffort: 'high',
        prestagedAttachments: [],
      })
    ).toThrow('fork_operation_mismatch');
    expect(store.countPendingOrRunningForkOperations()).toBe(1);
    expect(store.claimForkOperation(operation.id)?.status).toBe('running');
    expect(store.countPendingOrRunningForkOperations()).toBe(1);
    db.prepare("update fork_operations set status = 'needs_manual_review' where id = ?").run(operation.id);
    expect(store.countPendingOrRunningForkOperations()).toBe(0);
  });

  it('returns deterministic capped opaque diagnostics for dispatch and robot blockers', () => {
    for (let index = 0; index < 25; index += 1) {
      const current = fixture(`Sensitive title ${index}`);
      store.createPostDispatch({
        topicId: current.topic.id,
        postId: current.post.id,
        sessionId: current.session.id,
      });
      store.upsertRobotState({
        topicId: current.topic.id,
        sessionId: current.session.id,
        activity: index % 2 === 0 ? 'thinking' : 'waiting',
        currentPlanId: null,
      });
    }

    const dispatchBlocker = actionablePostDispatchBlocker(store);
    expect(dispatchBlocker).toMatchObject({
      code: 'actionable_post_dispatches',
      count: 25,
      item_limit: 20,
      truncated: true,
      omitted_count: 5,
    });
    const dispatchItems = dispatchBlocker?.['items'] as Array<Record<string, unknown>>;
    expect(dispatchItems).toHaveLength(20);
    expect(dispatchItems.map((item) => item['topic_id'])).toEqual(
      dispatchItems.map((item) => item['topic_id']).toSorted()
    );
    expect(Object.keys(dispatchItems[0] ?? {}).sort()).toEqual(['dispatch_id', 'session_id', 'status', 'topic_id']);

    const robotBlocker = nonIdleRobotStateBlocker(store);
    expect(robotBlocker).toMatchObject({
      code: 'non_idle_robot_states',
      count: 25,
      item_limit: 20,
      truncated: true,
      omitted_count: 5,
    });
    const robotItems = robotBlocker?.['items'] as Array<Record<string, unknown>>;
    expect(robotItems).toHaveLength(20);
    expect(robotItems.map((item) => item['topic_id'])).toEqual(robotItems.map((item) => item['topic_id']).toSorted());
    expect(Object.keys(robotItems[0] ?? {}).sort()).toEqual(['activity', 'session_id', 'topic_id']);
    expect(JSON.stringify([dispatchBlocker, robotBlocker])).not.toContain('Sensitive title');
  });

  it('counts only pending, dispatching, and retryable failed rows in the current generation', () => {
    const current = fixture('Current');
    const dispatch = store.createPostDispatch({
      topicId: current.topic.id,
      postId: current.post.id,
      sessionId: current.session.id,
    });
    expect(store.countGlobalActionablePostDispatches()).toBe(1);

    db.prepare("update post_dispatches set status = 'dispatching' where id = ?").run(dispatch.id);
    expect(store.countGlobalActionablePostDispatches()).toBe(1);
    db.prepare("update post_dispatches set status = 'failed', next_attempt_at = ? where id = ?").run(
      '2099-01-01T00:00:00.000Z',
      dispatch.id
    );
    expect(store.countActionablePostDispatches(current.topic.id)).toBe(1);
    expect(store.countGlobalActionablePostDispatches()).toBe(1);

    db.prepare('update post_dispatches set next_attempt_at = null where id = ?').run(dispatch.id);
    expect(store.countActionablePostDispatches(current.topic.id)).toBe(0);
    expect(store.countGlobalActionablePostDispatches()).toBe(0);

    store.advanceTopicDispatchGeneration(current.topic.id);
    expect(store.countGlobalActionablePostDispatches()).toBe(0);

    for (const status of ['dispatched', 'superseded', 'abandoned']) {
      db.prepare('update post_dispatches set generation = ?, status = ? where id = ?').run(
        store.getTopicDispatchGeneration(current.topic.id),
        status,
        dispatch.id
      );
      expect(store.countGlobalActionablePostDispatches()).toBe(0);
    }
  });
});
