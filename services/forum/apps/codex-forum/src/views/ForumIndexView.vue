<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useForumState } from '../composables/useForumState';
import { api, type TopicDto, type PostDto } from '../lib/apiClient';

const router = useRouter();
const route = useRoute();
const state = useForumState();

const searchQuery = ref('');
const searchResults = ref<{ topics: TopicDto[]; posts: PostDto[] } | null>(null);
const isSearching = ref(false);

const routeForumId = computed(() => (route.params['forumId'] as string | undefined) ?? null);
const stickyThreads = computed(() => state.topics.value.filter((t) => t.tags.includes('sticky')));
const normalThreads = computed(() => state.topics.value.filter((t) => !t.tags.includes('sticky')));
const showSearchResults = computed(() => searchResults.value !== null && searchQuery.value.length >= 2);
const hasNoTopics = computed(() => stickyThreads.value.length === 0 && normalThreads.value.length === 0 && !state.loading.value);
const forumName = computed(() => state.selectedForum.value?.name ?? 'Forum');
const dateFilter = computed({
  get: () => state.dateFilter.value,
  set: (value: string) => state.setDateFilter(value)
});

function topicTotalPages(topic: TopicDto): number {
  const totalPosts = topic.postCount ?? 0;
  return Math.max(1, Math.ceil(totalPosts / state.POSTS_PER_PAGE));
}

function topicPageNumbers(topic: TopicDto): (number | '...')[] {
  const total = topicTotalPages(topic);
  const pages: (number | '...')[] = [];

  // Keep the thread list compact: show up to ~7 page links.
  // Examples:
  // - total <= 7: 1 2 3 4 5 6 7
  // - total = 10: 1 2 3 ... 9 10
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
    return pages;
  }

  pages.push(1, 2, 3, '...', total - 1, total);
  return pages;
}

async function handleSelectTopicPage(topicId: string, page: number): Promise<void> {
  await router.push({ name: 'topic.view', params: { topicId }, query: { page: String(page) } });
}

function getRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return state.formatDate(dateStr);
}

function goToNewThread(): void {
  if (!routeForumId.value) return;
  router.push({ name: 'forum.newthread', params: { forumId: routeForumId.value } });
}

async function handleSelectTopic(topicId: string): Promise<void> {
  await router.push({ name: 'topic.view', params: { topicId } });
}

async function handleSearch(): Promise<void> {
  if (searchQuery.value.trim().length < 2) {
    searchResults.value = null;
    return;
  }
  isSearching.value = true;
  try {
    searchResults.value = await api.search(searchQuery.value.trim());
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Search failed.');
  } finally {
    isSearching.value = false;
  }
}

function clearSearch(): void {
  searchQuery.value = '';
  searchResults.value = null;
}

async function loadForumData(forumId: string): Promise<void> {
  try {
    const cachedForum = state.forums.value.find((forum) => forum.id === forumId) ?? null;
    if (!cachedForum) {
      await state.loadForums({ includeArchived: true });
    }
    state.selectForum(forumId);
    await state.loadTopicsWithFilter();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to load forum data.');
  }
}

async function applyDateFilter(): Promise<void> {
  try {
    await state.loadTopicsWithFilter();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to load forum topics.');
  }
}

watch(routeForumId, async (forumId) => {
  if (forumId) {
    await loadForumData(forumId);
  }
}, { immediate: true });

onMounted(() => {
  state.clearTopic();
});
</script>

<template>
  <section class="vb-section vb-fade-in">
    <!-- Forum Title -->
    <div class="vb-forum-title-bar">
      <div class="vb-forum-icon-large">&#128194;</div>
      <div class="vb-forum-title-info">
        <h2 class="vb-forum-name">{{ forumName }}</h2>
        <p v-if="state.selectedForum.value?.description" class="vb-forum-desc">
          {{ state.selectedForum.value.description }}
        </p>
      </div>
    </div>

    <div class="vb-controls">
      <button
        v-if="state.isLoggedIn.value"
        class="vb-btn"
        :disabled="state.loading.value"
        @click="goToNewThread"
      >
        New Thread
      </button>
      <div class="vb-pagination">Page 1 of 1</div>
    </div>

    <div class="vb-tools">
      <div class="vb-menu">Forum Tools</div>
      <div class="vb-search-box">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search..."
          class="vb-search-input"
          @keyup.enter="handleSearch"
        />
        <button class="vb-small-btn" :disabled="isSearching" @click="handleSearch">Search</button>
        <button v-if="searchQuery" class="vb-small-btn" @click="clearSearch">Clear</button>
      </div>
    </div>

    <div v-if="showSearchResults" class="vb-search-results">
      <div class="vb-table-header">
        Search Results for "{{ searchQuery }}"
        <button class="vb-small-btn" @click="clearSearch">Close</button>
      </div>
      <div class="vb-search-body">
        <div v-if="searchResults?.topics.length === 0 && searchResults?.posts.length === 0" class="vb-empty">
          No results found.
        </div>
        <div v-if="searchResults && searchResults.topics.length > 0">
          <strong>Topics ({{ searchResults.topics.length }})</strong>
          <div v-for="topic in searchResults.topics" :key="topic.id" class="vb-search-item" @click="handleSelectTopic(topic.id)">
            <div class="vb-search-title">{{ topic.title }}</div>
            <div class="vb-search-meta">{{ state.formatDate(topic.createdAt) }}</div>
          </div>
        </div>
        <div v-if="searchResults && searchResults.posts.length > 0">
          <strong>Posts ({{ searchResults.posts.length }})</strong>
          <div v-for="post in searchResults.posts" :key="post.id" class="vb-search-item" @click="handleSelectTopic(post.topicId)">
            <div class="vb-search-text">{{ post.body }}</div>
            <div class="vb-search-meta">{{ state.formatDate(post.createdAt) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="state.loading.value && hasNoTopics" class="vb-empty-state">
      <div class="vb-spinner vb-spinner-dark" style="width: 24px; height: 24px;"></div>
      <div class="vb-empty-state-text" style="margin-top: 12px;">Loading forum topics...</div>
    </div>

    <!-- Empty State -->
    <div v-else-if="hasNoTopics" class="vb-empty-state">
      <div class="vb-empty-state-icon">&#128196;</div>
      <div class="vb-empty-state-text">No topics have been created yet.</div>
      <div class="vb-empty-state-hint">Be the first to start a discussion by creating a new thread below.</div>
    </div>

    <!-- Topics Table -->
    <div v-else>
      <!-- Mobile Topic List (compact) -->
      <div class="vb-topic-list-mobile">
        <div v-if="stickyThreads.length > 0" class="vb-topic-section">
          <div class="vb-topic-section-title">Sticky Threads</div>
          <button
            v-for="topic in stickyThreads"
            :key="topic.id"
            type="button"
            class="vb-topic-item vb-topic-item--sticky"
            @click="handleSelectTopic(topic.id)"
          >
            <div class="vb-topic-item-left">
              <div class="vb-topic-item-title">
                <span class="vb-topic-item-icon" aria-hidden="true">&#128204;</span>
                <span class="vb-topic-item-title-text">{{ topic.title }}</span>
                <span v-if="topic.status === 'locked'" class="vb-topic-item-lock" aria-label="Locked"> &#128274;</span>
              </div>
              <div
                v-if="topicTotalPages(topic) > 1"
                class="vb-thread-pages"
                @click.stop
              >
                <span class="vb-thread-pages-label">Pages:</span>
                <template v-for="(page, idx) in topicPageNumbers(topic)" :key="idx">
                  <span v-if="page === '...'" class="vb-thread-pages-ellipsis">…</span>
                  <button
                    v-else
                    type="button"
                    class="vb-thread-pages-link"
                    @click="handleSelectTopicPage(topic.id, page)"
                  >{{ page }}</button>
                </template>
              </div>
              <div class="vb-topic-item-meta">
                {{ state.topicStarterName(topic) }} · {{ getRelativeTime(topic.createdAt) }}
              </div>
            </div>

            <div class="vb-topic-item-right">
              <div class="vb-topic-item-last">
                {{ getRelativeTime(topic.lastPostAt || topic.updatedAt) }}
              </div>
              <div class="vb-topic-item-replies">
                <span class="vb-topic-item-replies-num">{{ topic.postCount ?? 0 }}</span>
                <span class="vb-topic-item-replies-label">replies</span>
              </div>
            </div>
          </button>
        </div>

        <div class="vb-topic-section">
          <div class="vb-topic-section-title">Threads</div>

          <div v-if="normalThreads.length === 0" class="vb-topic-empty">
            No threads yet. Create the first topic.
          </div>

          <button
            v-for="topic in normalThreads"
            :key="topic.id"
            type="button"
            class="vb-topic-item"
            @click="handleSelectTopic(topic.id)"
          >
            <div class="vb-topic-item-left">
              <div class="vb-topic-item-title">
                <span class="vb-topic-item-icon" aria-hidden="true">&#128194;</span>
                <span class="vb-topic-item-title-text">{{ topic.title }}</span>
                <span v-if="topic.status === 'locked'" class="vb-topic-item-lock" aria-label="Locked"> &#128274;</span>
              </div>
              <div
                v-if="topicTotalPages(topic) > 1"
                class="vb-thread-pages"
                @click.stop
              >
                <span class="vb-thread-pages-label">Pages:</span>
                <template v-for="(page, idx) in topicPageNumbers(topic)" :key="idx">
                  <span v-if="page === '...'" class="vb-thread-pages-ellipsis">…</span>
                  <button
                    v-else
                    type="button"
                    class="vb-thread-pages-link"
                    @click="handleSelectTopicPage(topic.id, page)"
                  >{{ page }}</button>
                </template>
              </div>
              <div class="vb-topic-item-meta">
                {{ state.topicStarterName(topic) }} · {{ getRelativeTime(topic.createdAt) }}
              </div>
            </div>

            <div class="vb-topic-item-right">
              <div class="vb-topic-item-last">
                {{ getRelativeTime(topic.lastPostAt || topic.updatedAt) }}
              </div>
              <div class="vb-topic-item-replies">
                <span class="vb-topic-item-replies-num">{{ topic.postCount ?? 0 }}</span>
                <span class="vb-topic-item-replies-label">replies</span>
              </div>
            </div>
          </button>
        </div>
      </div>

      <!-- Desktop Table (existing) -->
      <div class="vb-table-wrapper vb-topic-list-desktop">
        <table class="vb-table">
          <thead>
            <tr>
              <th class="vb-icon-col"></th>
              <th class="vb-icon-col"></th>
              <th>Thread / Thread Starter</th>
              <th>Last Post</th>
              <th>Replies</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="stickyThreads.length > 0" class="vb-table-section">
              <td colspan="5">Sticky Threads</td>
            </tr>
            <tr
              v-for="topic in stickyThreads"
              :key="topic.id"
              class="vb-table-row vb-slide-in"
              @click="handleSelectTopic(topic.id)"
            >
              <td class="vb-icon-cell">&#128194;</td>
              <td class="vb-icon-cell">{{ topic.status === 'locked' ? '&#128274;' : '&#9993;' }}</td>
              <td class="vb-thread-cell" data-label="Thread">
                <div class="vb-thread-title">{{ topic.title }}</div>
                <div
                  v-if="topicTotalPages(topic) > 1"
                  class="vb-thread-pages"
                  @click.stop
                >
                  <span class="vb-thread-pages-label">Pages:</span>
                  <template v-for="(page, idx) in topicPageNumbers(topic)" :key="idx">
                    <span v-if="page === '...'" class="vb-thread-pages-ellipsis">…</span>
                    <button
                      v-else
                      type="button"
                      class="vb-thread-pages-link"
                      @click="handleSelectTopicPage(topic.id, page)"
                    >{{ page }}</button>
                  </template>
                </div>
                <div class="vb-thread-meta">
                  Started by
                  <router-link
                    class="vb-lastpost-author"
                    :to="{ name: 'user.view', params: { identityId: topic.createdBy } }"
                    @click.stop
                  >{{ state.topicStarterName(topic) }}</router-link>
                  <span class="vb-thread-date">· {{ getRelativeTime(topic.createdAt) }}</span>
                </div>
              </td>
              <td class="vb-lastpost" data-label="Last Post">
                <div class="vb-lastpost-time">{{ getRelativeTime(topic.lastPostAt || topic.updatedAt) }}</div>
                <div class="vb-lastpost-byline">
                  <span class="vb-lastpost-by-prefix">by</span>
                  <router-link
                    class="vb-lastpost-author"
                    :to="{ name: 'user.view', params: { identityId: topic.lastPostAuthorId || topic.createdBy } }"
                    @click.stop
                  >{{ topic.lastPostAuthorName || state.identityName(topic.createdBy) }}</router-link>
                  <span class="vb-lastpost-by-suffix">&#187;</span>
                </div>
              </td>
              <td class="vb-number" data-label="Replies">{{ topic.postCount ?? 0 }}</td>
            </tr>

            <tr class="vb-table-section">
              <td colspan="5">Normal Threads</td>
            </tr>
            <tr v-if="normalThreads.length === 0" class="vb-table-row">
              <td colspan="5" class="vb-empty">No threads yet. Create the first topic.</td>
            </tr>
            <tr
              v-for="topic in normalThreads"
              :key="topic.id"
              class="vb-table-row vb-slide-in"
              @click="handleSelectTopic(topic.id)"
            >
              <td class="vb-icon-cell">&#128194;</td>
              <td class="vb-icon-cell">{{ topic.status === 'locked' ? '&#128274;' : '&#9993;' }}</td>
              <td class="vb-thread-cell" data-label="Thread">
                <div class="vb-thread-title">{{ topic.title }}</div>
                <div
                  v-if="topicTotalPages(topic) > 1"
                  class="vb-thread-pages"
                  @click.stop
                >
                  <span class="vb-thread-pages-label">Pages:</span>
                  <template v-for="(page, idx) in topicPageNumbers(topic)" :key="idx">
                    <span v-if="page === '...'" class="vb-thread-pages-ellipsis">…</span>
                    <button
                      v-else
                      type="button"
                      class="vb-thread-pages-link"
                      @click="handleSelectTopicPage(topic.id, page)"
                    >{{ page }}</button>
                  </template>
                </div>
                <div class="vb-thread-meta">
                  Started by
                  <router-link
                    class="vb-lastpost-author"
                    :to="{ name: 'user.view', params: { identityId: topic.createdBy } }"
                    @click.stop
                  >{{ state.topicStarterName(topic) }}</router-link>
                  <span class="vb-thread-date">· {{ getRelativeTime(topic.createdAt) }}</span>
                </div>
              </td>
              <td class="vb-lastpost" data-label="Last Post">
                <div class="vb-lastpost-time">{{ getRelativeTime(topic.lastPostAt || topic.updatedAt) }}</div>
                <div class="vb-lastpost-byline">
                  <span class="vb-lastpost-by-prefix">by</span>
                  <router-link
                    class="vb-lastpost-author"
                    :to="{ name: 'user.view', params: { identityId: topic.lastPostAuthorId || topic.createdBy } }"
                    @click.stop
                  >{{ topic.lastPostAuthorName || state.identityName(topic.createdBy) }}</router-link>
                  <span class="vb-lastpost-by-suffix">&#187;</span>
                </div>
              </td>
              <td class="vb-number" data-label="Replies">{{ topic.postCount ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="vb-controls vb-controls-bottom">
      <button v-if="state.isLoggedIn.value" class="vb-btn" :disabled="state.loading.value" @click="goToNewThread">New Thread</button>
      <div class="vb-filters">
        Show threads from the...
        <select v-model="dateFilter" :disabled="state.loading.value">
          <option value="day">Last Day</option>
          <option value="2days">Last 2 Days</option>
          <option value="week">Last Week</option>
          <option value="beginning">Beginning</option>
        </select>
        <button class="vb-small-btn" :disabled="state.loading.value" @click="applyDateFilter">Go</button>
      </div>
    </div>

    <div class="vb-legend">
      <div><span>&#9993;</span> New Posts</div>
      <div><span>&#9993;</span> No New Posts</div>
      <div><span>&#128274;</span> Thread Locked</div>
    </div>

    <div class="vb-quick-post">
      <div class="vb-table-header">Quick Post</div>
      <div v-if="!state.isLoggedIn.value" class="vb-login-notice">
        <router-link to="/login">Log in</router-link> or
        <router-link to="/register">register</router-link> to create a thread.
      </div>
      <div v-else class="vb-quick-post-body">
        <p>Want to post a new thread?</p>
        <button class="vb-btn" @click="goToNewThread">Post New Thread</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-topic-list-mobile {
  display: none;
}

.vb-topic-section {
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
  margin-bottom: 12px;
}

.vb-topic-section-title {
  padding: 8px 10px;
  font-weight: bold;
  font-size: 12px;
  background: linear-gradient(var(--grad-header-start), var(--grad-header-end));
  color: var(--text-inverse);
}

.vb-topic-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.vb-topic-item {
  width: 100%;
  text-align: left;
  border: none;
  border-top: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  cursor: pointer;
}

.vb-topic-item:hover {
  background: var(--bg-surface-hover);
}

.vb-topic-item--sticky {
  background: var(--bg-surface-muted);
}

.vb-topic-item--sticky:hover {
  background: var(--bg-surface-hover);
}

.vb-topic-item-left {
  flex: 1;
  min-width: 0;
}

.vb-topic-item-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--brand-primary-light);
  font-weight: 700;
  font-size: 14px;
  line-height: 1.2;
  margin-bottom: 4px;
}

.vb-topic-item-title-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.vb-topic-item-icon {
  flex: 0 0 auto;
  font-size: 14px;
  opacity: 0.9;
}

.vb-topic-item-lock {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted);
}

.vb-topic-item-meta {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vb-thread-pages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.vb-thread-pages-label {
  color: var(--text-muted);
}

.vb-thread-pages-ellipsis {
  color: var(--text-muted);
}

.vb-thread-pages-link {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--brand-primary-light);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}

.vb-thread-pages-link:hover {
  background: var(--bg-surface-hover);
}

.vb-thread-pages-link:active {
  transform: translateY(0.5px);
}

.vb-topic-item-right {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.vb-topic-item-last {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.vb-topic-item-replies {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.vb-topic-item-replies-num {
  font-size: 13px;
  font-weight: 800;
  color: var(--brand-accent);
}

.vb-topic-item-replies-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.vb-lastpost-byline {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.vb-lastpost-by-prefix,
.vb-lastpost-by-suffix {
  flex: 0 0 auto;
}

.vb-lastpost-author {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Mobile responsive: use compact list instead of stacked table-cards */
@media (max-width: 640px) {
  .vb-topic-list-mobile {
    display: block;
  }

  .vb-topic-list-desktop {
    display: none;
  }

  /* tighten up vertical rhythm in the header/controls on small screens */
  :deep(.vb-controls) {
    gap: 8px;
  }
}
</style>
