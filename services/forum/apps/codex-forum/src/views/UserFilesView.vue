<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useForumState } from '../composables/useForumState';
import { api } from '../lib/apiClient';

import type { UserFileDto } from '../lib/apiClient';

type FileFilter = 'standalone' | 'all' | 'post_attachments';
type Visibility = 'private' | 'members' | 'public';
type Expiration = 'one_day' | 'one_week' | 'two_weeks' | 'one_month' | 'six_months' | 'one_year' | 'never';
const router = useRouter();
const state = useForumState();
const files = ref<UserFileDto[]>([]);
const nextCursor = ref<string | null>(null);
const filter = ref<FileFilter>('standalone');
const selected = ref<File[]>([]);
const visibility = ref<Visibility>('private');
const expiration = ref<Expiration>('one_month');
const isLoading = ref(false);
const isUploading = ref(false);
const error = ref('');
const success = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const currentUser = computed(() => state.currentUser.value);
const totalBytes = computed(() => files.value.reduce((n, file) => n + file.sizeBytes, 0));
let asyncGeneration = 0;
let loadRequestId = 0;
interface AsyncScope {
  identityId: string;
  generation: number;
}
function beginAsyncScope(): AsyncScope | null {
  const identityId = currentUser.value?.id;
  if (!identityId) return null;
  return { identityId, generation: asyncGeneration };
}
function isCurrentScope(scope: AsyncScope): boolean {
  return scope.generation === asyncGeneration && currentUser.value?.id === scope.identityId;
}
function invalidateAsyncScopes(): void {
  asyncGeneration += 1;
}
const expirationOptions: [Expiration, string][] = [
  ['one_day', '1 day'],
  ['one_week', '1 week'],
  ['two_weeks', '2 weeks'],
  ['one_month', '1 month'],
  ['six_months', '6 months'],
  ['one_year', '1 year'],
  ['never', 'Never'],
];
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i] ?? ''}`;
}
function fileUrl(id: string) {
  return `${window.location.origin}/api/user-files/${id}`;
}
function postLocation(association: UserFileDto['associations'][number]) {
  const page = Math.floor((association.postNumber - 1) / state.POSTS_PER_PAGE) + 1;
  return {
    name: 'topic.view',
    params: { topicId: association.topicId },
    query: page > 1 ? { page: String(page) } : {},
    hash: `#${String(association.postNumber)}`,
  };
}
async function load(preserveError = false, append = false) {
  const scope = beginAsyncScope();
  if (!scope) return;
  const requestId = ++loadRequestId;
  const requestedFilter = filter.value;
  const priorItems = append ? [...files.value] : [];
  const cursor = append ? nextCursor.value : null;
  isLoading.value = true;
  if (!preserveError) error.value = '';
  try {
    const options: { cursor?: string; limit: number } = { limit: 30 };
    if (cursor) options.cursor = cursor;
    const response = await api.listUserFilesPage(requestedFilter, options);
    if (!isCurrentScope(scope) || requestId !== loadRequestId) return;
    files.value = append ? [...priorItems, ...response.items] : response.items;
    nextCursor.value = response.nextCursor;
  } catch (e) {
    if (isCurrentScope(scope) && requestId === loadRequestId)
      error.value = e instanceof Error ? e.message : 'Failed to load files.';
  } finally {
    if (isCurrentScope(scope) && requestId === loadRequestId) isLoading.value = false;
  }
}
function selectFiles(event: Event) {
  selected.value = Array.from((event.target as HTMLInputElement).files ?? []);
}
function clear() {
  selected.value = [];
  if (fileInput.value) fileInput.value.value = '';
}
async function upload() {
  const scope = beginAsyncScope();
  if (!scope) return;
  isUploading.value = true;
  error.value = '';
  success.value = '';
  let completed = 0;
  let deduped = 0;
  const pending = [...selected.value];
  const uploadOptions = { visibility: visibility.value, expiration: expiration.value };
  for (let index = 0; index < pending.length; index += 1) {
    if (!isCurrentScope(scope)) return;
    const file = pending[index];
    if (!file) continue;
    try {
      const result = await api.uploadUserFile(file, uploadOptions);
      if (!isCurrentScope(scope)) return;
      completed += 1;
      if (result.deduplicated) deduped += 1;
    } catch (e) {
      if (!isCurrentScope(scope)) return;
      selected.value = pending.slice(index);
      error.value = `${String(completed)} file(s) uploaded before failure. ${e instanceof Error ? e.message : 'Upload failed.'}`;
      break;
    }
  }
  if (!isCurrentScope(scope)) return;
  if (completed)
    success.value = `Uploaded ${String(completed)} file${completed === 1 ? '' : 's'}${deduped ? `; ${String(deduped)} already existed` : ''}.`;
  if (!error.value) clear();
  isUploading.value = false;
  await load(Boolean(error.value));
}
async function removeStandalone(file: UserFileDto) {
  if (!confirm(`Remove the standalone copy of ${file.filename}? Post attachments will remain.`)) return;
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    await api.deleteUserFile(file.id);
    if (isCurrentScope(scope)) await load();
  } catch (e) {
    if (isCurrentScope(scope)) error.value = e instanceof Error ? e.message : 'Delete failed.';
  }
}
async function updateVisibility(file: UserFileDto, event: Event) {
  if (!file.standalone) return;
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    await api.updateUserFile(file.id, {
      expectedRevision: file.revision,
      visibility: (event.target as HTMLSelectElement).value as Visibility,
      expiration: 'keep',
    });
    if (isCurrentScope(scope)) await load();
  } catch (e) {
    if (!isCurrentScope(scope)) return;
    error.value = e instanceof Error ? e.message : 'Update failed.';
    await load(true);
  }
}
async function resetExpiration(file: UserFileDto, event: Event) {
  if (!file.standalone || !file.visibility) return;
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    await api.updateUserFile(file.id, {
      expectedRevision: file.revision,
      visibility: file.visibility,
      expiration: (event.target as HTMLSelectElement).value as Expiration,
    });
    if (isCurrentScope(scope)) await load();
  } catch (e) {
    if (!isCurrentScope(scope)) return;
    error.value = e instanceof Error ? e.message : 'Update failed.';
    await load(true);
  }
}
async function detach(associationId: string) {
  if (!confirm('Remove this attachment from its post? A tombstone will remain.')) return;
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    await api.deleteAttachment(associationId);
    if (isCurrentScope(scope)) await load();
  } catch (e) {
    if (isCurrentScope(scope)) error.value = e instanceof Error ? e.message : 'Remove failed.';
  }
}
async function copy(id: string) {
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    await navigator.clipboard.writeText(fileUrl(id));
    if (isCurrentScope(scope)) success.value = 'Link copied to clipboard.';
  } catch (e) {
    if (isCurrentScope(scope)) error.value = e instanceof Error ? e.message : 'Copy failed.';
  }
}
watch(filter, () => {
  invalidateAsyncScopes();
  nextCursor.value = null;
  isLoading.value = false;
  isUploading.value = false;
  void load();
});
watch(
  () => currentUser.value?.id ?? null,
  (identityId, previousIdentityId) => {
    if (identityId === previousIdentityId) return;
    invalidateAsyncScopes();
    files.value = [];
    nextCursor.value = null;
    isLoading.value = false;
    isUploading.value = false;
    error.value = '';
    success.value = '';
    clear();
    if (identityId) void load();
  },
  { immediate: true }
);
onMounted(async () => {
  if (!state.authChecked.value) await state.checkAuth();
});
</script>

<template>
  <section class="vb-section vb-user-files">
    <div class="vb-table-header">User Files</div>
    <div v-if="!currentUser" class="vb-profile-content">
      <p>You must be logged in to manage your uploads.</p>
      <button class="vb-btn" @click="router.push({ name: 'forum.home' })">Return to Forum</button>
    </div>
    <div v-else class="vb-user-files-body">
      <div v-if="success" class="vb-success-banner">{{ success }}</div>
      <div v-if="error" class="vb-login-error">{{ error }}</div>
      <div class="vb-user-files-card">
        <h3>Upload files</h3>
        <p class="vb-user-files-hint">
          Standalone uploads expire after one month by default. Post attachments do not expire.
        </p>
        <div class="vb-notepad-controls">
          <label
            >Visibility
            <select v-model="visibility">
              <option value="private">Private</option>
              <option value="members">Members</option>
              <option value="public">Public</option>
            </select></label
          >
          <label
            >Retention
            <select v-model="expiration">
              <option v-for="[value, label] in expirationOptions" :key="value" :value="value">{{ label }}</option>
            </select></label
          >
        </div>
        <input ref="fileInput" class="vb-attachment-input" type="file" multiple @change="selectFiles" />
        <div v-if="selected.length" class="vb-attachment-selected">
          <ul>
            <li v-for="file in selected" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
          </ul>
          <div class="vb-user-files-actions">
            <button class="vb-btn" :disabled="isUploading" @click="upload">
              {{ isUploading ? 'Uploading…' : 'Upload' }}
            </button>
            <button class="vb-btn vb-btn-secondary" :disabled="isUploading" @click="clear">Clear</button>
          </div>
        </div>
      </div>
      <div class="vb-user-files-card">
        <div class="vb-user-files-header">
          <h3>Your files</h3>
          <span class="vb-user-files-total">{{ files.length }} shown · {{ formatBytes(totalBytes) }}</span>
        </div>
        <div class="vb-notepad-controls" role="group" aria-label="File filter">
          <button
            v-for="item in [
              ['standalone', 'Standalone'],
              ['all', 'All'],
              ['post_attachments', 'Post attachments'],
            ] as const"
            :key="item[0]"
            class="vb-small-btn"
            :class="{ active: filter === item[0] }"
            @click="filter = item[0]"
          >
            {{ item[1] }}
          </button>
        </div>
        <div v-if="isLoading">Loading…</div>
        <div v-else-if="!files.length" class="vb-user-files-empty">No files in this view.</div>
        <ul v-else class="vb-user-files-list">
          <li v-for="file in files" :key="file.id" class="vb-user-file-item">
            <div class="vb-user-file-main">
              <strong class="vb-user-file-name">{{ file.filename }}</strong>
              <div class="vb-user-file-meta">
                {{ formatBytes(file.sizeBytes) }} · {{ new Date(file.createdAt).toLocaleString() }} ·
                {{ file.blobState }}
              </div>
            </div>
            <div v-if="file.standalone" class="vb-notepad-controls">
              <label
                >Visibility
                <select :value="file.visibility ?? 'private'" @change="updateVisibility(file, $event)">
                  <option value="private">Private</option>
                  <option value="members">Members</option>
                  <option value="public">Public</option>
                </select></label
              >
              <label
                >Reset retention
                <select value="" @change="resetExpiration(file, $event)">
                  <option value="" disabled>
                    {{ file.expiresAt ? new Date(file.expiresAt).toLocaleString() : 'Never' }}
                  </option>
                  <option v-for="[value, label] in expirationOptions" :key="value" :value="value">{{ label }}</option>
                </select></label
              >
            </div>
            <ul v-if="file.associations.length" class="vb-attachments-list">
              <li v-for="association in file.associations" :key="association.id">
                <span v-if="association.deletedAt">Attachment deleted: {{ association.filename }}</span>
                <template v-else>
                  <router-link :to="postLocation(association)">
                    {{ association.topicTitle }} #{{ association.postNumber }}
                  </router-link>
                  <button class="vb-small-btn vb-danger-btn" @click="detach(association.id)">Remove from post</button>
                </template>
              </li>
            </ul>
            <input class="vb-user-file-input" type="text" :value="fileUrl(file.id)" readonly />
            <div class="vb-user-file-buttons">
              <a class="vb-small-btn" :href="`/api/user-files/${file.id}`" download>Open / Download</a
              ><button class="vb-small-btn" @click="copy(file.id)">Copy Link</button
              ><button v-if="file.standalone" class="vb-small-btn vb-danger-btn" @click="removeStandalone(file)">
                Remove standalone copy
              </button>
            </div>
          </li>
        </ul>
        <button v-if="nextCursor" class="vb-btn vb-btn-secondary" :disabled="isLoading" @click="load(false, true)">
          {{ isLoading ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </div>
  </section>
</template>
