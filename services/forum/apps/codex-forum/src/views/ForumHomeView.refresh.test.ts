import { ref } from 'vue';

import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ForumHomeView from './ForumHomeView.vue';

import type { RecentPostDto } from '../lib/apiClient';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  clearTopic: vi.fn(),
  clearForum: vi.fn(),
  loadForums: vi.fn(),
  loadArchivedForums: vi.fn(),
  loadRecentPosts: vi.fn(),
  loadForumLeaders: vi.fn(),
  setError: vi.fn(),
}));

const state = {
  forums: ref<Record<string, unknown>[]>([]),
  archivedForums: ref<Record<string, unknown>[]>([]),
  recentPosts: ref<RecentPostDto[]>([]),
  forumLeaders: ref<Record<string, unknown>[]>([]),
  forumLeadersLoading: ref(false),
  forumLeadersError: ref<string | null>(null),
  currentUser: ref(null),
  loading: ref(false),
  clearTopic: mocks.clearTopic,
  clearForum: mocks.clearForum,
  loadForums: mocks.loadForums,
  loadArchivedForums: mocks.loadArchivedForums,
  loadRecentPosts: mocks.loadRecentPosts,
  loadForumLeaders: mocks.loadForumLeaders,
  setError: mocks.setError,
};

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('../composables/useForumState', () => ({
  useForumState: () => state,
}));

function recentPost(postId: string, topicTitle: string): RecentPostDto {
  return {
    postId,
    topicId: `topic-${postId}`,
    topicTitle,
    forumId: 'forum-1',
    forumName: 'General',
    authorId: 'author-1',
    authorName: 'Neon',
    body: 'Reply body',
    createdAt: '2026-07-31T09:00:00.000Z',
  };
}

function renderHome() {
  return shallowMount(ForumHomeView, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('ForumHomeView snapshot refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.forums.value = [];
    state.archivedForums.value = [];
    state.recentPosts.value = [recentPost('old', 'Older reply')];
    mocks.loadForums.mockResolvedValue(undefined);
    mocks.loadArchivedForums.mockResolvedValue(undefined);
    mocks.loadRecentPosts.mockResolvedValue(undefined);
    mocks.loadForumLeaders.mockResolvedValue(undefined);
  });

  it('refreshes homepage snapshots on every route entry even when cached values exist', async () => {
    let view = renderHome();
    await flushPromises();

    expect(mocks.loadForums).toHaveBeenCalledWith({ includeArchived: false });
    expect(mocks.loadArchivedForums).toHaveBeenCalledTimes(1);
    expect(mocks.loadRecentPosts).toHaveBeenCalledWith(3);
    view.unmount();

    mocks.loadRecentPosts.mockImplementationOnce(() => {
      state.recentPosts.value = [recentPost('new', 'Newest reply')];
      return Promise.resolve();
    });
    view = renderHome();
    await flushPromises();

    expect(mocks.loadForums).toHaveBeenCalledTimes(2);
    expect(mocks.loadArchivedForums).toHaveBeenCalledTimes(2);
    expect(mocks.loadRecentPosts).toHaveBeenCalledTimes(2);
    expect(view.text()).toContain('Newest reply');
  });
});
