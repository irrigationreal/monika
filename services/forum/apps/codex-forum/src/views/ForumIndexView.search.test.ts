import { ref } from 'vue';

import { fireEvent, render, screen } from '@testing-library/vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ForumIndexView from './ForumIndexView.vue';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  loadForums: vi.fn(),
  loadTopicsWithFilter: vi.fn(),
  selectForum: vi.fn(),
  setError: vi.fn(),
  clearTopic: vi.fn(),
}));

vi.mock('../lib/apiClient', () => ({
  api: {
    search: mocks.search,
  },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
  useRoute: () => ({
    params: { forumId: 'forum-public' },
  }),
}));

vi.mock('../composables/useForumState', () => ({
  useForumState: () => ({
    topics: ref([]),
    forums: ref([{ id: 'forum-public', name: 'Public', description: null }]),
    selectedForum: ref({ id: 'forum-public', name: 'Public', description: null }),
    loading: ref(false),
    dateFilter: ref('all'),
    isLoggedIn: ref(false),
    canShowRegisterLink: ref(false),
    POSTS_PER_PAGE: 25,
    setDateFilter: vi.fn(),
    formatDate: (value: string) => value,
    loadForums: mocks.loadForums,
    loadTopicsWithFilter: mocks.loadTopicsWithFilter,
    selectForum: mocks.selectForum,
    setError: mocks.setError,
    clearTopic: mocks.clearTopic,
  }),
}));

function renderForumIndex() {
  return render(ForumIndexView, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('ForumIndexView search rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search result bodies as text, not HTML', async () => {
    mocks.search.mockResolvedValue({
      topics: [],
      posts: [
        {
          id: 'post-1',
          topicId: 'topic-1',
          authorId: 'author-1',
          parentPostId: null,
          body: '<img src=x onerror=alert(1)> needle',
          createdAt: '2026-06-20T18:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          sourceMessageId: null,
          silent: false,
        },
      ],
    });

    const { container } = renderForumIndex();
    await fireEvent.update(screen.getByPlaceholderText('Search...'), 'needle');
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(mocks.search).toHaveBeenCalledWith('needle', 'all', { forumId: 'forum-public' });
    expect(screen.getByText('<img src=x onerror=alert(1)> needle')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('can toggle global search across visible forums', async () => {
    mocks.search.mockResolvedValue({ topics: [], posts: [] });

    renderForumIndex();
    await fireEvent.update(screen.getByPlaceholderText('Search...'), 'needle');
    await fireEvent.click(screen.getByLabelText('Search all visible forums'));
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(mocks.search).toHaveBeenCalledWith('needle', 'all', { forumId: undefined });
  });
});
