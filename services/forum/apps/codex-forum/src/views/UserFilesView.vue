<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import ConfirmationDialog from '../components/ConfirmationDialog.vue';
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
const isInitialLoading = ref(false);
const isAppending = ref(false);
const isUploading = ref(false);
const error = ref('');
const success = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const libraryHeading = ref<HTMLElement | null>(null);
type RemovalRequest =
  { kind: 'standalone'; file: UserFileDto } | { kind: 'attachment'; associationId: string; filename: string };
const removalRequest = ref<RemovalRequest | null>(null);
const removalPending = ref(false);
const restoreRemovalFocus = ref(true);
const updatePendingIds = ref<Set<string>>(new Set());
const updateOperations = new Map<string, symbol>();
const isUpdating = computed(() => updatePendingIds.value.size > 0);
const isMutationPending = computed(() => isUploading.value || removalPending.value || isUpdating.value);
const removalTitle = computed(() =>
  removalRequest.value?.kind === 'standalone' ? 'Remove standalone copy?' : 'Remove attachment from post?'
);
const removalMessage = computed(() => {
  const request = removalRequest.value;
  if (!request) return '';
  return request.kind === 'standalone'
    ? `Remove the standalone copy of ${request.file.filename}? Its post associations will remain.`
    : `Remove ${request.filename} from its post? A tombstone will remain in the post.`;
});
const removalConfirmLabel = computed(() =>
  removalRequest.value?.kind === 'standalone' ? 'Remove standalone copy' : 'Remove from post'
);
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
  if (!scope || (append && (isInitialLoading.value || isAppending.value))) return;
  const requestId = ++loadRequestId;
  const requestedFilter = filter.value;
  const priorItems = append ? [...files.value] : [];
  const cursor = append ? nextCursor.value : null;
  if (append) isAppending.value = true;
  else {
    isAppending.value = false;
    isInitialLoading.value = true;
  }
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
    if (isCurrentScope(scope) && requestId === loadRequestId) {
      if (append) isAppending.value = false;
      else isInitialLoading.value = false;
    }
  }
}
function openFilePicker(): void {
  fileInput.value?.click();
}
function selectFiles(event: Event) {
  selected.value = Array.from((event.target as HTMLInputElement).files ?? []);
}
function clear() {
  selected.value = [];
  if (fileInput.value) fileInput.value.value = '';
}
async function upload() {
  if (isMutationPending.value) return;
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
function requestStandaloneRemoval(file: UserFileDto): void {
  if (isMutationPending.value) return;
  restoreRemovalFocus.value = true;
  removalRequest.value = { kind: 'standalone', file };
}
function requestAttachmentRemoval(associationId: string, filename: string): void {
  if (isMutationPending.value) return;
  restoreRemovalFocus.value = true;
  removalRequest.value = { kind: 'attachment', associationId, filename };
}
function cancelRemoval(): void {
  if (!removalPending.value) removalRequest.value = null;
}
async function confirmRemoval(): Promise<void> {
  const request = removalRequest.value;
  if (!request || removalPending.value) return;
  const scope = beginAsyncScope();
  if (!scope) return;
  removalPending.value = true;
  error.value = '';
  success.value = '';
  let removed = false;
  try {
    if (request.kind === 'standalone') await api.deleteUserFile(request.file.id);
    else await api.deleteAttachment(request.associationId);
    if (isCurrentScope(scope)) {
      await load();
      removed = true;
    }
  } catch (e) {
    if (isCurrentScope(scope)) {
      error.value =
        e instanceof Error ? e.message : request.kind === 'standalone' ? 'Delete failed.' : 'Remove failed.';
    }
  } finally {
    if (isCurrentScope(scope)) {
      removalPending.value = false;
      restoreRemovalFocus.value = !removed;
      removalRequest.value = null;
      if (removed) {
        await nextTick();
        libraryHeading.value?.focus();
        restoreRemovalFocus.value = true;
      }
    }
  }
}
function beginFileUpdate(fileId: string): symbol | null {
  if (updateOperations.has(fileId) || removalPending.value || isUploading.value) return null;
  const operation = Symbol(fileId);
  updateOperations.set(fileId, operation);
  updatePendingIds.value = new Set(updateOperations.keys());
  return operation;
}
function finishFileUpdate(fileId: string, operation: symbol): void {
  if (updateOperations.get(fileId) !== operation) return;
  updateOperations.delete(fileId);
  updatePendingIds.value = new Set(updateOperations.keys());
}
async function updateFile(
  file: UserFileDto,
  update: { visibility: Visibility; expiration: Expiration | 'keep' }
): Promise<void> {
  if (!file.standalone) return;
  const operation = beginFileUpdate(file.id);
  const scope = beginAsyncScope();
  if (!operation || !scope) {
    if (operation) finishFileUpdate(file.id, operation);
    return;
  }
  try {
    await api.updateUserFile(file.id, { expectedRevision: file.revision, ...update });
    if (isCurrentScope(scope)) await load();
  } catch (e) {
    if (!isCurrentScope(scope)) return;
    error.value = e instanceof Error ? e.message : 'Update failed.';
    await load(true);
  } finally {
    finishFileUpdate(file.id, operation);
  }
}
async function updateVisibility(file: UserFileDto, event: Event) {
  await updateFile(file, {
    visibility: (event.target as HTMLSelectElement).value as Visibility,
    expiration: 'keep',
  });
}
async function resetExpiration(file: UserFileDto, event: Event) {
  if (!file.visibility) return;
  await updateFile(file, {
    visibility: file.visibility,
    expiration: (event.target as HTMLSelectElement).value as Expiration,
  });
}
async function copy(id: string) {
  const scope = beginAsyncScope();
  if (!scope) return;
  try {
    error.value = '';
    await navigator.clipboard.writeText(fileUrl(id));
    if (isCurrentScope(scope)) success.value = 'Link copied to clipboard.';
  } catch (e) {
    if (isCurrentScope(scope)) error.value = e instanceof Error ? e.message : 'Copy failed.';
  }
}
watch(filter, () => {
  invalidateAsyncScopes();
  nextCursor.value = null;
  isInitialLoading.value = false;
  isAppending.value = false;
  void load();
});
watch(
  () => currentUser.value?.id ?? null,
  (identityId, previousIdentityId) => {
    if (identityId === previousIdentityId) return;
    invalidateAsyncScopes();
    files.value = [];
    nextCursor.value = null;
    isInitialLoading.value = false;
    isAppending.value = false;
    isUploading.value = false;
    updateOperations.clear();
    updatePendingIds.value = new Set();
    error.value = '';
    success.value = '';
    removalRequest.value = null;
    removalPending.value = false;
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
  <ConfirmationDialog
    :open="removalRequest !== null"
    :title="removalTitle"
    :message="removalMessage"
    :confirm-label="removalConfirmLabel"
    cancel-label="Keep it"
    pending-label="Removing…"
    :pending="removalPending"
    :restore-focus="restoreRemovalFocus"
    @confirm="confirmRemoval"
    @cancel="cancelRemoval"
  />

  <section class="vb-section vb-user-files">
    <div class="vb-table-header">User Files</div>
    <div v-if="!currentUser" class="vb-profile-content">
      <p>You must be logged in to manage your uploads.</p>
      <button type="button" class="vb-btn" @click="router.push({ name: 'forum.home' })">Return to Forum</button>
    </div>
    <div v-else class="vb-user-files-body">
      <div class="vb-user-files-messages">
        <div v-if="success" class="vb-success-banner" role="status">{{ success }}</div>
        <div v-if="error" class="vb-login-error" role="alert">{{ error }}</div>
      </div>

      <div class="vb-user-files-card vb-user-files-upload-card" :aria-busy="isUploading">
        <div class="vb-user-files-card-heading">
          <div>
            <h3>Upload files</h3>
            <p class="vb-user-files-hint">
              Standalone uploads expire after one month by default. Post attachments do not expire.
            </p>
          </div>
        </div>

        <div class="vb-user-files-control-grid">
          <label class="vb-user-files-field" for="user-file-visibility">
            <span>Visibility</span>
            <select id="user-file-visibility" v-model="visibility" class="vb-option-select" :disabled="isUploading">
              <option value="private">Private</option>
              <option value="members">Members</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label class="vb-user-files-field" for="user-file-retention">
            <span>Retention</span>
            <select id="user-file-retention" v-model="expiration" class="vb-option-select" :disabled="isUploading">
              <option v-for="[value, label] in expirationOptions" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
        </div>

        <div class="vb-user-files-picker">
          <input
            id="user-file-picker"
            ref="fileInput"
            class="vb-attachment-input vb-user-files-hidden-input"
            type="file"
            multiple
            :disabled="isMutationPending"
            tabindex="-1"
            aria-label="Choose files to upload"
            aria-describedby="user-file-selection-status"
            @change="selectFiles"
          />
          <button type="button" class="vb-btn vb-btn-secondary" :disabled="isMutationPending" @click="openFilePicker">
            Browse files
          </button>
          <span id="user-file-selection-status" class="vb-user-files-selection-status" role="status">
            {{
              selected.length
                ? `${String(selected.length)} file${selected.length === 1 ? '' : 's'} selected`
                : 'No files selected'
            }}
          </span>
        </div>

        <div v-if="selected.length" class="vb-attachment-selected vb-user-files-selection">
          <ul class="vb-user-files-selection-list" aria-label="Selected files">
            <li
              v-for="(selectedFile, index) in selected"
              :key="`${selectedFile.name}-${String(selectedFile.size)}-${String(selectedFile.lastModified)}-${String(index)}`"
            >
              <span>{{ selectedFile.name }}</span
              ><span>{{ formatBytes(selectedFile.size) }}</span>
            </li>
          </ul>
          <div class="vb-user-files-actions">
            <button type="button" class="vb-btn" :disabled="isMutationPending" @click="upload">
              {{ isUploading ? 'Uploading…' : 'Upload' }}
            </button>
            <button type="button" class="vb-btn vb-btn-secondary" :disabled="isMutationPending" @click="clear">
              Clear
            </button>
          </div>
        </div>
      </div>

      <div class="vb-user-files-card vb-user-files-library-card" :aria-busy="isInitialLoading || isAppending">
        <div class="vb-user-files-header">
          <h3 ref="libraryHeading" tabindex="-1">Your files</h3>
          <span class="vb-user-files-total">{{ files.length }} shown · {{ formatBytes(totalBytes) }}</span>
        </div>
        <div class="vb-user-files-filter" role="group" aria-label="File filter">
          <button
            v-for="item in [
              ['standalone', 'Standalone'],
              ['all', 'All'],
              ['post_attachments', 'Post attachments'],
            ] as const"
            :key="item[0]"
            type="button"
            class="vb-small-btn vb-user-files-filter-button"
            :class="{ 'vb-user-files-filter-button-selected': filter === item[0] }"
            :aria-pressed="filter === item[0]"
            :disabled="isMutationPending"
            @click="filter = item[0]"
          >
            {{ item[1] }}
          </button>
        </div>

        <div v-if="isInitialLoading" class="vb-user-files-loading" role="status">Loading files…</div>
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

            <div v-if="file.standalone" class="vb-user-file-controls" aria-label="Standalone file settings">
              <label class="vb-user-files-field">
                <span>Visibility</span>
                <select
                  class="vb-option-select"
                  :value="file.visibility ?? 'private'"
                  :disabled="isUploading || removalPending || updatePendingIds.has(file.id)"
                  @change="updateVisibility(file, $event)"
                >
                  <option value="private">Private</option>
                  <option value="members">Members</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label class="vb-user-files-field">
                <span>Reset retention</span>
                <select
                  class="vb-option-select"
                  value=""
                  :disabled="isUploading || removalPending || updatePendingIds.has(file.id)"
                  @change="resetExpiration(file, $event)"
                >
                  <option value="" disabled>
                    {{ file.expiresAt ? new Date(file.expiresAt).toLocaleString() : 'Never' }}
                  </option>
                  <option v-for="[value, label] in expirationOptions" :key="value" :value="value">{{ label }}</option>
                </select>
              </label>
            </div>

            <div v-if="file.associations.length" class="vb-user-file-associations">
              <h4>Post associations</h4>
              <ul class="vb-user-file-association-list">
                <li v-for="association in file.associations" :key="association.id" class="vb-user-file-association">
                  <div>
                    <span v-if="association.deletedAt" class="vb-user-file-association-deleted">
                      Attachment deleted: {{ association.filename }}
                    </span>
                    <template v-else>
                      <router-link :to="postLocation(association)">
                        {{ association.topicTitle }} #{{ association.postNumber }}
                      </router-link>
                      <span class="vb-user-file-association-name">{{ association.filename }}</span>
                    </template>
                  </div>
                  <button
                    v-if="!association.deletedAt"
                    type="button"
                    class="vb-small-btn vb-danger-btn"
                    :disabled="isMutationPending"
                    @click="requestAttachmentRemoval(association.id, association.filename)"
                  >
                    Remove from post
                  </button>
                </li>
              </ul>
            </div>

            <div class="vb-user-file-link">
              <label :for="`user-file-url-${file.id}`">File URL</label>
              <input
                :id="`user-file-url-${file.id}`"
                class="vb-user-file-input"
                type="text"
                :value="fileUrl(file.id)"
                readonly
                @focus="($event.target as HTMLInputElement).select()"
              />
            </div>
            <div class="vb-user-file-buttons" aria-label="File actions">
              <a class="vb-small-btn" :href="`/api/user-files/${file.id}`" download>Open / Download</a>
              <button type="button" class="vb-small-btn" @click="copy(file.id)">Copy Link</button>
              <button
                v-if="file.standalone"
                type="button"
                class="vb-small-btn vb-danger-btn"
                :disabled="isMutationPending"
                @click="requestStandaloneRemoval(file)"
              >
                Remove standalone copy
              </button>
            </div>
          </li>
        </ul>
        <div v-if="nextCursor" class="vb-user-files-load-more">
          <button type="button" class="vb-btn vb-btn-secondary" :disabled="isAppending" @click="load(false, true)">
            {{ isAppending ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
