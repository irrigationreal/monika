import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './db';
import { EchsBridge } from './echsBridge';
import { ForumStore } from './store';

describe('ECHS operational event ingestion', () => {
  let db: Database.Database;
  let store: ForumStore;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });
  afterEach(() => db.close());

  it('persists and emits an idempotent anchored turn_error event', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'trigger',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'm',
      reasoningEffort: null,
    });
    const emit = vi.fn();
    const bridge = new EchsBridge(store, { emit, subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const context = {
      topicId: topic.id,
      sessionId: session.id,
      activeThreadId: 'conversation-1',
      lastUserPostId: post.id,
      turnParentPostId: post.id,
      planId: null,
      reasoningSummary: '',
      reasoningBackfillAttempted: false,
      reasoningBackfillRetries: 0,
      model: 'm',
      reasoningEffort: null,
      currentTurnId: 'turn-1',
      turnStartedAt: Date.now(),
      lastAssistantAt: null,
      lastUsage: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      activeSubagents: new Map(),
      lastStreamEventAt: null,
      reasoningCheckpoints: [],
      assistantText: '',
      assistantCheckpoints: [],
    };
    (bridge as any).threadMap.set('conversation-1', context);

    (bridge as any).handleEvent('conversation-1', {
      event: 'turn_error',
      id: 'source-event-1',
      data: { error: 'boom' },
    });
    (bridge as any).handleEvent('conversation-1', {
      event: 'turn_error',
      id: 'source-event-1',
      data: { message: 'legacy fallback' },
    });

    const events = store.listTopicOperationalEvents(topic.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      anchorPostId: post.id,
      type: 'turn_error',
      status: 'failed',
      sourceId: 'source-event-1',
    });
    expect(emit).toHaveBeenCalledWith(
      topic.id,
      expect.objectContaining({
        type: 'assistant_error',
        data: expect.objectContaining({ event_id: events[0]!.id }),
      })
    );
    expect(store.getRobotState(topic.id)?.last_error_message).toBe('legacy fallback');
  });
});
