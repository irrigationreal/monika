import { describe, expect, it, vi } from 'vitest';

import { EchsBridge } from './echsBridge';
import { EchsClient } from './echsClient';

describe('passive ECHS startup reconciliation', () => {
  it('carries stable dispatch identity and generation to agentd', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({ message_id: 'dispatch-1', deduplicated: true });
    const result = await client.enqueueConversationMessage('conversation-1', 'work', {
      messageId: 'dispatch-1', dispatchId: 'dispatch-1', generation: 7,
    });
    expect(request).toHaveBeenCalledWith('/v1/conversations/conversation-1/messages', {
      method: 'POST',
      body: { mode: 'queue', content: 'work', message_id: 'dispatch-1', dispatch_id: 'dispatch-1', generation: 7 },
    });
    expect(result).toMatchObject({ messageId: 'dispatch-1', deduplicated: true });
  });

  function bridgeFixture(conversation: Record<string, unknown> | null) {
    const session = {
      id: 'session-1', topic_id: 'topic-1', agent_thread_id: 'conversation-1',
      last_dispatched_post_id: 'post-1',
    };
    const store = {
      listSessionsWithThreads: vi.fn(() => [session]),
      clearSessionAgentThread: vi.fn(),
      setRobotActivity: vi.fn(),
      getRobotState: vi.fn(() => ({ current_plan_id: null })),
      upsertRobotState: vi.fn(),
      getLatestPostId: vi.fn(),
      setSessionLastDispatchedPostId: vi.fn(),
    };
    const bus = { emit: vi.fn(), subscribe: vi.fn() };
    const bridge = new EchsBridge(store as any, bus as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue(conversation);
    const create = vi.spyOn((bridge as any).client, 'createConversation');
    const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage');
    vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    const open = vi.spyOn(bridge as any, 'openTopicConversation');
    return { bridge, store, open, create, enqueue };
  }

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
      advanceTopicDispatchGeneration: vi.fn(() => ({ generation: 3, cancelled: 1 })), setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    (bridge as any).turnQueue.push({ topicId: 'topic-1', sessionId: 'session-1', body: 'old', parentPostId: 'post-1', queuedAt: 'now' });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});

    await expect(bridge.interruptTopic('topic-1')).resolves.toMatchObject({ ok: true });

    expect(bridge.listQueuedTurns()).toEqual([]);
    expect(store.advanceTopicDispatchGeneration).toHaveBeenCalledWith('topic-1');
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'idle');
  });

  it('publishes generation fence before awaiting agentd interrupt and sends that generation', async () => {
    const order: string[] = [];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: 'conversation-1' })),
      advanceTopicDispatchGeneration: vi.fn(() => { order.push('fence'); return { generation: 8, cancelled: 1 }; }),
      setRobotActivity: vi.fn(),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    vi.spyOn((bridge as any).client, 'interruptConversation').mockImplementation(async (_id: string, generation: number) => {
      order.push(`agentd:${generation}`); await paused;
    });
    const interrupting = bridge.interruptTopic('topic-1');
    await Promise.resolve();
    expect(order).toEqual(['fence', 'agentd:8']);
    release();
    await expect(interrupting).resolves.toMatchObject({ ok: true });
  });

  it('reattaches only a conversation agentd reports as already loaded', async () => {
    const { bridge, store, open } = bridgeFixture({
      conversation_id: 'conversation-1', active_thread_id: 'conversation-1', activity: 'idle',
    });

    await expect(bridge.reconcileLoadedThreads()).resolves.toEqual({ reattached: 1, missing: 0 });

    expect(open).not.toHaveBeenCalled();
    expect(store.clearSessionAgentThread).not.toHaveBeenCalled();
    expect(store.setRobotActivity).toHaveBeenCalledWith('topic-1', 'idle');
  });
});
