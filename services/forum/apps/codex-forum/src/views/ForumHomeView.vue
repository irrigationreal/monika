<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useForumState } from '../composables/useForumState';

import type { ForumDto } from '../lib/apiClient';

const router = useRouter();
const state = useForumState();

const forums = computed(() => state.forums.value);
const archivedForums = computed(() => state.archivedForums.value);
const recentPosts = computed(() => state.recentPosts.value);
const hasRecentPosts = computed(() => recentPosts.value.length > 0);
const hasNoForums = computed(
  () => forums.value.length === 0 && archivedForums.value.length === 0 && !state.loading.value
);
const showRecentReplies = computed(() => state.loading.value || hasRecentPosts.value || !hasNoForums.value);
const rootForums = computed(() => forums.value.filter((forum) => !forum.parentForumId));
const showForumLeaders = ref(false);
const categoryGroups = computed(() => {
  const groups = new Map<string, ForumDto[]>();
  const hasCategories = rootForums.value.some((forum) => (forum.category ?? '').trim() !== '');
  const fallbackLabel = hasCategories ? 'Uncategorized' : 'Forums';

  for (const forum of rootForums.value) {
    const label = (forum.category ?? '').trim() || fallbackLabel;
    const list = groups.get(label) ?? [];
    list.push(forum);
    groups.set(label, list);
  }

  const entries = Array.from(groups.entries()).map(([name, items]) => {
    const forums = items.slice().sort((a, b) => a.name.localeCompare(b.name));
    return { name, forums };
  });

  entries.sort((a, b) => {
    if (!hasCategories) return a.name.localeCompare(b.name);
    if (a.name === fallbackLabel) return 1;
    if (b.name === fallbackLabel) return -1;
    return a.name.localeCompare(b.name);
  });

  return entries;
});
const subForumsByParent = computed(() => {
  const map = new Map<string, ForumDto[]>();
  for (const forum of forums.value) {
    if (!forum.parentForumId) continue;
    const list = map.get(forum.parentForumId) ?? [];
    list.push(forum);
    map.set(forum.parentForumId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
});

const forumLeaders = computed(() => state.forumLeaders.value);

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const isToday = date.toDateString() === today.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (isToday) return `Today ${timeStr}`;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + timeStr;
}

function formatPreview(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function hasNewPosts(forum: ForumDto): boolean {
  if (!forum.lastPost) return false;
  const lastPostDate = new Date(forum.lastPost.createdAt);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return lastPostDate > dayAgo;
}

function leaderAvatar(leader: { avatarUrl: string | null; displayName: string; kind: string }): string {
  if (leader.avatarUrl) return leader.avatarUrl;
  const name = leader.displayName.toLowerCase();
  if (leader.kind === 'robot' || name.includes('robot') || name.includes('codex')) {
    return '/avatars/monika.png';
  }
  if (name.includes('muse')) {
    return '/avatars/muse.webp';
  }
  if (name.includes('director')) {
    return '/avatars/director.webp';
  }
  return '/avatars/user.svg';
}

async function handleSelectForum(forumId: string): Promise<void> {
  await router.push({ name: 'forum.view', params: { forumId } });
}

async function handleSelectTopic(topicId: string): Promise<void> {
  await router.push({ name: 'topic.view', params: { topicId } });
}

async function openForumLeaders(): Promise<void> {
  showForumLeaders.value = true;
  if (state.forumLeaders.value.length > 0 || state.forumLeadersLoading.value) return;
  await state.loadForumLeaders(5);
}

onMounted(async () => {
  state.clearTopic();
  state.clearForum();
  try {
    // These module-scoped snapshots survive route changes. Refresh them on every
    // home entry while leaving the previous values rendered until replacements arrive.
    await Promise.all([
      state.loadForums({ includeArchived: false }),
      state.loadArchivedForums(),
      state.loadRecentPosts(3),
    ]);
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to load forums.');
  }
});
</script>

<template>
  <section class="vb-section vb-fade-in">
    <!-- Quick Links Bar -->
    <div class="vb-tools">
      <div class="vb-menu">Quick Links</div>
      <div class="vb-quick-actions">
        <button class="vb-small-btn">Mark Forums Read</button>
        <button class="vb-small-btn" type="button" @click.stop="openForumLeaders">View Forum Leaders</button>
        <router-link
          v-if="state.currentUser.value?.kind === 'admin'"
          class="vb-small-btn"
          :to="{ name: 'admin.robotDashboard' }"
          @click.stop
        >
          Robot Dashboard
        </router-link>
      </div>
    </div>

    <!-- Forum Leaders Modal -->
    <div v-if="showForumLeaders" class="vb-modal-overlay" @click.self="showForumLeaders = false">
      <div class="vb-modal">
        <div class="vb-modal-header">
          <span>Forum Leaders</span>
          <button class="vb-modal-close" type="button" @click="showForumLeaders = false">&times;</button>
        </div>
        <div class="vb-modal-body">
          <div v-if="state.forumLeadersLoading.value" class="vb-empty">Loading forum leaders...</div>
          <div v-else-if="state.forumLeadersError.value" class="vb-empty">
            {{ state.forumLeadersError.value }}
            <div style="margin-top: 10px">
              <button class="vb-small-btn" type="button" @click="state.loadForumLeaders(5)">Retry</button>
            </div>
          </div>
          <div v-else-if="forumLeaders.length === 0" class="vb-empty">No posts yet.</div>
          <ol v-else class="vb-leaders-list">
            <li v-for="(leader, idx) in forumLeaders" :key="leader.identityId" class="vb-leader-item">
              <div class="vb-leader-rank">#{{ idx + 1 }}</div>
              <img class="vb-leader-avatar" :src="leaderAvatar(leader)" alt="" />
              <div class="vb-leader-meta">
                <router-link
                  class="vb-leader-name"
                  :to="{ name: 'user.view', params: { identityId: leader.identityId } }"
                >
                  {{ leader.displayName }}
                </router-link>
                <div class="vb-leader-posts">{{ leader.postCount.toLocaleString() }} posts</div>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </div>

    <div v-if="showRecentReplies" class="vb-recent-box">
      <div class="vb-table-header">Recent Replies</div>
      <div class="vb-recent-body">
        <div v-if="state.loading.value && !hasRecentPosts" class="vb-empty">Loading recent replies...</div>
        <div v-else-if="!hasRecentPosts" class="vb-empty">No recent replies yet.</div>
        <div
          v-for="post in recentPosts"
          :key="post.postId"
          class="vb-recent-item"
          @click="handleSelectTopic(post.topicId)"
        >
          <div class="vb-recent-head">
            <div class="vb-recent-author">
              <router-link
                class="vb-lastpost-author"
                :to="{ name: 'user.view', params: { identityId: post.authorId } }"
                @click.stop
                ><strong>{{ post.authorName }}</strong></router-link
              >
              <span class="vb-recent-action">replied</span>
            </div>
            <div class="vb-recent-time">{{ formatDateTime(post.createdAt) }}</div>
          </div>
          <div class="vb-recent-topic">{{ post.topicTitle }}</div>
          <div class="vb-recent-forum" @click.stop="handleSelectForum(post.forumId)">in {{ post.forumName }}</div>
          <div v-if="post.body.trim()" class="vb-recent-preview">
            {{ formatPreview(post.body) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="state.loading.value && hasNoForums" class="vb-empty-state">
      <div class="vb-spinner vb-spinner-dark" style="width: 24px; height: 24px"></div>
      <div class="vb-empty-state-text" style="margin-top: 12px">Loading forums...</div>
    </div>

    <!-- Empty State -->
    <div v-else-if="hasNoForums" class="vb-empty-state">
      <div class="vb-empty-state-icon">&#128196;</div>
      <div class="vb-empty-state-text">No forums have been created yet.</div>
      <div v-if="state.currentUser.value?.kind === 'admin'" class="vb-empty-state-hint">
        <router-link to="/admin">Go to Admin Panel</router-link> to create forums.
      </div>
    </div>

    <!-- Forums Table -->
    <div v-else>
      <div v-for="group in categoryGroups" :key="group.name" class="vb-forum-list">
        <!-- Category Header -->
        <div class="vb-category-header">
          <div class="vb-category-title">{{ group.name }}</div>
          <div class="vb-category-stats">
            <span class="vb-stat-header">Last Post</span>
            <span class="vb-stat-header vb-stat-threads">Threads</span>
            <span class="vb-stat-header vb-stat-posts">Posts</span>
          </div>
        </div>

        <!-- Forum Rows -->
        <div
          v-for="forum in group.forums"
          :key="forum.id"
          class="vb-forum-row vb-slide-in"
          @click="handleSelectForum(forum.id)"
        >
          <div class="vb-forum-icon" :class="{ 'vb-has-new': hasNewPosts(forum) }">
            <span v-if="hasNewPosts(forum)" class="vb-icon-new">&#128194;</span>
            <span v-else class="vb-icon-read">&#128193;</span>
          </div>

          <div class="vb-forum-info">
            <div class="vb-forum-title">{{ forum.name }}</div>
            <div v-if="forum.description" class="vb-forum-description">{{ forum.description }}</div>
            <div v-if="(subForumsByParent.get(forum.id)?.length ?? 0) > 0" class="vb-subforum-list">
              <span class="vb-subforum-label">Sub-forums:</span>
              <span
                v-for="subforum in subForumsByParent.get(forum.id)"
                :key="subforum.id"
                class="vb-subforum-link"
                @click.stop="handleSelectForum(subforum.id)"
              >
                {{ subforum.name }}
              </span>
            </div>
          </div>

          <div class="vb-forum-lastpost">
            <template v-if="forum.lastPost">
              <div class="vb-lastpost-title" @click.stop="handleSelectTopic(forum.lastPost.topicId)">
                {{ forum.lastPost.topicTitle }}
              </div>
              <div class="vb-lastpost-meta">
                <span class="vb-lastpost-time">{{ formatDateTime(forum.lastPost.createdAt) }}</span>
                <span class="vb-lastpost-by">
                  <span class="vb-lastpost-by-prefix">by</span>
                  <router-link
                    class="vb-lastpost-author"
                    :to="{ name: 'user.view', params: { identityId: forum.lastPost.authorId } }"
                    @click.stop
                    ><strong>{{ forum.lastPost.authorName }}</strong></router-link
                  >
                </span>
              </div>
            </template>
            <template v-else>
              <div class="vb-no-posts">No posts yet</div>
            </template>
          </div>

          <div class="vb-forum-threads">{{ forum.threadCount.toLocaleString() }}</div>
          <div class="vb-forum-posts">{{ forum.postCount.toLocaleString() }}</div>
        </div>
      </div>
    </div>

    <!-- Archives -->
    <div v-if="archivedForums.length > 0" class="vb-forum-list vb-archives">
      <div class="vb-category-header">
        <div class="vb-category-title">Archives</div>
        <div class="vb-category-stats">
          <span class="vb-stat-header">Last Post</span>
          <span class="vb-stat-header vb-stat-threads">Threads</span>
          <span class="vb-stat-header vb-stat-posts">Posts</span>
        </div>
      </div>

      <div
        v-for="forum in archivedForums"
        :key="forum.id"
        class="vb-forum-row vb-slide-in"
        @click="handleSelectForum(forum.id)"
      >
        <div class="vb-forum-icon">
          <span class="vb-icon-read">&#128193;</span>
        </div>

        <div class="vb-forum-info">
          <div class="vb-forum-title">{{ forum.name }}</div>
          <div v-if="forum.description" class="vb-forum-description">{{ forum.description }}</div>
        </div>

        <div class="vb-forum-lastpost">
          <template v-if="forum.lastPost">
            <div class="vb-lastpost-title" @click.stop="handleSelectTopic(forum.lastPost.topicId)">
              {{ forum.lastPost.topicTitle }}
            </div>
            <div class="vb-lastpost-meta">
              <span class="vb-lastpost-time">{{ formatDateTime(forum.lastPost.createdAt) }}</span>
              <span class="vb-lastpost-by">
                <span class="vb-lastpost-by-prefix">by</span>
                <router-link
                  class="vb-lastpost-author"
                  :to="{ name: 'user.view', params: { identityId: forum.lastPost.authorId } }"
                  @click.stop
                  ><strong>{{ forum.lastPost.authorName }}</strong></router-link
                >
              </span>
            </div>
          </template>
          <template v-else>
            <div class="vb-no-posts">No posts yet</div>
          </template>
        </div>

        <div class="vb-forum-threads">{{ forum.threadCount.toLocaleString() }}</div>
        <div class="vb-forum-posts">{{ forum.postCount.toLocaleString() }}</div>
      </div>
    </div>

    <!-- Forum Statistics -->
    <div class="vb-forum-stats-box">
      <div class="vb-table-header">Forum Statistics</div>
      <div class="vb-stats-body">
        <div class="vb-stats-row">
          <span class="vb-stat-label">Total Forums:</span>
          <span class="vb-stat-value">{{ forums.length + archivedForums.length }}</span>
        </div>
        <div class="vb-stats-row">
          <span class="vb-stat-label">Total Threads:</span>
          <span class="vb-stat-value">{{
            [...forums, ...archivedForums].reduce((sum, f) => sum + f.threadCount, 0).toLocaleString()
          }}</span>
        </div>
        <div class="vb-stats-row">
          <span class="vb-stat-label">Total Posts:</span>
          <span class="vb-stat-value">{{
            [...forums, ...archivedForums].reduce((sum, f) => sum + f.postCount, 0).toLocaleString()
          }}</span>
        </div>
      </div>
    </div>

    <!-- Legend -->
    <div class="vb-legend">
      <div><span class="vb-legend-icon vb-has-new">&#128194;</span> Forum Contains New Posts</div>
      <div><span class="vb-legend-icon">&#128193;</span> Forum Contains No New Posts</div>
    </div>
  </section>
</template>

<style scoped>
.vb-leaders-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.vb-leader-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
}

.vb-leader-rank {
  width: 44px;
  text-align: center;
  font-weight: bold;
  color: var(--text-secondary);
}

.vb-leader-avatar {
  width: 48px;
  height: 48px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
  object-fit: cover;
}

.vb-leader-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.vb-leader-name {
  font-weight: bold;
  color: var(--brand-primary-light);
  text-decoration: none;
}

.vb-leader-name:hover {
  color: var(--brand-primary-hover);
  text-decoration: underline;
}

.vb-leader-posts {
  font-size: 11px;
  color: var(--text-muted);
}

.vb-forum-list {
  border: 1px solid var(--brand-primary);
  background: var(--brand-primary);
  padding: 1px;
  margin-bottom: 18px;
}

.vb-recent-box {
  border: 1px solid var(--brand-primary);
  background: var(--brand-primary);
  padding: 1px;
  margin-bottom: 18px;
}

.vb-recent-body {
  background: var(--bg-surface-alt);
}

.vb-recent-item {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.vb-recent-item:last-child {
  border-bottom: none;
}

.vb-recent-item:hover {
  background: var(--bg-surface-hover);
}

.vb-recent-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
}

.vb-recent-author strong {
  color: var(--brand-primary-light);
}

.vb-recent-action {
  margin-left: 6px;
  color: var(--text-secondary);
}

.vb-recent-time {
  flex: 0 0 auto;
}

.vb-recent-topic {
  font-weight: bold;
  font-size: 13px;
  color: var(--brand-primary-light);
  margin-top: 4px;
}

.vb-recent-item:hover .vb-recent-topic {
  color: var(--brand-primary-hover);
  text-decoration: underline;
}

.vb-recent-forum {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  width: fit-content;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vb-recent-forum:hover {
  color: var(--brand-primary-hover);
}

.vb-recent-preview {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.vb-category-header {
  display: flex;
  align-items: center;
  background: linear-gradient(var(--grad-header-start), var(--grad-header-end));
  color: var(--text-inverse);
  font-weight: bold;
  font-size: 12px;
  padding: 8px 10px;
}

.vb-category-title {
  flex: 1;
}

.vb-category-stats {
  display: flex;
  gap: 0;
}

.vb-stat-header {
  width: 180px;
  text-align: center;
  padding: 0 8px;
}

.vb-stat-threads,
.vb-stat-posts {
  width: 70px;
}

.vb-forum-row {
  display: flex;
  align-items: stretch;
  background: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border-default);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.vb-forum-row:hover {
  background: var(--bg-surface-hover);
}

.vb-forum-row:last-child {
  border-bottom: none;
}

.vb-forum-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  padding: 12px 8px;
  background: var(--bg-surface-muted);
  border-right: 1px solid var(--border-default);
  font-size: 24px;
}

.vb-forum-icon.vb-has-new {
  background: var(--bg-surface-hover);
}

.vb-icon-new {
  color: var(--brand-primary-light);
}

.vb-icon-read {
  color: var(--text-disabled);
}

.vb-forum-info {
  flex: 1;
  padding: 12px 16px;
  min-width: 0;
}

.vb-forum-title {
  font-weight: bold;
  font-size: 14px;
  color: var(--brand-primary-light);
  margin-bottom: 4px;
}

.vb-forum-row:hover .vb-forum-title {
  color: var(--brand-primary-hover);
  text-decoration: underline;
}

.vb-forum-description {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.vb-subforum-list {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vb-subforum-label {
  font-weight: bold;
  color: var(--text-secondary);
}

.vb-subforum-link {
  color: var(--brand-primary-light);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vb-subforum-link:hover {
  color: var(--brand-primary-hover);
}

.vb-archives {
  margin-top: 20px;
}

.vb-forum-lastpost {
  width: 180px;
  padding: 12px 10px;
  background: var(--bg-surface-muted);
  border-left: 1px solid var(--border-default);
  font-size: 11px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.vb-lastpost-title {
  font-weight: bold;
  color: var(--brand-primary-light);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.vb-lastpost-title:hover {
  color: var(--brand-primary-hover);
  text-decoration: underline;
}

.vb-lastpost-meta {
  color: var(--text-muted);
  font-size: 10px;
}

.vb-lastpost-by {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.vb-lastpost-by-prefix {
  flex: 0 0 auto;
}

.vb-lastpost-author {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vb-lastpost-time {
  display: block;
}

.vb-lastpost-by strong {
  color: var(--brand-primary-light);
}

.vb-no-posts {
  color: var(--text-disabled);
  font-style: italic;
}

.vb-forum-threads,
.vb-forum-posts {
  width: 70px;
  padding: 12px 8px;
  text-align: center;
  font-size: 12px;
  font-weight: bold;
  color: var(--text-secondary);
  background: var(--bg-surface-muted);
  border-left: 1px solid var(--border-default);
  display: flex;
  align-items: center;
  justify-content: center;
}

.vb-forum-stats-box {
  border: 1px solid var(--brand-primary);
  background: var(--brand-primary);
  padding: 1px;
  margin-top: 16px;
}

.vb-stats-body {
  background: var(--bg-surface-alt);
  padding: 12px 16px;
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  font-size: 11px;
}

.vb-stats-row {
  display: flex;
  gap: 6px;
}

.vb-stat-label {
  font-weight: bold;
  color: var(--brand-accent);
}

.vb-stat-value {
  color: var(--brand-primary-light);
}

.vb-quick-actions {
  display: flex;
  gap: 4px;
}

.vb-legend-icon {
  font-size: 14px;
  margin-right: 4px;
}

.vb-legend-icon.vb-has-new {
  color: var(--brand-primary-light);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .vb-category-stats {
    display: none;
  }

  .vb-forum-row {
    flex-wrap: wrap;
  }

  .vb-forum-icon {
    width: 40px;
    font-size: 20px;
  }

  .vb-forum-info {
    flex: 1;
    min-width: calc(100% - 40px);
  }

  .vb-forum-lastpost {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border-default);
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(112px, 42%);
    align-items: center;
    column-gap: 12px;
    padding: 8px 12px;
  }

  .vb-lastpost-title {
    min-width: 0;
    margin-bottom: 0;
    text-align: left;
  }

  .vb-lastpost-meta {
    min-width: 0;
    text-align: right;
  }

  .vb-lastpost-time {
    white-space: nowrap;
  }

  .vb-lastpost-by {
    justify-content: flex-end;
  }

  .vb-lastpost-by .vb-lastpost-author {
    flex: 0 1 auto;
  }

  .vb-no-posts {
    grid-column: 1 / -1;
    justify-self: center;
  }

  .vb-recent-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .vb-forum-threads,
  .vb-forum-posts {
    display: none;
  }

  .vb-stats-body {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
