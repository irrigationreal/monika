<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import AutoCompactOption from '../components/AutoCompactOption.vue';
import ConfirmationDialog from '../components/ConfirmationDialog.vue';
import DraftStatus from '../components/DraftStatus.vue';
import MessageTemplatePicker from '../components/MessageTemplatePicker.vue';
import { useAutosavedDraft } from '../composables/useAutosavedDraft';
import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { applyTemplateToTextarea } from '../composables/useMessageTemplateInsertion';
import { api } from '../lib/apiClient';

import type { MessageDraftDto, MessageTemplateDto } from '../lib/apiClient';

const router = useRouter();
const route = useRoute();
const state = useForumState();
const { renderContent } = useMarkdown();

const title = ref('');
const body = ref('');
const editorTextareaRef = ref<HTMLTextAreaElement | null>(null);
const isSubmitting = ref(false);
const isUploading = ref(false);
const errorMessage = ref('');
const showDiscardDraftConfirm = ref(false);
const discardDraftPending = ref(false);
const showPreview = ref(false);
const previewHtml = ref('');
const previewSource = ref('');
const threadFiles = ref<File[]>([]);
const publishedPostId = ref<string | null>(null);
const publishedTopicId = ref<string | null>(null);
const publishedNeedsDispatch = ref(false);
const threadFileInputRef = ref<HTMLInputElement | null>(null);
const selectedModel = ref(state.lastReplyModel.value ?? '');
const selectedReasoning = ref(state.lastReplyReasoning.value ?? 'medium');
const silentPost = ref(false);
const robotMode = ref<'auto' | 'mention' | 'off'>('auto');
const autoCompactEnabled = ref(false);
const isAdmin = computed(() => state.currentUser.value?.kind === 'admin');

const modelOptions = computed(() => state.allModelOptions.value);
const allowedModels = computed(() => new Set(modelOptions.value));
const effectiveSelectedModel = computed(() => selectedModel.value || state.defaultModel.value || '');
const supportsReasoning = computed(() => state.modelSupportsReasoning(effectiveSelectedModel.value));
const reasoningOptions = computed(() => state.modelReasoningOptions(effectiveSelectedModel.value));
const allowedReasoning = computed(() => new Set(reasoningOptions.value));
const CHUNKED_THRESHOLD_BYTES = 90 * 1024 * 1024;

const routeForumId = computed(() => (route.params['forumId'] as string | undefined) ?? null);
const routeDraftId = computed(() => (typeof route.query['draft'] === 'string' ? route.query['draft'] : null));
const existingForumDrafts = ref<MessageDraftDto[]>([]);
const draftListError = ref('');
const allowPublishedNavigation = ref(false);
const autosavedDraft = useAutosavedDraft({
  context: 'new_thread',
  contextId: routeForumId,
  body,
  title,
  initialDraftId: routeDraftId,
  onDraftCreated: (id) => void router.replace({ query: { ...route.query, draft: id } }),
});
const forumName = computed(() => state.selectedForum.value?.name ?? 'Forum');

const canSubmit = computed(() => {
  return (
    title.value.trim().length >= 3 &&
    body.value.trim().length >= 10 &&
    !isSubmitting.value &&
    !isUploading.value &&
    !publishedTopicId.value
  );
});

const titleCharCount = computed(() => title.value.length);
const bodyCharCount = computed(() => body.value.length);
const attachmentTotalBytes = computed(() => threadFiles.value.reduce((total, file) => total + file.size, 0));
const hasLargeAttachment = computed(() => threadFiles.value.some((file) => file.size >= CHUNKED_THRESHOLD_BYTES));

function normalizeReasoning(model: string, reasoning: string): string {
  const options = state.modelReasoningOptions(model);
  if (options.includes(reasoning)) return reasoning;
  if (options.includes('medium')) return 'medium';
  return options[0] ?? 'medium';
}

function formatReasoningLabel(value: string): string {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function insertBBCode(tag: string, defaultText?: string): void {
  const textarea = editorTextareaRef.value;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = body.value.substring(start, end) || defaultText || '';
  const before = body.value.substring(0, start);
  const after = body.value.substring(end);

  if (tag === 'url') {
    const url = selectedText.startsWith('http') ? selectedText : 'https://';
    body.value = `${before}[URL=${url}]${selectedText.startsWith('http') ? 'Link Text' : selectedText}[/URL]${after}`;
  } else if (tag === 'img') {
    body.value = `${before}[IMG]${selectedText || 'https://'}[/IMG]${after}`;
  } else if (tag === 'quote') {
    body.value = `${before}[QUOTE]\n${selectedText}\n[/QUOTE]${after}`;
  } else if (tag === 'code') {
    body.value = `${before}[CODE]\n${selectedText}\n[/CODE]${after}`;
  } else if (tag === 'list') {
    body.value = `${before}[LIST]\n[*]${selectedText || 'Item 1'}\n[*]Item 2\n[/LIST]${after}`;
  } else {
    body.value = `${before}[${tag.toUpperCase()}]${selectedText}[/${tag.toUpperCase()}]${after}`;
  }

  // Refocus textarea
  setTimeout(() => {
    textarea.focus();
  }, 0);
}

async function applyMessageTemplate(template: MessageTemplateDto, replace: boolean): Promise<void> {
  await applyTemplateToTextarea({ body, textarea: editorTextareaRef, templateBody: template.body, replace });
  if (!template.threadTitle) return;
  if (!title.value.trim()) title.value = template.threadTitle;
  else if (replace && window.confirm('Replace the current thread title with the template title?'))
    title.value = template.threadTitle;
}

function renderPreview(text: string): string {
  return renderContent(text);
}

function updatePreview(): void {
  previewSource.value = body.value;
  previewHtml.value = renderPreview(body.value);
}

function togglePreview(): void {
  showPreview.value = !showPreview.value;
  if (showPreview.value) updatePreview();
}

function handlePreviewButton(): void {
  if (!showPreview.value) {
    showPreview.value = true;
    updatePreview();
    return;
  }

  if (body.value !== previewSource.value) {
    updatePreview();
    return;
  }

  showPreview.value = false;
}

async function resolvePublishedPostId(): Promise<string> {
  if (publishedPostId.value) return publishedPostId.value;
  if (!publishedTopicId.value) throw new Error('The published thread is unavailable.');
  const postPage = await api.listPosts(publishedTopicId.value, { page: 1, pageSize: 1 });
  const initialPost = postPage.items[0];
  if (!initialPost) throw new Error('Thread created, but its initial post could not be located.');
  publishedPostId.value = initialPost.id;
  return initialPost.id;
}

async function finishPublishedAttachments(): Promise<void> {
  const postId = await resolvePublishedPostId();
  isUploading.value = true;
  for (const file of [...threadFiles.value]) {
    await state.uploadAttachment(postId, file);
    threadFiles.value = threadFiles.value.filter((item) => item !== file);
  }
  if (publishedNeedsDispatch.value) {
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  }
  publishedNeedsDispatch.value = false;
  publishedPostId.value = null;
  clearThreadFiles();
}

async function goToPublishedTopic(): Promise<void> {
  if (!publishedTopicId.value) return;
  allowPublishedNavigation.value = true;
  await router.push({ name: 'topic.view', params: { topicId: publishedTopicId.value } });
}

async function retryPublishedAttachments(): Promise<void> {
  errorMessage.value = '';
  try {
    await finishPublishedAttachments();
    await goToPublishedTopic();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Attachment retry failed.';
  } finally {
    isUploading.value = false;
  }
}

async function abandonPublishedAttachments(): Promise<void> {
  if (publishedNeedsDispatch.value) {
    const postId = await resolvePublishedPostId();
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  }
  clearThreadFiles();
  publishedNeedsDispatch.value = false;
  publishedPostId.value = null;
  await goToPublishedTopic();
}

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  errorMessage.value = '';
  isSubmitting.value = true;
  let topicCreated = false;
  try {
    const draftReference = await autosavedDraft.flush();
    if (autosavedDraft.status.value === 'conflict') {
      throw new Error('Resolve the draft conflict before posting.');
    }
    autosavedDraft.pause();
    const attachmentsPending = threadFiles.value.length > 0 && !silentPost.value;
    const topic = await state.createTopic(title.value.trim(), body.value.trim(), {
      silent: silentPost.value,
      robotMode: robotMode.value,
      ...(isAdmin.value ? { autoCompactEnabled: autoCompactEnabled.value } : {}),
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
      attachmentsPending,
      ...(draftReference ? { draft: draftReference } : {}),
    });
    topicCreated = true;
    title.value = '';
    body.value = '';
    publishedTopicId.value = topic.id;
    publishedNeedsDispatch.value = attachmentsPending;
    if (threadFiles.value.length > 0) await finishPublishedAttachments();
    await goToPublishedTopic();
  } catch (err) {
    if (!topicCreated) autosavedDraft.resume();
    errorMessage.value = topicCreated
      ? 'Thread created, but one or more attachments did not finish. Do not create it again; selected files remain in this tab.'
      : err instanceof Error
        ? err.message
        : 'Failed to create thread.';
  } finally {
    isSubmitting.value = false;
    isUploading.value = false;
  }
}

function requestDiscardDraft(): void {
  errorMessage.value = '';
  showDiscardDraftConfirm.value = true;
}

async function confirmDiscardDraft(): Promise<void> {
  if (discardDraftPending.value) return;
  discardDraftPending.value = true;
  errorMessage.value = '';
  try {
    await autosavedDraft.discard();
    showDiscardDraftConfirm.value = false;
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to discard draft.';
    showDiscardDraftConfirm.value = false;
  } finally {
    discardDraftPending.value = false;
  }
}

async function handleCancel(): Promise<void> {
  if (await guardDraftNavigation()) router.back();
}

function handleThreadFiles(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  threadFiles.value = input?.files ? Array.from(input.files) : [];
}

function clearThreadFiles(): void {
  threadFiles.value = [];
  if (threadFileInputRef.value) {
    threadFileInputRef.value.value = '';
  }
}

async function loadForum(forumId: string): Promise<void> {
  try {
    await state.loadForums();
    state.selectForum(forumId);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load forum data.';
  }
}

async function loadExistingForumDrafts(forumId: string): Promise<void> {
  draftListError.value = '';
  try {
    existingForumDrafts.value = (await api.listForumDrafts(forumId)).drafts;
  } catch {
    draftListError.value = 'Existing drafts could not be listed. Autosave is still available.';
  }
}

async function guardDraftNavigation(): Promise<boolean> {
  if (
    !allowPublishedNavigation.value &&
    publishedTopicId.value &&
    (threadFiles.value.length > 0 || publishedNeedsDispatch.value)
  ) {
    errorMessage.value = 'Finish or abandon the published thread’s attachment recovery before leaving this page.';
    return false;
  }
  const saved = await autosavedDraft.flushForNavigation();
  if (!saved) errorMessage.value = 'This draft could not be saved. Resolve the draft status before leaving.';
  return saved;
}

async function startFreshAfterLoadError(): Promise<void> {
  const query = { ...route.query };
  delete query['draft'];
  title.value = '';
  body.value = '';
  await router.replace({ query });
}

onBeforeRouteLeave(() => guardDraftNavigation());
onBeforeRouteUpdate(async (to, from) => {
  if (!(await guardDraftNavigation())) return false;
  if (to.params['forumId'] !== from.params['forumId'] && threadFiles.value.length > 0) {
    if (!window.confirm('Selected files are not saved with drafts. Leave this forum and clear those files?'))
      return false;
    clearThreadFiles();
  }
  return true;
});

watch(
  routeForumId,
  async (forumId) => {
    title.value = '';
    body.value = '';
    existingForumDrafts.value = [];
  if (forumId) {
    await loadForum(forumId);
      if (state.isLoggedIn.value) {
        await autosavedDraft.load();
        void loadExistingForumDrafts(forumId);
  }
    }
  },
  { immediate: true }
);

watch(
  () => route.query,
  () => {
  const model = route.query['model'];
  if (typeof model === 'string' && allowedModels.value.has(model)) {
    selectedModel.value = model;
  }
  const reasoning = route.query['reasoning'];
  if (typeof reasoning === 'string' && allowedReasoning.value.has(reasoning)) {
    selectedReasoning.value = reasoning;
  }
  },
  { immediate: true }
);

watch([selectedModel, () => state.defaultModel.value], ([model]) => {
  const effective = model || state.defaultModel.value || '';
  selectedReasoning.value = normalizeReasoning(effective, selectedReasoning.value);
  if (!selectedModel.value && state.defaultModel.value) selectedModel.value = state.defaultModel.value;
});

watch(routeDraftId, async (id) => {
  if (id === (autosavedDraft.draft.value?.id ?? null) && !autosavedDraft.loadError.value) return;
  title.value = '';
  body.value = '';
  await autosavedDraft.load();
});

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value) {
    await router.push({ name: 'forum.home' });
    return;
  }
  if (routeForumId.value) {
    if (!autosavedDraft.hydrated.value) await autosavedDraft.load();
    void loadExistingForumDrafts(routeForumId.value);
  }
});
</script>

<template>
  <ConfirmationDialog
    :open="showDiscardDraftConfirm"
    title="Discard draft?"
    message="This permanently deletes the saved draft and clears this editor. This cannot be undone."
    confirm-label="Discard draft"
    cancel-label="Keep editing"
    pending-label="Discarding…"
    :pending="discardDraftPending"
    @confirm="confirmDiscardDraft"
    @cancel="showDiscardDraftConfirm = false"
  />

  <section class="vb-section vb-fade-in">
    <div class="vb-table-header">Post New Thread</div>

    <div class="vb-newthread-container">
      <!-- Forum Info Banner -->
      <div class="vb-forum-banner">
        <div class="vb-forum-banner-icon">&#128194;</div>
        <div class="vb-forum-banner-info">
          <div class="vb-forum-banner-label">Posting in:</div>
          <div class="vb-forum-banner-name">{{ forumName }}</div>
        </div>
      </div>

      <!-- Not Logged In Notice -->
      <div v-if="!state.isLoggedIn.value" class="vb-login-notice">
        You must be logged in to create a thread.
        <template v-if="state.canShowRegisterLink.value">
          <router-link to="/login">Log in</router-link> or <router-link to="/register">register</router-link>.
        </template>
        <template v-else> <router-link to="/login">Log in</router-link>. </template>
      </div>

      <!-- Error Message -->
      <div v-if="errorMessage" class="vb-login-error">
        {{ errorMessage }}
      </div>

      <!-- New Thread Form -->
      <div v-if="state.isLoggedIn.value" class="vb-newthread-form">
        <div class="vb-form-section">
          <div class="vb-form-section-header">Thread Title</div>
          <div class="vb-form-section-body">
            <div class="vb-form-row">
              <label for="thread-title" class="vb-form-label">Title:</label>
              <div class="vb-form-input-wrapper">
                <input
                  id="thread-title"
                  v-model="title"
                  type="text"
                  class="vb-form-input"
                  placeholder="Enter a descriptive title for your thread"
                  maxlength="255"
                />
                <div class="vb-char-count" :class="{ 'vb-char-warning': titleCharCount < 3 }">
                  {{ titleCharCount }} / 255
                </div>
              </div>
              <div v-if="titleCharCount > 0 && titleCharCount < 3" class="vb-form-error">
                Title must be at least 3 characters.
              </div>
            </div>
          </div>
        </div>

        <div class="vb-form-section">
          <div class="vb-form-section-header">Message</div>
          <div class="vb-form-section-body">
            <!-- Editor Toolbar -->
            <div class="vb-editor-toolbar">
              <button type="button" class="vb-editor-btn" title="Bold" @click="insertBBCode('b')">
                <strong>B</strong>
              </button>
              <button type="button" class="vb-editor-btn" title="Italic" @click="insertBBCode('i')"><em>I</em></button>
              <button type="button" class="vb-editor-btn" title="Underline" @click="insertBBCode('u')"><u>U</u></button>
              <button type="button" class="vb-editor-btn" title="Strikethrough" @click="insertBBCode('s')">
                <s>S</s>
              </button>
              <span class="vb-toolbar-divider"></span>
              <button type="button" class="vb-editor-btn" title="Insert Link" @click="insertBBCode('url')">
                &#128279;
              </button>
              <button type="button" class="vb-editor-btn" title="Insert Image" @click="insertBBCode('img')">
                &#128247;
              </button>
              <span class="vb-toolbar-divider"></span>
              <button type="button" class="vb-editor-btn" title="Quote" @click="insertBBCode('quote')">&#10077;</button>
              <button type="button" class="vb-editor-btn" title="Code" @click="insertBBCode('code')">
                &#60;/&#62;
              </button>
              <button type="button" class="vb-editor-btn" title="List" @click="insertBBCode('list')">&#9776;</button>
            </div>

            <MessageTemplatePicker
              context="new_thread"
              :forum-id="routeForumId"
              :has-draft="body.length > 0 || title.length > 0"
              @apply="applyMessageTemplate"
            />
            <div v-if="draftListError" class="vb-form-hint" role="status">{{ draftListError }}</div>
            <div v-if="autosavedDraft.loadError.value" class="vb-template-conflict" role="alert">
              {{ autosavedDraft.loadError.value }}
              <button type="button" class="vb-small-btn" @click="startFreshAfterLoadError">Start a fresh draft</button>
            </div>
            <div v-if="!routeDraftId && existingForumDrafts.length" class="vb-form-hint vb-draft-notice">
              You have {{ existingForumDrafts.length }} existing draft{{ existingForumDrafts.length === 1 ? '' : 's' }}
              in this forum.
              <router-link
                :to="{
                  name: 'forum.newthread',
                  params: { forumId: routeForumId },
                  query: { draft: existingForumDrafts[0]?.id },
                }"
                >Continue most recent</router-link
              >
              · <router-link :to="{ name: 'user.drafts' }">View all drafts</router-link>
            </div>
            <DraftStatus
              :status="autosavedDraft.status.value"
              :expires-at="autosavedDraft.expiresAt.value"
              :conflict="Boolean(autosavedDraft.remoteDraft.value)"
              @retry="autosavedDraft.resume()"
              @discard="requestDiscardDraft"
              @use-saved="autosavedDraft.useSavedVersion()"
              @keep-mine="autosavedDraft.keepMyVersion()"
              @copy-mine="autosavedDraft.copyMyText()"
            />
            <!-- Textarea -->
            <div class="vb-form-row">
              <textarea
                ref="editorTextareaRef"
                v-model="body"
                class="vb-editor-textarea"
                rows="15"
                placeholder="Enter your message here. You can use BBCode formatting..."
              ></textarea>
              <div class="vb-char-count" :class="{ 'vb-char-warning': bodyCharCount < 10 && bodyCharCount > 0 }">
                {{ bodyCharCount }} characters
              </div>
              <div v-if="bodyCharCount > 0 && bodyCharCount < 10" class="vb-form-error">
                Message must be at least 10 characters.
              </div>
            </div>

            <div class="vb-reply-attachments">
              <label class="vb-attachment-label">Attachments:</label>
              <span class="vb-form-hint">Selected files are not included in autosaved drafts.</span>
              <input
                ref="threadFileInputRef"
                class="vb-attachment-input"
                type="file"
                multiple
                @change="handleThreadFiles"
              />
              <div
                v-if="publishedTopicId && (threadFiles.length || publishedNeedsDispatch)"
                class="vb-template-conflict"
                role="alert"
              >
                Thread created; {{ threadFiles.length ? 'attachment upload' : 'robot dispatch' }} is incomplete.
                Retrying cannot create a duplicate thread. Complete it within five minutes.
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="retryPublishedAttachments">
                  {{ threadFiles.length ? 'Retry remaining files' : 'Retry dispatch' }}
                </button>
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="abandonPublishedAttachments">
                  {{ threadFiles.length ? 'Abandon files' : 'Continue'
                  }}{{ publishedNeedsDispatch ? ' and dispatch' : '' }}
                </button>
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="goToPublishedTopic">
                  Go to created thread
                </button>
              </div>
              <div v-if="threadFiles.length > 0" class="vb-attachment-selected">
                <span>Selected:</span>
                <ul>
                  <li v-for="file in threadFiles" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
                </ul>
                <div class="vb-attachment-status">
                  Total: {{ formatBytes(attachmentTotalBytes) }}
                  <span v-if="hasLargeAttachment">· Large files upload in chunks — keep this tab open.</span>
                </div>
              </div>
            </div>

            <!-- Preview Toggle -->
            <div class="vb-preview-toggle">
              <button type="button" class="vb-small-btn" @click="togglePreview">
                {{ showPreview ? 'Hide Preview' : 'Show Preview' }}
              </button>
            </div>

            <!-- Preview Panel -->
            <div v-if="showPreview" class="vb-preview-panel">
              <div class="vb-preview-header">Preview</div>
              <div class="vb-preview-body vb-rendered-content" v-html="previewHtml"></div>
            </div>
          </div>
        </div>

        <div class="vb-form-section">
          <div class="vb-form-section-header">Options</div>
          <div class="vb-form-section-body">
            <div class="vb-form-options">
              <label class="vb-checkbox-label">
                <input type="checkbox" checked />
                <span>Subscribe to this thread (receive notifications)</span>
              </label>
              <label class="vb-checkbox-label">
                <input v-model="silentPost" type="checkbox" />
                <span>No robot response for this post (silent)</span>
              </label>
              <AutoCompactOption v-if="isAdmin" v-model="autoCompactEnabled" :can-edit="isAdmin" />
              <div class="vb-reply-options">
                <div class="vb-option-group">
                  <label for="thread-robot-mode-select">Robot Replies:</label>
                  <select id="thread-robot-mode-select" v-model="robotMode" class="vb-option-select">
                    <option value="auto">Auto (reply to every post)</option>
                    <option value="mention">Mention-only (@robot)</option>
                    <option value="off">Off (never reply)</option>
                  </select>
                  <span v-if="robotMode === 'mention'" class="vb-form-hint"
                    >Robot replies only when @robot is included.</span
                  >
                </div>
                <div class="vb-option-group">
                  <label for="thread-model-select">Model:</label>
                  <select
                    id="thread-model-select"
                    v-model="selectedModel"
                    class="vb-option-select"
                    :disabled="silentPost || robotMode === 'off'"
                  >
                    <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
                  </select>
                </div>
                <div class="vb-option-group" v-if="supportsReasoning">
                  <label for="thread-reasoning-select">Reasoning:</label>
                  <select
                    id="thread-reasoning-select"
                    v-model="selectedReasoning"
                    class="vb-option-select"
                    :disabled="silentPost || robotMode === 'off'"
                  >
                    <option v-for="option in reasoningOptions" :key="option" :value="option">
                      {{ formatReasoningLabel(option) }}
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Submit Buttons -->
        <div class="vb-form-actions">
          <button class="vb-btn vb-btn-primary" :disabled="!canSubmit" @click="handleSubmit">
            <span v-if="isSubmitting" class="vb-btn-spinner"></span>
            {{ isUploading ? 'Uploading...' : isSubmitting ? 'Posting...' : 'Submit New Thread' }}
          </button>
          <button class="vb-btn" @click="handlePreviewButton">Preview Post</button>
          <button class="vb-btn vb-btn-secondary" @click="handleCancel">Back (keep draft)</button>
        </div>

        <!-- Posting Rules -->
        <div class="vb-posting-rules">
          <div class="vb-posting-rules-header">Posting Rules</div>
          <div class="vb-posting-rules-body">
            <ul>
              <li>You <strong>may</strong> post new threads</li>
              <li>You <strong>may</strong> post replies</li>
              <li>You <strong>may</strong> use BBCode formatting</li>
              <li>You <strong>may</strong> edit your posts</li>
            </ul>
            <div class="vb-bbcode-legend">
              <strong>BBCode:</strong> [B]bold[/B], [I]italic[/I], [U]underline[/U], [URL]link[/URL], [IMG]image[/IMG],
              [QUOTE]quote[/QUOTE], [CODE]code[/CODE]
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-newthread-container {
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-muted);
  animation: fade-in 0.3s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.vb-forum-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: linear-gradient(var(--grad-section-start), var(--grad-section-end));
  border-bottom: 1px solid var(--border-default);
}

.vb-forum-banner-icon {
  font-size: 24px;
}

.vb-forum-banner-info {
  display: flex;
  flex-direction: column;
}

.vb-forum-banner-label {
  font-size: 11px;
  color: var(--text-muted);
}

.vb-forum-banner-name {
  font-size: 14px;
  font-weight: bold;
  color: var(--brand-accent);
}

.vb-newthread-form {
  padding: 16px;
}

.vb-form-section {
  margin-bottom: 16px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  overflow: hidden;
}

.vb-form-section-header {
  background: linear-gradient(var(--grad-nav-start), var(--grad-nav-end));
  color: var(--text-inverse);
  font-weight: bold;
  font-size: 12px;
  padding: 8px 12px;
}

.vb-form-section-body {
  background: var(--bg-surface);
  padding: 16px;
}

.vb-form-row {
  margin-bottom: 12px;
}

.vb-form-row:last-child {
  margin-bottom: 0;
}

.vb-form-label {
  display: block;
  font-weight: bold;
  margin-bottom: 6px;
  color: var(--brand-accent);
  font-size: 12px;
}

.vb-form-input-wrapper {
  position: relative;
}

.vb-form-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  font-size: 13px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.vb-form-input:focus {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 3px rgba(92, 112, 153, 0.2);
}

.vb-char-count {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--text-disabled);
}

.vb-char-count.vb-char-warning {
  color: var(--status-error);
}

.vb-form-error {
  font-size: 11px;
  color: var(--status-error);
  margin-top: 4px;
}

/* Editor Toolbar */
.vb-editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px;
  background: linear-gradient(var(--bg-surface-alt), var(--bg-surface-muted));
  border: 1px solid var(--border-default);
  border-bottom: none;
  border-radius: 3px 3px 0 0;
}

.vb-editor-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(var(--bg-surface), var(--bg-surface-muted));
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  transition: background 0.1s ease;
}

.vb-editor-btn:hover {
  background: linear-gradient(var(--bg-surface-alt), var(--border-default));
}

.vb-editor-btn:active {
  background: linear-gradient(var(--border-default), var(--border-muted));
}

.vb-toolbar-divider {
  width: 1px;
  height: 24px;
  background: var(--border-muted);
  margin: 2px 4px;
}

.vb-editor-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: 0 0 3px 3px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 200px;
  background: var(--bg-input);
  color: var(--text-primary);
}

.vb-editor-textarea:focus {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 3px rgba(92, 112, 153, 0.2);
}

.vb-form-row .vb-char-count {
  position: static;
  transform: none;
  text-align: right;
  margin-top: 4px;
}

.vb-preview-toggle {
  margin-top: 12px;
}

.vb-preview-panel {
  margin-top: 12px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  overflow: hidden;
}

.vb-preview-header {
  background: linear-gradient(var(--grad-section-start), var(--grad-section-end));
  padding: 8px 12px;
  font-weight: bold;
  font-size: 12px;
  color: var(--brand-accent);
  border-bottom: 1px solid var(--border-default);
}

.vb-preview-body {
  padding: 16px;
  background: var(--bg-surface);
  min-height: 100px;
  line-height: 1.6;
}

.vb-form-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 16px;
  background: linear-gradient(var(--grad-section-start), var(--grad-section-end));
  border-top: 1px solid var(--border-default);
  margin: 0 -16px -16px -16px;
}

.vb-btn-primary {
  background: linear-gradient(var(--grad-success-start), var(--grad-success-end));
  border-color: var(--status-success);
  color: var(--text-inverse);
}

.vb-btn-primary:hover:not(:disabled) {
  background: linear-gradient(var(--status-success), var(--grad-success-end));
}

.vb-btn-primary:disabled {
  background: linear-gradient(var(--text-disabled), var(--text-muted));
  border-color: var(--text-muted);
  cursor: not-allowed;
}

.vb-btn-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-inverse);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

/* Posting Rules */
.vb-posting-rules {
  margin-top: 16px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  overflow: hidden;
}

.vb-posting-rules-header {
  background: linear-gradient(var(--grad-section-start), var(--grad-section-end));
  padding: 8px 12px;
  font-weight: bold;
  font-size: 12px;
  color: var(--brand-accent);
  border-bottom: 1px solid var(--border-default);
}

.vb-posting-rules-body {
  background: var(--bg-surface);
  padding: 12px 16px;
  font-size: 11px;
  color: var(--text-muted);
}

.vb-posting-rules-body ul {
  margin: 0;
  padding-left: 20px;
}

.vb-posting-rules-body li {
  margin-bottom: 4px;
}

.vb-bbcode-legend {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle);
  font-family: monospace;
  font-size: 10px;
}

/* Responsive */
@media (max-width: 600px) {
  .vb-form-actions {
    flex-direction: column;
  }

  .vb-form-actions .vb-btn {
    width: 100%;
  }

  .vb-editor-toolbar {
    justify-content: center;
  }
}
</style>
