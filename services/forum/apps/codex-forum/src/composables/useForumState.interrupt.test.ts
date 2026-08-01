import type { RobotStateDto, TopicDto } from '@irrigationreal/codex-forum-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useForumState } from './useForumState';

const mocks = vi.hoisted(() => ({
  createStateStream: vi.fn(),
  getRobotState: vi.fn(),
  interruptRobot: vi.fn(),
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
    getRobotState: mocks.getRobotState,
    interruptRobot: mocks.interruptRobot,
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
  setRefreshToken: vi.fn(),
}));

class FakeStateStream {
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.listeners.clear();
  }
}

const state = useForumState();
const topic: TopicDto = {
  id: 'topic-1', forumId: 'forum-1', title: 'Stop trace', status: 'open', robotMode: 'auto',
  autoCompactEnabled: false, autoCompactRevision: 0, tags: [], createdBy: 'author-1',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastPostAt: null,
};
const thinkingState: RobotStateDto = {
  topicId: topic.id, sessionId: 'session-1', activity: 'thinking', lastUpdatedAt: new Date(0).toISOString(),
  currentPlan: { id: 'plan-1', content: 'reasoning before stop', summary: 'reasoning before stop', reasoningCheckpoints: [],
    visibility: 'internal', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  recentToolRuns: [],
};
const stoppedState: RobotStateDto = {
  topicId: topic.id, sessionId: 'session-1', activity: 'stopped', lastUpdatedAt: new Date(1).toISOString(),
  currentPlan: null, recentToolRuns: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPosts.mockResolvedValue({ items: [] });
  mocks.listIdentities.mockResolvedValue({ items: [] });
  mocks.listTopicPersonas.mockResolvedValue({ items: [] });
  mocks.listTopicAttachments.mockResolvedValue({ itemsByPostId: {} });
  mocks.listOperationalEvents.mockResolvedValue({ items: [] });
  mocks.getTopicAutoRun.mockResolvedValue(null);
  mocks.registrationMode.mockResolvedValue({ mode: 'disabled', registrationEnabled: false, inviteRegistrationEnabled: false, publicRegistrationEnabled: false });
});

afterEach(() => {
  state.clearTopic();
});

describe('interrupted live trace', () => {
  it('preserves the frozen trace through the actual Stop HTTP hydration flow', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    mocks.getRobotState.mockResolvedValueOnce(thinkingState).mockResolvedValueOnce(stoppedState);
    mocks.interruptRobot.mockResolvedValue({
      ok: true, operationId: 'stop-1', generation: 1, state: 'stopped', targets: 1,
      unresolvedCount: 0, effectsUnknownCount: 0, errorCount: 0, message: 'Stopped.',
    });

    await state.selectTopic(topic);
    expect(state.reasoningDraft.value).toBe('reasoning before stop');
    await state.interruptRobot();

    expect(mocks.interruptRobot).toHaveBeenCalledWith(topic.id);
    expect(state.robotState.value?.activity).toBe('stopped');
    expect(state.interruptedTrace.value).toBe(true);
    expect(state.committedSegments.value).toEqual([{ kind: 'reasoning', text: 'reasoning before stop' }]);
  });

  it('preserves committed trace when stopped state arrives over SSE without a live plan', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    mocks.getRobotState.mockResolvedValueOnce(thinkingState);

    await state.selectTopic(topic);
    expect(state.reasoningDraft.value).toBe('reasoning before stop');
    stream.emit('state', stoppedState);

    expect(state.robotState.value?.activity).toBe('stopped');
    expect(state.interruptedTrace.value).toBe(true);
    expect(state.committedSegments.value).toEqual([{ kind: 'reasoning', text: 'reasoning before stop' }]);
  });

  it('keeps the live trace active when Stop fails before a cancellation boundary', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    mocks.getRobotState.mockResolvedValueOnce(thinkingState);
    mocks.interruptRobot.mockRejectedValue(new Error('request failed'));

    await state.selectTopic(topic);
    await state.interruptRobot();

    expect(state.interruptedTrace.value).toBe(false);
    expect(state.reasoningDraft.value).toBe('reasoning before stop');
    expect(state.committedSegments.value).toEqual([]);
    expect(state.error.value).toBe('request failed');
  });
});
