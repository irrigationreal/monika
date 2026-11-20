import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './db';
import { EchsBridge } from './echsBridge';
import { ForumStore } from './store';
import { normalizeNestedToolCalls, parseNestedToolCallsJson } from './toolTraceMetadata';

describe('ECHS nested tool trace ingestion', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  it('marks capped, malformed, duplicate and unfinished nested records incomplete', () => {
    const call = { id: 'child', name: 'read', status: 'ok' };
    for (const calls of [
      Array.from({ length: 65 }, (_, i) => ({ ...call, id: String(i) })),
      [call, call],
      [call, null],
      [{ ...call, status: 'unfinished' }],
    ]) {
      expect(normalizeNestedToolCalls({ calls, complete: true })?.complete).toBe(false);
    }
  });

  it('keys child rows by call ID and preserves metadata-only final nested updates', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'Run a script',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'running_tools',
      model: 'm',
      reasoningEffort: null,
    });

    const emit = vi.fn();
    const bridge = new EchsBridge(store, { emit, subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    (bridge as any).threadMap.set('conversation-1', {
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
      lastUsage: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      activeSubagents: new Map(),
      lastStreamEventAt: null,
      reasoningCheckpoints: [],
    });

    const startRoot = {
      event: 'item_started',
      data: {
        item: {
          type: 'function_call',
          id: 'root-call',
          call_id: 'root-call',
          name: 'codemode',
          arguments: { script: 'safe root script' },
        },
      },
    };
    const startChild = {
      event: 'item_started',
      data: {
        item: {
          type: 'function_call',
          id: 'child-call',
          call_id: 'child-call',
          parent_call_id: 'root-call',
          name: 'read',
          arguments: { redacted: true, forbiddenRawArgument: 'do not persist' },
        },
      },
    };
    (bridge as any).handleEvent('conversation-1', startRoot);
    (bridge as any).handleEvent('conversation-1', startChild);
    (bridge as any).handleEvent('conversation-1', startChild);

    expect(store.listAllToolRunsBySession(session.id)).toHaveLength(2);
    expect(
      emit.mock.calls.filter(([, event]) => event.type === 'tool_started' && event.data.callId === 'child-call')
    ).toHaveLength(1);

    (bridge as any).handleEvent('conversation-1', {
      event: 'tool_completed',
      data: {
        call_id: 'child-call',
        parent_call_id: 'root-call',
        result: {
          redacted: true,
          status: 'ok',
          duration_ms: 12,
          forbiddenRawResult: 'do not persist',
        },
      },
    });
    expect(store.getRobotState(topic.id)?.activity).toBe('running_tools');
    (bridge as any).handleEvent('conversation-1', {
      event: 'tool_completed',
      data: {
        call_id: 'root-call',
        result: 'Root result password=supersecret',
        nested_calls: {
          calls: [
            {
              id: 'child-call',
              name: 'read',
              status: 'unfinished',
              raw_args: 'do not persist',
              raw_result: 'do not persist',
            },
          ],
          complete: false,
          raw_transcript: 'do not persist',
        },
      },
    });
    const rootBeforeFinal = store.getToolRunByCallId(session.id, 'root-call')!;
    expect(rootBeforeFinal.output_summary).toContain('password=[REDACTED]');

    // Agentd emits this metadata-only update when canonical message_end makes
    // the nested record final. It must not erase the root result summary.
    (bridge as any).handleEvent('conversation-1', {
      event: 'tool_updated',
      data: {
        call_id: 'root-call',
        partial_result: null,
        nested_calls: {
          calls: [{ id: 'child-call', name: 'read', status: 'ok', duration_ms: 12, raw_result: 'forbidden' }],
          complete: true,
        },
      },
    });

    const root = store.getToolRunByCallId(session.id, 'root-call')!;
    const child = store.getToolRunByCallId(session.id, 'child-call')!;
    expect(store.listAllToolRunsBySession(session.id)).toHaveLength(2);
    expect(root.output_summary).toBe(rootBeforeFinal.output_summary);
    expect(parseNestedToolCallsJson(root.nested_calls_json)).toEqual({
      calls: [{ id: 'child-call', name: 'read', status: 'ok', durationMs: 12 }],
      complete: true,
    });
    expect(root.nested_calls_json).not.toContain('raw_result');
    expect(root.nested_calls_json).not.toContain('forbidden');
    expect(child.parent_call_id).toBe('root-call');
    expect(child.command).toBe('read {"redacted":true}');
    expect(child.output_summary).toBe('{"redacted":true,"status":"ok","duration_ms":12}');
    expect(child.command).not.toContain('forbiddenRawArgument');
    expect(child.output_summary).not.toContain('forbiddenRawResult');

    const stateEvents = emit.mock.calls.map(([, event]) => event).filter((event) => event.type === 'state');
    const latestRoot = stateEvents
      .at(-1)
      ?.data.recentToolRuns.find((run: { callId: string }) => run.callId === 'root-call');
    const latestChild = stateEvents
      .at(-1)
      ?.data.recentToolRuns.find((run: { callId: string }) => run.callId === 'child-call');
    expect(latestRoot?.nestedCalls).toEqual({
      calls: [{ id: 'child-call', name: 'read', status: 'ok', durationMs: 12 }],
      complete: true,
    });
    const rootUpdates = emit.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.type === 'tool_run' && event.data.callId === 'root-call');
    expect(rootUpdates.at(-1)?.data.nestedCalls?.complete).toBe(true);
    expect(latestChild?.parentCallId).toBe('root-call');
  });
});
