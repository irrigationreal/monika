import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './db';
import { EchsBridge } from './echsBridge';
import { PiSessionSyncService } from './services/piSessionSyncService';
import { ForumStore } from './store';

import type { ExportedSession } from './services/piSessionSyncService';

describe('ECHS subagent completion projection', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  it('persists a separate canonical completion under its origin exactly once', async () => {
    const forum = store.createForum('Forum');
    const human = store.createIdentity('Author', 'human');
    store.createIdentity('Monika', 'robot');
    const { topic, post: originPost } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'Start background work',
      authorId: human.id,
    });
    const newerPost = store.createPost({
      topicId: topic.id,
      body: 'Newer active request',
      authorId: human.id,
      parentPostId: originPost.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-parent',
      piSessionPath: '/app/.pi/agent/sessions/parent.jsonl',
      topicId: topic.id,
      sessionId: session.id,
    });

    const emit = vi.fn();
    const bridge = new EchsBridge(store, { emit, subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'syncReasoningFromHistory').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'forceReasoningBackfill').mockResolvedValue(undefined);
    const context = {
      topicId: topic.id,
      sessionId: session.id,
      activeThreadId: 'conversation-1',
      lastUserPostId: newerPost.id,
      turnParentPostId: newerPost.id,
      planId: null,
      reasoningSummary: '',
      reasoningBackfillAttempted: false,
      reasoningBackfillRetries: 0,
      model: 'm',
      reasoningEffort: null,
      currentTurnId: 'newer-turn',
      turnStartedAt: Date.now(),
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

    const completionMetadata = {
      source_kind: 'subagent-completion',
      run_id: 'run-1',
      origin_turn_id: 'origin-turn',
      origin_post_id: originPost.id,
      origin_topic_id: topic.id,
    };
    (bridge as any).handleEvent('conversation-1', {
      event: 'turn_started',
      data: { message_id: 'completion-turn', ...completionMetadata },
    });
    // A newer post remains the context's most recent user post. Completion
    // ownership comes from the item itself, never mutable turn-start state.
    context.lastUserPostId = newerPost.id;
    const completionEvent = {
      event: 'item_completed',
      data: {
        pi_message_id: 'completion-a1',
        ...completionMetadata,
        subagent_run_ids: ['run-1'],
        item: { id: 'adapter-item-id', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Background result' }] },
      },
    };
    (bridge as any).handleEvent('conversation-1', completionEvent);
    (bridge as any).handleEvent('conversation-1', completionEvent);

    await vi.waitFor(() => {
      expect(db.prepare("select count(*) as count from pi_message_links where pi_message_id = 'completion-a1'").get()).toEqual({ count: 1 });
    });
    const projected = db.prepare("select id, parent_post_id, body from posts where body = 'Background result'").all() as Array<any>;
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ parent_post_id: originPost.id, body: 'Background result' });
    expect(db.prepare("select count(*) as count from posts where body not in ('Start background work', 'Newer active request', 'Background result')").get()).toEqual({ count: 0 });
    const link = store.getPiMessageLink('pi-parent', 'completion-a1');
    expect(link?.post_id).toBe(projected[0].id);
    expect(JSON.parse(link?.metadata_json ?? '{}')).toMatchObject({
      sourceKind: 'subagent-completion',
      runId: 'run-1',
      originTurnId: 'origin-turn',
      originPostId: originPost.id,
      originTopicId: topic.id,
    });

    const sync = new PiSessionSyncService(db, { agentdBaseUrl: 'http://agentd.invalid', intervalMs: 60_000 });
    const exported: ExportedSession = {
      session: { id: 'pi-parent', path: '/app/.pi/agent/sessions/parent.jsonl', cwd: '/tmp' },
      entries: [{
        type: 'message', id: 'completion-a1', role: 'assistant', text: 'Background result',
        hasVisibleText: true, stopReason: 'stop',
      }],
      active_branch: { leaf_entry_id: 'completion-a1', active_entry_ids: ['completion-a1'] },
      message_provenance: [{
        piMessageId: 'completion-a1', origin: 'subagent-completion', sourceKind: 'subagent-completion',
        runId: 'run-1', originPostId: originPost.id, originTopicId: topic.id,
      }],
    };
    const imported = await (sync as any).importExported(exported, exported.session);
    expect(imported).toBe(0);
    expect(db.prepare("select count(*) as count from posts where body = 'Background result'").get()).toEqual({ count: 1 });

    // A second canonical outward Pi message retains its own utterance identity,
    // even when it references the same background run.
    (bridge as any).handleEvent('conversation-1', {
      ...completionEvent,
      data: { ...completionEvent.data, pi_message_id: 'completion-a2' },
    });
    await vi.waitFor(() => {
      expect(store.getPiMessageLink('pi-parent', 'completion-a2')?.post_id).toBeTruthy();
    });
    expect(store.getPiMessageLink('pi-parent', 'completion-a2')?.post_id).not.toBe(projected[0].id);
    expect(db.prepare("select count(*) as count from posts where body = 'Background result'").get()).toEqual({ count: 2 });
  });
});
