<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { api, type UserProfileDto, type UserPostHistoryItemDto } from '../lib/apiClient';
import { FORUM_THEME_BY_KEY } from '../themes/forumThemes';

const route = useRoute();
const router = useRouter();
const state = useForumState();
const { renderBBCode } = useMarkdown();

const identityId = computed(() => String(route.params['identityId'] ?? ''));

const profile = ref<UserProfileDto | null>(null);
const historyItems = ref<UserPostHistoryItemDto[]>([]);
const historyTotal = ref(0);
const historyPage = ref(1);
const historyPageSize = ref(25);
const loadingProfile = ref(false);
const loadingHistory = ref(false);
const errorMessage = ref('');

const currentUser = computed(() => state.currentUser.value);

const signatureHtml = computed(() => {
  if (!profile.value?.signature) return '';
  return renderBBCode(profile.value.signature);
});

const avatarUrl = computed(() => {
  if (profile.value?.avatarUrl) return profile.value.avatarUrl;
  // fall back to existing heuristics
  return state.avatarFor(profile.value?.id ?? identityId.value);
});

const themeLabel = computed(() => {
  const key = (profile.value?.theme ?? 'vmonika') as keyof typeof FORUM_THEME_BY_KEY;
  const theme = FORUM_THEME_BY_KEY[key];
  if (!theme) return String(profile.value?.theme ?? 'vmonika');
  return `${theme.label} (${String(key)})`;
});

const totalHistoryPages = computed(() => Math.max(1, Math.ceil(historyTotal.value / historyPageSize.value)));

function formatDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

async function loadProfile(): Promise<void> {
  if (!identityId.value) return;
  loadingProfile.value = true;
  errorMessage.value = '';
  try {
    profile.value = await api.getUserProfile(identityId.value);
  } catch (err) {
    profile.value = null;
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load profile.';
  } finally {
    loadingProfile.value = false;
  }
}

async function loadHistory(): Promise<void> {
  if (!identityId.value) return;
  loadingHistory.value = true;
  errorMessage.value = '';
  try {
    const res = await api.listUserPostHistory(identityId.value, historyPage.value, historyPageSize.value);
    historyItems.value = res.items;
    historyTotal.value = res.total;
  } catch (err) {
    historyItems.value = [];
    historyTotal.value = 0;
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load post history.';
  } finally {
    loadingHistory.value = false;
  }
}

function goToHistoryPage(page: number): void {
  historyPage.value = Math.max(1, Math.min(totalHistoryPages.value, Math.trunc(page)));
}

watch(identityId, async () => {
  profile.value = null;
  historyItems.value = [];
  historyTotal.value = 0;
  historyPage.value = 1;
  await loadProfile();
  await loadHistory();
});

watch(historyPage, async () => {
  // Only load history if we already have a profile (prevents a double request on first mount).
  if (!profile.value) return;
  await loadHistory();
});

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value) {
    return;
  }
  await loadProfile();
  await loadHistory();
});
</script>

<template>
  <section class="vb-section vb-profile">
    <div class="vb-table-header">User Profile</div>

    <div v-if="!currentUser" class="vb-profile-content">
      <p>You must be logged in to view user profiles.</p>
      <div class="vb-modal-actions">
        <button class="vb-btn" @click="goHome">Return to Forum</button>
      </div>
    </div>

    <div v-else class="vb-profile-content">
      <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>

      <div v-if="loadingProfile" class="vb-profile-loading">Loading profile...</div>
      <div v-else-if="!profile" class="vb-profile-loading">Profile not found.</div>

      <template v-else>
        <div class="vb-profile-header">
          <img class="vb-profile-avatar" :src="avatarUrl" alt="" />
          <div class="vb-profile-title">
            <h2 class="vb-profile-name">{{ profile.displayName }}</h2>
            <div class="vb-profile-subtitle">
              <span class="vb-profile-rank">{{ profile.rank ?? 'Member' }}</span>
              <span class="vb-profile-dot">·</span>
              <span class="vb-profile-postcount">{{ profile.postCount ?? 0 }} posts</span>
            </div>
          </div>
        </div>

        <div class="vb-profile-grid">
          <div class="vb-profile-row">
            <div class="vb-profile-label">Join Date</div>
            <div class="vb-profile-value">{{ formatDateShort(profile.joinDate ?? profile.createdAt) }}</div>
          </div>
          <div class="vb-profile-row">
            <div class="vb-profile-label">Theme</div>
            <div class="vb-profile-value">{{ themeLabel }}</div>
          </div>
          <div class="vb-profile-row">
            <div class="vb-profile-label">Location</div>
            <div class="vb-profile-value">{{ profile.location || '—' }}</div>
          </div>
          <div class="vb-profile-row vb-signature-row">
            <div class="vb-profile-label">Signature</div>
            <div class="vb-profile-value">
              <div v-if="profile.signature" class="vb-rendered-content" v-html="signatureHtml"></div>
              <span v-else>—</span>
            </div>
          </div>
        </div>

        <div class="vb-profile-post-history">
          <div class="vb-profile-history-header">
            <h3>Post History</h3>
            <div class="vb-profile-history-meta">
              {{ historyTotal }} post{{ historyTotal === 1 ? '' : 's' }}
              <span v-if="historyTotal > 0">· page {{ historyPage }} of {{ totalHistoryPages }}</span>
            </div>
          </div>

          <div v-if="loadingHistory" class="vb-profile-loading">Loading post history...</div>
          <div v-else-if="historyItems.length === 0" class="vb-profile-loading">No posts yet.</div>
          <ul v-else class="vb-profile-history-list">
            <li v-for="item in historyItems" :key="item.postId" class="vb-profile-history-item">
              <div class="vb-profile-history-top">
                <router-link
                  class="vb-profile-history-topic"
                  :to="{ name: 'topic.view', params: { topicId: item.topicId }, query: { postId: item.postId } }"
                >
                  {{ item.topicTitle }}
                </router-link>
                <span class="vb-profile-history-date">{{ formatDateShort(item.createdAt) }}</span>
              </div>
              <div class="vb-profile-history-forum">{{ item.forumName }}</div>
              <div class="vb-profile-history-excerpt">{{ item.excerpt }}</div>
            </li>
          </ul>

          <div v-if="historyTotal > historyPageSize" class="vb-profile-history-pagination">
            <button class="vb-small-btn" type="button" :disabled="historyPage <= 1" @click="goToHistoryPage(historyPage - 1)">Prev</button>
            <button class="vb-small-btn" type="button" :disabled="historyPage >= totalHistoryPages" @click="goToHistoryPage(historyPage + 1)">Next</button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
