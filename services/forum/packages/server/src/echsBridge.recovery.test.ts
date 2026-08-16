import { describe, expect, it, vi } from 'vitest';

import { EchsBridge } from './echsBridge';
import { EchsClient } from './echsClient';

describe('passive ECHS startup reconciliation', () => {
  it('carries stable dispatch identity and generation to agentd', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValue({ message_id: 'dispatch-1', deduplicated: true });
    const result = await client.enqueueConversationMessage('conversation-1', 'work', {
      messageId: 'dispatch-1',
      dispatchId: 'dispatch-1',
      generation: 7,
    });
    expect(request).toHaveBeenCalledWith('/v1/conversations/conversation-1/messages', {
      method: 'POST',
      body: { mode: 'queue', content: 'work', message_id: 'dispatch-1', dispatch_id: 'dispatch-1', generation: 7 },
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ messageId: 'dispatch-1', deduplicated: true });
  });

  it('sends the durable dispatch id as the canonical creation operation id', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValue({ conversation: { conversation_id: 'conversation-1' } });
    await client.createConversation({ creationId: 'dispatch-1', cwd: '/workspace' });
    expect(request).toHaveBeenCalledWith('/v1/conversations', {
      method: 'POST',
      body: { durable_session: true, creation_id: 'dispatch-1', cwd: '/workspace' },
    });
  });

  it('keeps ordinary conversation creation non-durable without an explicit creation id', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValue({ conversation: { conversation_id: 'conversation-1' } });
    await client.createConversation({ cwd: '/workspace' });
    expect(request).toHaveBeenCalledWith('/v1/conversations', {
      method: 'POST',
      body: { cwd: '/workspace' },
    });
  });

  it('retries cancellation once with the same durable operation identity inside the bounded deadline', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const request = vi
      .spyOn(client as any, 'request')
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce({
        ok: true,
        operation_id: 'op-1',
        generation: 4,
        state: 'stopped',
        targets: 0,
        unresolved_count: 0,
        effects_unknown_count: 0,
        error_count: 0,
        message: 'stopped',
      });
    await expect(client.cancelPiSession('parent', { operationId: 'op-1', generation: 4 })).resolves.toMatchObject({
      state: 'stopped',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 10_000,
      body: { operation_id: 'op-1', generation: 4 },
    });
  });

  function bridgeFixture(conversation: Record<string, unknown> | null) {
    const session = {
      id: 'session-1',
      topic_id: 'topic-1',
      agent_thread_id: 'conversation-1',
      last_dispatched_post_id: 'post-1',
    };
    let activity = 'idle';
    const store = {
      listPiSessionLinksWithUnresolvedCancellation: vi.fn(() => []),
      listSessionsWithThreads: vi.fn(() => [session]),
      clearSessionAgentThread: vi.fn(),
      setRobotActivity: vi.fn((_topicId: string, next: string) => {
        activity = next;
      }),
      clearActiveTurnOrigin: vi.fn(),
      getRobotState: vi.fn(() => ({ current_plan_id: null, activity })),
      getTopicDispatchGeneration: vi.fn(() => 0),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      upsertRobotState: vi.fn(),
      getLatestPostId: vi.fn(),
      setSessionLastDispatchedPostId: vi.fn(),
    };
    const bus = { emit: vi.fn(), subscribe: vi.fn() };
    const bridge = new EchsBridge(store as any, bus as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue(conversation);
    const create = vi.spyOn((bridge as any).client, 'createConversation');
    const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage');
    const ensureSubscribed = vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    const open = vi.spyOn(bridge as any, 'openTopicConversation');
    return { bridge, store, open, create, enqueue, ensureSubscribed };
  }

  it('fails closed for non-dispatch operations when a topic has no canonical link', async () => {
    const store = {
      ensureSession: vi.fn(() => ({ id: 'session-1', agent_thread_id: null })),
      getPiSessionLinkByTopic: vi.fn(() => null),
      getTopic: vi.fn(() => ({ forum_id: 'forum-1', auto_compact_enabled: false })),
      getForum: vi.fn(() => ({ cwd: '/workspace' })),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const create = vi.spyOn((bridge as any).client, 'createConversationRecord');
    await expect(bridge.getTopicCompactionLeaf('topic-1')).rejects.toThrow(/non-dispatch operations cannot create/);
    expect(create).not.toHaveBeenCalled();
  });

  it('repairs a missing derived link only from a loaded conversation with canonical identity', async () => {
    const upsertPiSessionLink = vi.fn((input) => ({
      pi_session_id: input.piSessionId,
      pi_session_path: input.piSessionPath,
    }));
    const store = {
      ensureSession: vi.fn(() => ({ id: 'session-1', agent_thread_id: 'conversation-1' })),
      getPiSessionLinkByTopic: vi.fn(() => null),
      upsertPiSessionLink,
      getTopic: vi.fn(() => ({ forum_id: 'forum-1', auto_compact_enabled: false })),
      getForum: vi.fn(() => ({ cwd: '/workspace' })),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({
      conversation_id: 'conversation-1',
      session_id: 'pi-1',
      session_path: '/sessions/pi-1.jsonl',
      cwd: '/workspace',
    });
    vi.spyOn((bridge as any).client, 'getConversationContext').mockResolvedValue({
      context: { leafEntryId: 'leaf-1' },
    });
    await expect(bridge.getTopicCompactionLeaf('topic-1')).resolves.toBe('leaf-1');
    expect(upsertPiSessionLink).toHaveBeenCalledWith(
      expect.objectContaining({ piSessionId: 'pi-1', topicId: 'topic-1' })
    );
  });

  it('reconciles unresolved canonical cancellation without requiring a loaded conversation', async () => {
    const { bridge, store } = bridgeFixture(null);
    store.listPiSessionLinksWithUnresolvedCancellation.mockReturnValue([
      { pi_session_id: 'pi-parent', topic_id: 'topic-1' },
    ]);
    vi.spyOn((bridge as any).client, 'reconcilePiSessionCancellation').mockResolvedValue({
      ok: false,
      operation_id: 'op-1',
      generation: 4,
      state: 'stopping',
      targets: 1,
      unresolved_count: 1,
      effects_unknown_count: 0,
      error_count: 0,
      message: 'stopping',
    });
    await bridge.reconcileLoadedThreads();
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'stopping');
    expect(store.setRobotActivity).not.toHaveBeenCalledWith('topic-1', 'idle');
  });

  it('clears an unproven active origin before subscribing for turn replay', async () => {
    const { bridge, store, ensureSubscribed } = bridgeFixture({
      conversation_id: 'conversation-1',
      active_thread_id: 'conversation-1',
      activity: 'active',
    });
    await bridge.reconcileLoadedThreads();
    expect(store.clearActiveTurnOrigin).toHaveBeenCalledWith('topic-1');
    expect(ensureSubscribed).toHaveBeenCalledWith('conversation-1', { replay: true });
  });

  it.each(['stopping', 'uncertain'] as const)(
    'does not overwrite %s with thinking during active startup reconciliation',
    async (activity) => {
      const { bridge, store } = bridgeFixture({
        conversation_id: 'conversation-1',
        active_thread_id: 'conversation-1',
        activity: 'active',
      });
      store.getRobotState.mockReturnValue({ current_plan_id: null, activity });
      await bridge.reconcileLoadedThreads();
      expect(store.upsertRobotState).not.toHaveBeenCalled();
      expect(store.setRobotActivity).not.toHaveBeenCalledWith('topic-1', 'thinking');
    }
  );

  it('captures generation and dispatch identity when normal reply and steer turns are created', async () => {
    let generation = 6;
    const store = {
      getRobotState: vi.fn(() => ({ activity: 'idle' })),
      ensureSession: vi.fn(() => ({ id: 'session-1' })),
      getTopicDispatchGeneration: vi.fn(() => generation),
      upsertRobotState: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'shouldQueueTurn').mockReturnValue(true);
    vi.spyOn(bridge as any, 'processTurnQueue').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    await bridge.sendUserMessage('topic-1', 'reply', 'post-1');
    generation = 7;
    await bridge.steerUserMessage('topic-1', 'steer', 'post-2');
    const queued = (bridge as any).turnQueue as any[];
    expect(queued.map((turn) => turn.options.generation)).toEqual([6, 7]);
    expect(queued.every((turn) => typeof turn.options.dispatchId === 'string')).toBe(true);
  });

  it('does not open, create, or enqueue missing conversations and leaves canonical sessions idle', async () => {
    const { bridge, store, open, create, enqueue } = bridgeFixture(null);

    await expect(bridge.reconcileLoadedThreads()).resolves.toEqual({ reattached: 0, missing: 1 });

    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.clearSessionAgentThread).toHaveBeenCalledWith('session-1');
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'idle');
  });

  it('interrupt fences durable work and clears a queued local turn even without a loaded thread', async () => {
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: null })),
      getPiSessionLinkByTopic: vi.fn(() => null),
      getRobotState: vi.fn(() => null),
      advanceTopicDispatchGeneration: vi.fn(() => ({ generation: 3, cancelled: 1 })),
      getTopicDispatchGeneration: vi.fn(() => 3),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    (bridge as any).turnQueue.push({
      topicId: 'topic-1',
      sessionId: 'session-1',
      body: 'old',
      parentPostId: 'post-1',
      queuedAt: 'now',
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});

    await expect(bridge.interruptTopic('topic-1')).resolves.toMatchObject({ ok: true });

    expect(bridge.listQueuedTurns()).toEqual([]);
    expect(store.advanceTopicDispatchGeneration).toHaveBeenCalledWith('topic-1');
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'stopped');
  });

  it('publishes generation fence before awaiting agentd interrupt and sends that generation', async () => {
    const order: string[] = [];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: 'conversation-1' })),
      getPiSessionLinkByTopic: vi.fn(() => null),
      getRobotState: vi.fn(() => ({ activity: 'thinking' })),
      advanceTopicDispatchGeneration: vi.fn(() => {
        order.push('fence');
        return { generation: 8, cancelled: 1 };
      }),
      getTopicDispatchGeneration: vi.fn(() => 8),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    vi.spyOn((bridge as any).client, 'interruptConversation').mockImplementation(
      async (_id: string, generation: number, operationId: string) => {
        order.push(`agentd:${generation}`);
        await paused;
        return {
          ok: true,
          operation_id: operationId,
          generation,
          state: 'stopped',
          targets: 0,
          unresolved_count: 0,
          effects_unknown_count: 0,
          error_count: 0,
          message: 'stopped',
        };
      }
    );
    const interrupting = bridge.interruptTopic('topic-1');
    await Promise.resolve();
    expect(order).toEqual(['fence', 'agentd:8']);
    release();
    await expect(interrupting).resolves.toMatchObject({ ok: true, state: 'stopped', generation: 8 });
  });

  it('emits exactly one interrupted reset before unloaded stop can publish idle', async () => {
    const order: string[] = [];
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: null })),
      getPiSessionLinkByTopic: vi.fn(() => ({ pi_session_id: 'pi-parent' })),
      getRobotState: vi.fn(() => ({ activity: 'thinking' })),
      advanceTopicDispatchGeneration: vi.fn(() => ({ generation: 9, cancelled: 0 })),
      getTopicDispatchGeneration: vi.fn(() => 9),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      setRobotActivity: vi.fn((_topicId: string, activity: string) => {
        if (activity === 'stopped') order.push('stopped');
      }),
    };
    const bus = {
      emit: vi.fn((_topicId: string, event: { type: string }) => {
        if (event.type === 'assistant_reset') order.push('reset');
      }),
      subscribe: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, bus as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    vi.spyOn((bridge as any).client, 'cancelPiSession').mockResolvedValue({
      ok: true,
      operation_id: 'op',
      generation: 9,
      state: 'stopped',
      targets: 0,
      unresolved_count: 0,
      effects_unknown_count: 0,
      error_count: 0,
      message: 'stopped',
    });
    await bridge.interruptTopic('topic-1');
    expect(order).toEqual(['reset', 'stopped']);
    expect(bus.emit).toHaveBeenCalledTimes(1);
  });

  it('stops by canonical Pi session when the parent conversation is unloaded', async () => {
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: null })),
      getPiSessionLinkByTopic: vi.fn(() => ({ pi_session_id: 'pi-parent' })),
      getRobotState: vi.fn(() => ({ activity: 'thinking' })),
      advanceTopicDispatchGeneration: vi.fn(() => ({ generation: 9, cancelled: 0 })),
      getTopicDispatchGeneration: vi.fn(() => 9),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    const cancel = vi.spyOn((bridge as any).client, 'cancelPiSession').mockResolvedValue({
      ok: true,
      operation_id: 'op',
      generation: 9,
      state: 'stopped',
      targets: 2,
      unresolved_count: 0,
      effects_unknown_count: 0,
      error_count: 0,
      message: 'stopped',
    });
    await expect(bridge.interruptTopic('topic-1')).resolves.toMatchObject({ state: 'stopped', targets: 2 });
    expect(cancel).toHaveBeenCalledWith('pi-parent', expect.objectContaining({ generation: 9 }));
  });

  it.each(['stopping', 'uncertain'] as const)(
    'blocks queue and steer service paths while activity is %s',
    async (activity) => {
      const store = { getRobotState: vi.fn(() => ({ activity })), ensureSession: vi.fn() };
      const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model',
        workDir: '/tmp',
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage');
      await expect(bridge.sendUserMessage('topic-1', 'human post', 'post-1')).rejects.toThrow(/dispatch is fenced/);
      await expect(bridge.steerUserMessage('topic-1', 'human post', 'post-1')).rejects.toThrow(/dispatch is fenced/);
      expect(enqueue).not.toHaveBeenCalled();
      expect(store.ensureSession).not.toHaveBeenCalled();
    }
  );

  it('keeps the forum fence visibly uncertain after an agentd deadline', async () => {
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: null })),
      getPiSessionLinkByTopic: vi.fn(() => ({ pi_session_id: 'pi-parent' })),
      getRobotState: vi.fn(() => ({ activity: 'thinking' })),
      advanceTopicDispatchGeneration: vi.fn(() => ({ generation: 10, cancelled: 1 })),
      getTopicDispatchGeneration: vi.fn(() => 10),
      isTopicDispatchGenerationCurrent: vi.fn(() => true),
      setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    vi.spyOn((bridge as any).client, 'cancelPiSession').mockRejectedValue(
      new DOMException('timed out', 'TimeoutError')
    );
    await expect(bridge.interruptTopic('topic-1')).resolves.toMatchObject({
      ok: false,
      state: 'uncertain',
      generation: 10,
    });
    expect(store.setRobotActivity).toHaveBeenLastCalledWith('topic-1', 'uncertain');
  });

  it('ignores out-of-order turn_interrupted SSE and preserves current typed stopped state', () => {
    const generation = 2;
    let activity = 'stopping';
    const store = {
      isTopicDispatchGenerationCurrent: vi.fn((_topicId: string, candidate: number) => candidate === generation),
      getTopicDispatchGeneration: vi.fn(() => generation),
      getRobotState: vi.fn(() => ({ activity })),
      upsertRobotState: vi.fn((input: { activity: string }) => {
        activity = input.activity;
      }),
    };
    const bus = { emit: vi.fn(), subscribe: vi.fn() };
    const bridge = new EchsBridge(store as any, bus as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const context = {
      topicId: 'topic-1',
      sessionId: 'session-1',
      activeThreadId: 'conversation-1',
      lastUserPostId: 'post-1',
      turnParentPostId: 'post-1',
      planId: 'plan-1',
      reasoningSummary: '',
      reasoningBackfillAttempted: false,
      reasoningBackfillRetries: 0,
      model: 'model',
      reasoningEffort: null,
      currentTurnId: 'turn-current',
      turnStartedAt: 1,
      lastUsage: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      activeSubagents: new Map(),
      lastStreamEventAt: null,
      reasoningCheckpoints: [],
    };
    (bridge as any).threadMap.set('conversation-1', context);
    (bridge as any).handleEvent('conversation-1', {
      event: 'turn_interrupted',
      data: { generation: 1, operation_id: 'older', cancellation: { state: 'stopped' } },
    });
    expect(context.currentTurnId).toBe('turn-current');
    expect(store.upsertRobotState).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
    expect(activity).toBe('stopping');

    (bridge as any).handleEvent('conversation-1', {
      event: 'turn_interrupted',
      data: { generation, operation_id: 'current', cancellation: { state: 'stopped' } },
    });
    expect(context.currentTurnId).toBeNull();
    expect(store.upsertRobotState).toHaveBeenCalledWith(expect.objectContaining({ activity: 'stopped' }));
    expect(bus.emit).toHaveBeenCalledWith('topic-1', expect.objectContaining({ type: 'assistant_reset' }));
    expect(activity).toBe('stopped');
  });

  it('reattaches only a conversation agentd reports as already loaded', async () => {
    const { bridge, store, open } = bridgeFixture({
      conversation_id: 'conversation-1',
      active_thread_id: 'conversation-1',
      activity: 'idle',
    });

    await expect(bridge.reconcileLoadedThreads()).resolves.toEqual({ reattached: 1, missing: 0 });

    expect(open).not.toHaveBeenCalled();
    expect(store.clearSessionAgentThread).not.toHaveBeenCalled();
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'idle');
  });
});
