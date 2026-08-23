import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useForumState } from './useForumState';

import type { RobotStateDto, TopicDto } from '@irrigationreal/codex-forum-contracts';

const mocks = vi.hoisted(() => ({
  createStateStream: vi.fn(),
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

class FakeStateStream {
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as (event: MessageEvent<string>) => void]);
  }
  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close(): void {
    this.listeners.clear();
  }
}

const state = useForumState();
const topic: TopicDto = {
  id: 'topic-multi',
  forumId: 'forum-1',
  title: 'Multiple items',
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
const thinking: RobotStateDto = {
  topicId: topic.id,
  sessionId: 'session-1',
  activity: 'thinking',
  lastUpdatedAt: new Date(0).toISOString(),
  currentPlan: null,
  recentToolRuns: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPosts.mockResolvedValue({ items: [] });
  mocks.listIdentities.mockResolvedValue({ items: [] });
  mocks.listTopicPersonas.mockResolvedValue({ items: [] });
  mocks.listTopicAttachments.mockResolvedValue({ itemsByPostId: {} });
  mocks.listOperationalEvents.mockResolvedValue({ items: [] });
  mocks.getTopicAutoRun.mockResolvedValue(null);
  mocks.getRobotState.mockResolvedValue(thinking);
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

describe('canonical assistant item reloads', () => {
  it('preserves a newer interrupted trace when delayed projection completes', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    await state.selectTopic(topic);

    stream.emit('reasoning_delta', { delta: 'reasoning before interruption' });
    stream.emit('assistant_reset', { reason: 'interrupted' });
    expect(state.interruptedTrace.value).toBe(true);
    const frozen = [...state.committedSegments.value];

    stream.emit('assistant_message');
    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(2);
      expect(mocks.getTopicAutoRun).toHaveBeenCalledTimes(2);
    });
    expect(state.interruptedTrace.value).toBe(true);
    expect(state.committedSegments.value).toEqual(frozen);
  });

  it('continues draining a queued item after an earlier reload fails', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    await state.selectTopic(topic);

    const failedReload = Promise.withResolvers<{ items: [] }>();
    mocks.listPosts.mockImplementationOnce(() => failedReload.promise).mockResolvedValueOnce({ items: [] });
    stream.emit('assistant_message');
    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(2);
    });
    stream.emit('assistant_message');
    failedReload.reject(new Error('first reload failed'));

    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(3);
      expect(mocks.getRobotState).toHaveBeenCalledTimes(2);
    });
  });

  it('preserves trace events for the continuing turn while the projected item reloads', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    await state.selectTopic(topic);

    const postReload = Promise.withResolvers<{ items: [] }>();
    mocks.listPosts.mockImplementationOnce(() => postReload.promise);
    stream.emit('assistant_message');
    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(2);
    });

    stream.emit('reasoning_delta', { delta: 'next item reasoning' });
    stream.emit('tool_started', { toolRunId: 'next-item-tool' });
    postReload.resolve({ items: [] });

    await vi.waitFor(() => {
      expect(state.committedSegments.value).toEqual([
        { kind: 'reasoning', text: 'next item reasoning' },
        { kind: 'tool', toolRunId: 'next-item-tool' },
      ]);
    });
  });

  it('queues a second completion arriving during reload and waits for server idle state', async () => {
    const stream = new FakeStateStream();
    mocks.createStateStream.mockReturnValue(stream);
    await state.selectTopic(topic);

    const firstReload = Promise.withResolvers<{ items: [] }>();
    mocks.listPosts.mockImplementationOnce(() => firstReload.promise).mockResolvedValueOnce({ items: [] });
    stream.emit('assistant_message');
    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(2);
    });
    stream.emit('assistant_message');
    stream.emit('reasoning_delta', { delta: 'reasoning after second item' });
    stream.emit('tool_started', { toolRunId: 'post-second-item-tool' });
    firstReload.resolve({ items: [] });

    await vi.waitFor(() => {
      expect(mocks.listPosts).toHaveBeenCalledTimes(3);
    });
    expect(state.robotState.value?.activity).toBe('thinking');
    expect(state.committedSegments.value).toEqual([
      { kind: 'reasoning', text: 'reasoning after second item' },
      { kind: 'tool', toolRunId: 'post-second-item-tool' },
    ]);

    stream.emit('state', { ...thinking, activity: 'idle' });
    expect(state.robotState.value?.activity).toBe('idle');
  });
});
