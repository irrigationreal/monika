<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useForumState } from '../composables/useForumState';
import { api, type UserFileDto } from '../lib/apiClient';

const router = useRouter();
const state = useForumState();

const userFiles = ref<UserFileDto[]>([]);
const selectedFiles = ref<File[]>([]);
const isLoading = ref(false);
const isUploading = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const fileInputRef = ref<HTMLInputElement | null>(null);
const deletingById = ref<Record<string, boolean>>({});
const lastCopiedId = ref<string | null>(null);

const currentUser = computed(() => state.currentUser.value);
const totalBytes = computed(() => userFiles.value.reduce((total, file) => total + file.sizeBytes, 0));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function fileUrl(fileId: string): string {
  if (typeof window === 'undefined') return `/api/user-files/${fileId}`;
  return `${window.location.origin}/api/user-files/${fileId}`;
}

function handleFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  selectedFiles.value = files;
  errorMessage.value = '';
  successMessage.value = '';
}

function clearSelection(): void {
  selectedFiles.value = [];
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
}

async function loadFiles(): Promise<void> {
  if (!currentUser.value) return;
  isLoading.value = true;
  errorMessage.value = '';
  try {
    userFiles.value = await api.listUserFiles();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load files.';
  } finally {
    isLoading.value = false;
  }
}

async function uploadFiles(): Promise<void> {
  if (selectedFiles.value.length === 0) return;
  isUploading.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const uploaded: UserFileDto[] = [];
    for (const file of selectedFiles.value) {
      const result = await api.uploadUserFile(file);
      uploaded.push(result);
    }
    userFiles.value = [...uploaded, ...userFiles.value];
    successMessage.value = `Uploaded ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}.`;
    clearSelection();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to upload files.';
  } finally {
    isUploading.value = false;
  }
}

async function deleteFile(fileId: string): Promise<void> {
  deletingById.value = { ...deletingById.value, [fileId]: true };
  errorMessage.value = '';
  try {
    await api.deleteUserFile(fileId);
    userFiles.value = userFiles.value.filter((file) => file.id !== fileId);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to delete file.';
  } finally {
    deletingById.value = { ...deletingById.value, [fileId]: false };
  }
}

async function copyLink(fileId: string): Promise<void> {
  const url = fileUrl(fileId);
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    }
    lastCopiedId.value = fileId;
    successMessage.value = 'Link copied to clipboard.';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to copy link.';
  }
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value) {
    return;
  }
  await loadFiles();
});
</script>

<template>
  <section class="vb-section vb-user-files">
    <div class="vb-table-header">File Storage</div>

    <div v-if="!currentUser" class="vb-profile-content">
      <p>You must be logged in to manage your uploads.</p>
      <div class="vb-modal-actions">
        <button class="vb-btn" @click="goHome">Return to Forum</button>
      </div>
    </div>

    <div v-else class="vb-user-files-body">
      <div v-if="successMessage" class="vb-success-banner">{{ successMessage }}</div>
      <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>

      <div class="vb-user-files-card">
        <h3>Upload new files</h3>
        <p class="vb-user-files-hint">Uploads are stored privately in your account. Use the generated links to share.</p>
        <input
          ref="fileInputRef"
          class="vb-attachment-input"
          type="file"
          multiple
          @change="handleFileSelect"
        />
        <div v-if="selectedFiles.length" class="vb-attachment-selected">
          <ul>
            <li v-for="file in selectedFiles" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
          </ul>
          <div class="vb-attachment-status">Total: {{ formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0)) }}</div>
          <div class="vb-user-files-actions">
            <button class="vb-btn" type="button" :disabled="isUploading" @click="uploadFiles">
              {{ isUploading ? 'Uploading...' : 'Upload' }}
            </button>
            <button class="vb-btn vb-btn-secondary" type="button" :disabled="isUploading" @click="clearSelection">
              Clear
            </button>
          </div>
        </div>
      </div>

      <div class="vb-user-files-card">
        <div class="vb-user-files-header">
          <h3>Your files</h3>
          <span class="vb-user-files-total">{{ userFiles.length }} file{{ userFiles.length === 1 ? '' : 's' }} · {{ formatBytes(totalBytes) }}</span>
        </div>

        <div v-if="isLoading" class="vb-user-files-loading">Loading files...</div>
        <div v-else-if="userFiles.length === 0" class="vb-user-files-empty">No uploads yet. Add files above to get shareable links.</div>
        <ul v-else class="vb-user-files-list">
          <li v-for="file in userFiles" :key="file.id" class="vb-user-file-item">
            <div class="vb-user-file-main">
              <div class="vb-user-file-name">{{ file.filename }}</div>
              <div class="vb-user-file-meta">{{ formatBytes(file.sizeBytes) }} · {{ new Date(file.createdAt).toLocaleString() }}</div>
            </div>
            <div class="vb-user-file-link">
              <input class="vb-user-file-input" type="text" :value="fileUrl(file.id)" readonly />
              <div class="vb-user-file-buttons">
                <button class="vb-small-btn" type="button" @click="copyLink(file.id)">
                  {{ lastCopiedId === file.id ? 'Copied!' : 'Copy Link' }}
                </button>
                <button
                  class="vb-small-btn vb-danger-btn"
                  type="button"
                  :disabled="deletingById[file.id]"
                  @click="deleteFile(file.id)"
                >
                  {{ deletingById[file.id] ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
