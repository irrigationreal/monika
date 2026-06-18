import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { ForumStore } from './store';

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

describe('ForumStore assistant turn projection', () => {
  it('tracks a lightweight turn snapshot and compact event log', () => {
    const admin = store.createIdentity('Admin', 'admin');
    const forum = store.createForum('General');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Live UI', body: 'start', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });

    store.upsertAssistantTurn({
      id: 'turn-1',
      topicId: topic.id,
      sessionId: session.id,
      status: 'running',
      activity: 'thinking',
      model: 'openai/gpt-5.2',
      reasoningEffort: 'medium',
      appendDraftDelta: 'Hello',
    });
    store.upsertAssistantTurn({
      id: 'turn-1',
      topicId: topic.id,
      sessionId: session.id,
      appendDraftDelta: ' world',
      appendReasoningDelta: 'Planning',
    });
    store.appendTurnEvent({ turnId: 'turn-1', topicId: topic.id, type: 'turn_started', visibility: 'public' });
    store.appendTurnEvent({
      turnId: 'turn-1',
      topicId: topic.id,
      type: 'tool_started',
      visibility: 'internal',
      payload: { tool: 'read' },
    });

    const turn = store.getCurrentAssistantTurn(topic.id);
    expect(turn?.draft_text).toBe('Hello world');
    expect(turn?.reasoning_text).toBe('Planning');
    expect(turn?.model).toBe('openai/gpt-5.2');

    const events = store.listTurnEvents('turn-1');
    expect(events.map((event) => [event.seq, event.type, event.visibility])).toEqual([
      [1, 'turn_started', 'public'],
      [2, 'tool_started', 'internal'],
    ]);
  });
});
