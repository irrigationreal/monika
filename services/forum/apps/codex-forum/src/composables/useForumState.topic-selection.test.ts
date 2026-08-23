import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useForumState } from './useForumState';

import type { TopicDto } from '@irrigationreal/codex-forum-contracts';

const mocks = vi.hoisted(() => ({
  getTopic: vi.fn(),
  listPosts: vi.fn(),
  listIdentities: vi.fn(),
  listTopicPersonas: vi.fn(),
  listTopicAttachments: vi.fn(),
  listOperationalEvents: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({
  api: {
    getTopic: mocks.getTopic,
    listPosts: mocks.listPosts,
    listIdentities: mocks.listIdentities,
    listTopicPersonas: mocks.listTopicPersonas,
    listTopicAttachments: mocks.listTopicAttachments,
    listOperationalEvents: mocks.listOperationalEvents,
  },
  createStateStream: vi.fn(),
  getAuthToken: vi.fn(),
  setAuthToken: vi.fn(),
}));

function topic(id: string, status: TopicDto['status'] = 'open'): TopicDto {
  return {
    id,
    forumId: 'forum-1',
    title: id,
    status,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const state = useForumState();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPosts.mockResolvedValue({ items: [] });
  mocks.listIdentities.mockResolvedValue({ items: [] });
  mocks.listTopicPersonas.mockResolvedValue({ items: [] });
  mocks.listTopicAttachments.mockResolvedValue({ itemsByPostId: {} });
  mocks.listOperationalEvents.mockResolvedValue({ items: [] });
});

afterEach(() => {
  state.clearTopic();
});

describe('topic selection request fencing', () => {
  it('keeps the latest topic when earlier requests resolve last', async () => {
    const slow = deferred<TopicDto>();
    const fast = deferred<TopicDto>();
    mocks.getTopic.mockImplementation((id: string) => (id === 'slow' ? slow.promise : fast.promise));

    const slowSelection = state.selectTopicById('slow', { hydrateState: false });
    const fastSelection = state.selectTopicById('fast', { hydrateState: false });

    fast.resolve(topic('fast', 'open'));
    await fastSelection;
    expect(state.selectedTopic.value?.id).toBe('fast');

    slow.resolve(topic('slow', 'locked'));
    await slowSelection;
    expect(state.selectedTopic.value?.id).toBe('fast');
    expect(mocks.listPosts).toHaveBeenCalledTimes(1);
  });

  it('ignores an older topic fetch failure after a newer selection wins', async () => {
    const stale = deferred<TopicDto>();
    const current = deferred<TopicDto>();
    mocks.getTopic.mockImplementation((id: string) => (id === 'stale' ? stale.promise : current.promise));

    const staleSelection = state.selectTopicById('stale', { hydrateState: false });
    const currentSelection = state.selectTopicById('current', { hydrateState: false });
    current.resolve(topic('current'));
    await currentSelection;

    stale.reject(new Error('stale request failed'));
    await expect(staleSelection).resolves.toBeUndefined();
    expect(state.selectedTopic.value?.id).toBe('current');
  });

  it('loads a normally resolved topic', async () => {
    mocks.getTopic.mockResolvedValue(topic('topic-1'));

    await state.selectTopicById('topic-1', { hydrateState: false });

    expect(state.selectedTopic.value?.id).toBe('topic-1');
    expect(mocks.listPosts).toHaveBeenCalledWith('topic-1', {
      page: 1,
      pageSize: 100_000,
      include: ['reactions'],
    });
  });

  it('clears the previous projection before the destination topic record resolves', async () => {
    await state.selectTopic(topic('source'), { hydrateState: false });
    state.posts.value = [{ id: 'source-post' } as never];
    state.robotState.value = {
      topicId: 'source',
      sessionId: 'session-source',
      activity: 'thinking',
      lastUpdatedAt: new Date(0).toISOString(),
      currentPlan: null,
      recentToolRuns: [],
    };

    const destination = deferred<TopicDto>();
    mocks.getTopic.mockReturnValue(destination.promise);
    const selection = state.selectTopicById('destination', { hydrateState: false });

    expect(state.selectedTopic.value).toBeNull();
    expect(state.posts.value).toEqual([]);
    expect(state.robotState.value).toBeNull();
    expect(state.hasPendingAssistantTurn.value).toBe(false);

    destination.resolve(topic('destination'));
    await selection;
    expect(state.selectedTopic.value?.id).toBe('destination');
  });

  it('ignores an old hydration failure after a newer topic selection wins', async () => {
    const stalePosts = deferred<{ items: [] }>();
    mocks.listPosts.mockImplementationOnce(() => stalePosts.promise).mockResolvedValueOnce({ items: [] });

    const staleSelection = state.selectTopic(topic('stale'), { hydrateState: false });
    const currentSelection = state.selectTopic(topic('current'), { hydrateState: false });
    await currentSelection;

    stalePosts.reject(new Error('stale hydration failed'));
    await expect(staleSelection).resolves.toBeUndefined();
    expect(state.selectedTopic.value?.id).toBe('current');
  });

  it('rejects an old response after navigating away and back to the same topic id', async () => {
    const oldA = deferred<{ items: { id: string }[] }>();
    const currentA = deferred<{ items: { id: string }[] }>();
    mocks.listPosts
      .mockImplementationOnce(() => oldA.promise)
      .mockResolvedValueOnce({ items: [{ id: 'topic-b-post' }] })
      .mockImplementationOnce(() => currentA.promise);

    const firstASelection = state.selectTopic(topic('topic-a'), { hydrateState: false });
    await state.selectTopic(topic('topic-b'), { hydrateState: false });
    const currentASelection = state.selectTopic(topic('topic-a'), { hydrateState: false });
    currentA.resolve({ items: [{ id: 'current-topic-a-post' }] });
    await currentASelection;

    oldA.resolve({ items: [{ id: 'stale-topic-a-post' }] });
    await firstASelection;

    expect(state.selectedTopic.value?.id).toBe('topic-a');
    expect(state.posts.value).toEqual([{ id: 'current-topic-a-post' }]);
  });
});
