import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useForumState } from './useForumState';

import type { RobotStateDto, TopicDto } from '@irrigationreal/codex-forum-contracts';

const mocks = vi.hoisted(() => ({
  createStateStream: vi.fn(),
  getTopic: vi.fn(),
  getRobotState: vi.fn(),
  listPosts: vi.fn(),
  listIdentities: vi.fn(),
  listTopicPersonas: vi.fn(),
  listTopicAttachments: vi.fn(),
  listOperationalEvents: vi.fn(),
  getTopicAutoRun: vi.fn(),
  registrationMode: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({
  api: {
    getTopic: mocks.getTopic,
    getRobotState: mocks.getRobotState,
    listPosts: mocks.listPosts,
    listIdentities: mocks.listIdentities,
    listTopicPersonas: mocks.listTopicPersonas,
    listTopicAttachments: mocks.listTopicAttachments,
    listOperationalEvents: mocks.listOperationalEvents,
    getTopicAutoRun: mocks.getTopicAutoRun,
    registrationMode: mocks.registrationMode,
  },
  createStateStream: mocks.createStateStream,
  getAuthToken: vi.fn(),
  setAuthToken: vi.fn(),
}));

class RetainedListenerStream {
  private listeners = new Map<string, EventListener[]>();
  closeCount = 0;

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closeCount += 1;
    // Deliberately retain callbacks to model an event queued before close().
  }
}

function topic(id: string): TopicDto {
  return {
    id,
    forumId: 'forum-1',
    title: id,
    status: 'open',
    robotMode: 'auto',
    autoCompactEnabled: false,
    autoCompactRevision: 0,
    tags: [],
    createdBy: 'author-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastPostAt: null,
  };
}

function robotState(topicId: string, activity: RobotStateDto['activity']): RobotStateDto {
  return {
    topicId,
    sessionId: `session-${topicId}`,
    activity,
    lastUpdatedAt: new Date(0).toISOString(),
    currentPlan: null,
    recentToolRuns: [],
  };
}

const state = useForumState();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPosts.mockResolvedValue({ items: [] });
  mocks.listIdentities.mockResolvedValue({ items: [] });
  mocks.listTopicPersonas.mockResolvedValue({ items: [] });
  mocks.listTopicAttachments.mockResolvedValue({ itemsByPostId: {} });
  mocks.listOperationalEvents.mockResolvedValue({ items: [] });
  mocks.getTopicAutoRun.mockResolvedValue(null);
  mocks.registrationMode.mockResolvedValue({
    mode: 'disabled',
    registrationEnabled: false,
    inviteRegistrationEnabled: false,
    publicRegistrationEnabled: false,
    passwordLoginEnabled: false,
  });
});

afterEach(() => {
  state.clearTopic();
});

describe('topic stream isolation', () => {
  it('reopens immediately and rejects an older reconnect snapshot after a replacement-stream event', async () => {
    vi.useFakeTimers();
    try {
      const originalStream = new RetainedListenerStream();
      const replacementStream = new RetainedListenerStream();
      const reconnectState = Promise.withResolvers<RobotStateDto>();
      mocks.createStateStream.mockReturnValueOnce(originalStream).mockReturnValueOnce(replacementStream);
      mocks.getRobotState
        .mockResolvedValueOnce(robotState('topic-1', 'thinking'))
        .mockReturnValueOnce(reconnectState.promise);

      await state.selectTopic(topic('topic-1'));
      originalStream.emit('error');
      await vi.advanceTimersByTimeAsync(2000);

      expect(mocks.getRobotState).toHaveBeenCalledTimes(1);
      expect(mocks.createStateStream).toHaveBeenCalledTimes(2);

      replacementStream.emit('open');
      expect(mocks.getRobotState).toHaveBeenCalledTimes(2);
      replacementStream.emit('state', robotState('topic-1', 'stopped'));
      reconnectState.resolve(robotState('topic-1', 'idle'));
      await Promise.resolve();
      await Promise.resolve();

      expect(state.robotState.value?.activity).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the destination neutral until its robot state finishes hydrating', async () => {
    const sourceStream = new RetainedListenerStream();
    const destinationStream = new RetainedListenerStream();
    const destinationState = Promise.withResolvers<RobotStateDto>();
    mocks.createStateStream.mockReturnValueOnce(sourceStream).mockReturnValueOnce(destinationStream);
    mocks.getTopic.mockResolvedValue(topic('destination'));
    mocks.getRobotState.mockImplementation((topicId: string) =>
      topicId === 'destination' ? destinationState.promise : Promise.resolve(robotState(topicId, 'thinking'))
    );

    await state.selectTopic(topic('source'));
    const selection = state.selectTopicById('destination');
    await vi.waitFor(() => {
      expect(state.selectedTopic.value?.id).toBe('destination');
    });

    expect(state.robotState.value).toBeNull();
    expect(state.hasPendingAssistantTurn.value).toBe(false);
    expect(state.reasoningDraft.value).toBe('');
    expect(state.committedSegments.value).toEqual([]);

    destinationState.resolve(robotState('destination', 'idle'));
    await selection;
    expect(state.robotState.value?.activity).toBe('idle');
  });

  it('ignores every retained callback from the previously selected topic', async () => {
    const sourceStream = new RetainedListenerStream();
    const destinationStream = new RetainedListenerStream();
    mocks.createStateStream.mockReturnValueOnce(sourceStream).mockReturnValueOnce(destinationStream);
    mocks.getRobotState.mockImplementation((topicId: string) =>
      Promise.resolve(robotState(topicId, topicId === 'source' ? 'thinking' : 'idle'))
    );

    await state.selectTopic(topic('source'));
    await state.selectTopic(topic('destination'));
    const baselinePostLoads = mocks.listPosts.mock.calls.length;

    sourceStream.emit('context_updated', { totalTokens: 10 });
    sourceStream.emit('state', robotState('source', 'thinking'));
    sourceStream.emit('reasoning_delta', { delta: 'stale reasoning' });
    sourceStream.emit('tool_started', { toolRunId: 'stale-tool' });
    sourceStream.emit('assistant_reset', { reason: 'new_dispatch' });
    sourceStream.emit('assistant_message');
    sourceStream.emit('assistant_error');
    sourceStream.emit('operational_event');
    sourceStream.emit('error');
    await Promise.resolve();

    expect(state.selectedTopic.value?.id).toBe('destination');
    expect(state.robotState.value).toEqual(robotState('destination', 'idle'));
    const sessionContext = state.sessionContext as unknown as { value: unknown };
    expect(sessionContext.value).toBeNull();
    expect(state.reasoningDraft.value).toBe('');
    expect(state.committedSegments.value).toEqual([]);
    expect(mocks.listPosts).toHaveBeenCalledTimes(baselinePostLoads);
    expect(mocks.listOperationalEvents).toHaveBeenCalledTimes(2);
    expect(mocks.createStateStream).toHaveBeenCalledTimes(2);
    expect(destinationStream.closeCount).toBe(0);
  });
});
