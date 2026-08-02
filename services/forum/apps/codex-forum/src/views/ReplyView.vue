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
import { fencedCodeBlock } from '../lib/editorFormatting';

import type { MessageTemplateDto } from '../lib/apiClient';

const router = useRouter();
const route = useRoute();
const state = useForumState();
const { renderContent } = useMarkdown();

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
const replyFiles = ref<File[]>([]);
const replyFileInputRef = ref<HTMLInputElement | null>(null);
const publishedPostId = ref<string | null>(null);
const publishedTopicId = ref<string | null>(null);
const publishedNeedsDispatch = ref(false);
const allowPublishedNavigation = ref(false);
const selectedModel = ref(state.lastReplyModel.value ?? '');
const selectedReasoning = ref(state.lastReplyReasoning.value ?? 'medium');
const replyModels = computed(() => state.allModelOptions.value);
const effectiveSelectedModel = computed(
  () => selectedModel.value || (state.robotState.value as any)?.model || state.defaultModel.value || ''
);
const supportsReasoning = computed(() => state.modelSupportsReasoning(effectiveSelectedModel.value));
const sessionContext = computed(() => state.sessionContext.value);
const replyReasoningOptions = computed(() => state.modelReasoningOptions(effectiveSelectedModel.value));
const silentPost = ref(false);
const isAdmin = computed(() => state.currentUser.value?.kind === 'admin');
const autoCompactEnabled = ref(false);
const CHUNKED_THRESHOLD_BYTES = 90 * 1024 * 1024;

const autoRun = computed(() => state.topicAutoRun.value);
const showAutoRunPanel = computed(() => false);
const autoRunEnabled = ref(false);
const autoRunContext = ref('');
const autoRunWorker = ref<'echs'>('echs');
const autoRunModel = ref('');
const autoRunReasoning = ref('');
const autoRunMaxReplies = ref(20);
const autoRunSteerMessage = ref('');
const autoRunModelOptions = computed(() => {
  return [{ value: '', label: 'Default' }, ...replyModels.value.map((model) => ({ value: model, label: model }))];
});
const showAutoRunReasoning = computed(() => state.modelSupportsReasoning(autoRunModel.value));
const autoRunReasoningOptions = computed(() => state.modelReasoningOptions(autoRunModel.value));
const autoRunStatusLabel = computed(() => {
  const current = autoRun.value;
  if (!current || !current.enabled) return 'Disabled';
  if (current.status === 'running') return 'Running';
  if (current.status === 'error') return 'Error';
  if (current.status === 'stopped') return 'Stopped';
  return 'Enabled';
});
const canEditAutoRun = computed(() => Boolean(state.currentUser.value));
const autoRunBusy = computed(() => state.autoRunLoading.value);

const routeTopicId = computed(() => (route.params['topicId'] as string | undefined) ?? null);
const autosavedDraft = useAutosavedDraft({ context: 'reply', contextId: routeTopicId, body });
const topicTitle = computed(() => state.selectedTopic.value?.title ?? 'Topic');
const robotMode = computed(() => state.selectedTopic.value?.robotMode ?? 'auto');
const canSubmit = computed(
  () => body.value.trim().length > 0 && !isSubmitting.value && !isUploading.value && !publishedPostId.value
);
const isRobotBusy = computed(() => state.isRobotBusy.value);
const willDispatchRobot = computed(() => {
  if (silentPost.value) return false;
  if (robotMode.value === 'off') return false;
  if (robotMode.value === 'auto') return true;
  return /@robot\\b/i.test(body.value);
});
const willSteerRobot = computed(() => isRobotBusy.value && willDispatchRobot.value);
const bodyCharCount = computed(() => body.value.length);
const attachmentTotalBytes = computed(() => replyFiles.value.reduce((total, file) => total + file.size, 0));
const hasLargeAttachment = computed(() => replyFiles.value.some((file) => file.size >= CHUNKED_THRESHOLD_BYTES));

const allowedModels = computed(() => new Set([...replyModels.value]));
const allowedReasoning = computed(() => new Set(replyReasoningOptions.value));

function normalizeReasoning(model: string, reasoning: string): string {
  const options = state.modelReasoningOptions(model);
  if (options.includes(reasoning)) return reasoning;
  if (options.includes('medium')) return 'medium';
  return options[0] ?? 'medium';
}

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'k';
  return String(value);
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

function formatReasoningLabel(value: string): string {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
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
    body.value = `${before}${fencedCodeBlock(selectedText, before, after)}${after}`;
  } else if (tag === 'list') {
    body.value = `${before}[LIST]\n[*]${selectedText || 'Item 1'}\n[*]Item 2\n[/LIST]${after}`;
  } else {
    body.value = `${before}[${tag.toUpperCase()}]${selectedText}[/${tag.toUpperCase()}]${after}`;
  }

  setTimeout(() => {
    textarea.focus();
  }, 0);
}

async function applyMessageTemplate(template: MessageTemplateDto, replace: boolean): Promise<void> {
  await applyTemplateToTextarea({ body, textarea: editorTextareaRef, templateBody: template.body, replace });
}

function renderPreview(text: string): string {
  return renderContent(text, { topicId: routeTopicId.value });
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

function handleReplyFiles(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  replyFiles.value = input?.files ? Array.from(input.files) : [];
}

function clearReplyFiles(): void {
  replyFiles.value = [];
  if (replyFileInputRef.value) replyFileInputRef.value.value = '';
}

async function saveAutoRun(): Promise<void> {
  await state.updateAutoRun({
    enabled: autoRunEnabled.value,
    context: autoRunContext.value.trim() || null,
    worker: autoRunWorker.value,
    model: autoRunModel.value.trim() || null,
    reasoningEffort: showAutoRunReasoning.value ? autoRunReasoning.value.trim() || null : null,
    maxReplies: autoRunMaxReplies.value,
  });
}

async function resetAutoRunCount(): Promise<void> {
  await state.updateAutoRun({ resetCount: true });
}

async function runAutoRunDirector(): Promise<void> {
  const message = autoRunSteerMessage.value.trim() || null;
  await state.runAutoRun(message);
  autoRunSteerMessage.value = '';
}

async function finishPublishedAttachments(): Promise<void> {
  const postId = publishedPostId.value;
  if (!postId) return;
  isUploading.value = true;
  for (const file of [...replyFiles.value]) {
    await state.uploadAttachment(postId, file);
    replyFiles.value = replyFiles.value.filter((item) => item !== file);
  }
  if (publishedNeedsDispatch.value) {
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  }
  publishedNeedsDispatch.value = false;
  publishedPostId.value = null;
}
async function goToPublishedReply(): Promise<void> {
  if (!publishedTopicId.value) return;
  allowPublishedNavigation.value = true;
  await router.push({ name: 'topic.view', params: { topicId: publishedTopicId.value } });
}
async function retryPublishedAttachments(): Promise<void> {
  errorMessage.value = '';
  try {
    await finishPublishedAttachments();
    await goToPublishedReply();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Attachment retry failed.';
  } finally {
    isUploading.value = false;
  }
}
async function abandonPublishedAttachments(): Promise<void> {
  const postId = publishedPostId.value;
  if (!postId) return;
  if (publishedNeedsDispatch.value)
    await state.dispatchPost(postId, {
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
    });
  replyFiles.value = [];
  publishedNeedsDispatch.value = false;
  publishedPostId.value = null;
  await goToPublishedReply();
}

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  if (state.isTopicLocked()) {
    errorMessage.value = 'Cannot reply to a locked or archived topic.';
    return;
  }

  errorMessage.value = '';
  isSubmitting.value = true;
  let postCreated = false;

  try {
    const draftReference = await autosavedDraft.flush();
    if (autosavedDraft.status.value === 'conflict') {
      throw new Error('Resolve the draft conflict before posting.');
    }
    autosavedDraft.pause();
    const attachmentsPending = replyFiles.value.length > 0 && !silentPost.value;
    const post = await state.createPost(body.value.trim(), {
      silent: silentPost.value,
      model: effectiveSelectedModel.value,
      ...(supportsReasoning.value ? { reasoningEffort: selectedReasoning.value } : {}),
      ...(isAdmin.value
        ? {
            autoCompactEnabled: autoCompactEnabled.value,
            autoCompactRevision: state.selectedTopic.value?.autoCompactRevision ?? 0,
          }
        : {}),
      attachmentsPending,
      ...(draftReference ? { draft: draftReference } : {}),
    });
    postCreated = true;
    body.value = '';
    publishedPostId.value = post.id;
    publishedTopicId.value = post.topicId;
    publishedNeedsDispatch.value = attachmentsPending;

    if (replyFiles.value.length > 0) await finishPublishedAttachments();
    else publishedPostId.value = null;

    const lastPage = state.totalPages.value;
    const lastIndex = state.sortedPosts.value.length;
    await router.push({
      name: 'topic.view',
      params: { topicId: post.topicId },
      query: { page: String(lastPage) },
      hash: `#${lastIndex}`,
    });
  } catch (err) {
    if (!postCreated) autosavedDraft.resume();
    errorMessage.value = postCreated
      ? 'Reply posted, but one or more attachments did not finish. Do not resubmit it; selected files remain in this tab.'
      : err instanceof Error
        ? err.message
        : 'Failed to post reply.';
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

async function guardDraftNavigation(): Promise<boolean> {
  if (!allowPublishedNavigation.value && publishedPostId.value) {
    errorMessage.value = 'Finish or abandon the published reply’s attachment recovery before leaving this page.';
    return false;
  }
  const saved = await autosavedDraft.flushForNavigation();
  if (!saved) errorMessage.value = 'This draft could not be saved. Resolve the draft status before leaving.';
  return saved;
}

async function handleCancel(): Promise<void> {
  if (!(await guardDraftNavigation())) return;
  if (routeTopicId.value) {
    await router.push({ name: 'topic.view', params: { topicId: routeTopicId.value } });
  } else {
    router.back();
  }
}

onBeforeRouteLeave(() => guardDraftNavigation());
onBeforeRouteUpdate(async (to, from) => {
  if (!(await guardDraftNavigation())) return false;
  if (to.params['topicId'] !== from.params['topicId'] && replyFiles.value.length > 0) {
    if (!window.confirm('Selected files are not saved with drafts. Leave this topic and clear those files?'))
      return false;
    clearReplyFiles();
  }
  return true;
});

async function loadTopic(topicId: string): Promise<void> {
  try {
    await state.selectTopicById(topicId);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load topic data.';
  }
}

function syncSelectionFromQuery(): void {
  const model = route.query['model'];
  if (typeof model === 'string' && allowedModels.value.has(model)) {
    selectedModel.value = model;
  }
  const reasoning = route.query['reasoning'];
  if (typeof reasoning === 'string' && allowedReasoning.value.has(reasoning)) {
    selectedReasoning.value = reasoning;
  }
  selectedReasoning.value = normalizeReasoning(effectiveSelectedModel.value, selectedReasoning.value);
}

watch(
  routeTopicId,
  async (topicId) => {
    body.value = '';
    if (topicId) {
      await loadTopic(topicId);
      if (state.isLoggedIn.value) await autosavedDraft.load();
    }
  },
  { immediate: true }
);

watch(
  () => state.selectedTopic.value?.autoCompactEnabled,
  (enabled) => {
    autoCompactEnabled.value = Boolean(enabled);
  },
  { immediate: true }
);

watch(
  autoRun,
  (value) => {
    autoRunEnabled.value = value?.enabled ?? false;
    autoRunContext.value = value?.context ?? '';
    autoRunWorker.value = (value?.worker as 'echs') ?? 'echs';
    autoRunModel.value = value?.model ?? '';
    autoRunReasoning.value = value?.reasoningEffort ?? '';
    autoRunMaxReplies.value = value?.maxReplies ?? 20;
  },
  { immediate: true }
);

watch(autoRunModel, (model) => {
  if (autoRunReasoning.value) {
    autoRunReasoning.value = normalizeReasoning(model, autoRunReasoning.value);
  }
});

watch(
  () => route.query,
  () => {
  syncSelectionFromQuery();
  },
  { immediate: true }
);

watch(
  () => state.lastReplyModel.value,
  (value) => {
    if (!route.query['model'] && value) {
      selectedModel.value = value;
    }
  }
);

watch(
  () => state.lastReplyReasoning.value,
  (value) => {
    if (!route.query['reasoning'] && value) {
      selectedReasoning.value = value;
    }
  }
);

watch([selectedModel, () => state.defaultModel.value], ([model]) => {
  const effective = model || state.defaultModel.value || '';
  selectedReasoning.value = normalizeReasoning(effective, selectedReasoning.value);
  if (!selectedModel.value && state.defaultModel.value) selectedModel.value = state.defaultModel.value;
});

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value) {
    await router.push({ name: 'topic.view', params: { topicId: routeTopicId.value ?? '' } });
    return;
  }
  if (!autosavedDraft.hydrated.value) await autosavedDraft.load();
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
    <div class="vb-table-header">Post Reply</div>

    <div class="vb-newthread-container">
      <div class="vb-forum-banner">
        <div class="vb-forum-banner-icon">&#128172;</div>
        <div class="vb-forum-banner-info">
          <div class="vb-forum-banner-label">Replying to:</div>
          <div class="vb-forum-banner-name">{{ topicTitle }}</div>
        </div>
      </div>

      <div v-if="!state.isLoggedIn.value" class="vb-login-notice">
        You must be logged in to reply.
        <template v-if="state.canShowRegisterLink.value">
          <router-link to="/login">Log in</router-link> or <router-link to="/register">register</router-link>.
        </template>
        <template v-else> <router-link to="/login">Log in</router-link>. </template>
      </div>

      <div v-if="errorMessage" class="vb-login-error">
        {{ errorMessage }}
      </div>

      <div v-if="showAutoRunPanel" class="vb-robot-state">
        <div class="vb-table-header">
          <span>Auto-Run Director</span>
          <div class="vb-robot-actions">
            <span class="vb-status-pill">{{ autoRunStatusLabel }}</span>
            <label class="vb-inline-check">
              <input type="checkbox" v-model="autoRunEnabled" :disabled="!canEditAutoRun || autoRunBusy" />
              <span>Enabled</span>
            </label>
            <button class="vb-small-btn" type="button" :disabled="!canEditAutoRun || autoRunBusy" @click="saveAutoRun">
              Save
            </button>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy || !autoRunEnabled"
              @click="runAutoRunDirector"
            >
              Run
            </button>
          </div>
        </div>
        <div class="vb-robot-body">
          <div class="vb-state-row">
            <div>
              <strong>Replies:</strong> {{ autoRun?.replyCount ?? 0 }} / {{ autoRun?.maxReplies ?? autoRunMaxReplies }}
            </div>
            <div><strong>Last Run:</strong> {{ autoRun?.lastRunAt ? state.formatDate(autoRun.lastRunAt) : 'n/a' }}</div>
            <div>
              <strong>Last Reply:</strong> {{ autoRun?.lastReplyAt ? state.formatDate(autoRun.lastReplyAt) : 'n/a' }}
            </div>
          </div>
          <div v-if="state.autoRunError.value" class="vb-error">{{ state.autoRunError.value }}</div>
          <div v-if="autoRun?.lastNotes" class="vb-note">
            <strong>Director notes:</strong>
            <div>{{ autoRun.lastNotes }}</div>
          </div>
          <div v-if="autoRun?.lastSummary" class="vb-note">
            <strong>Last summary:</strong>
            <div>{{ autoRun.lastSummary }}</div>
          </div>
          <label>Auto-run context:</label>
          <textarea
            v-model="autoRunContext"
            class="vb-option-textarea"
            rows="5"
            :readonly="!canEditAutoRun"
            placeholder="Explain the outcome you want the director to pursue."
          ></textarea>
          <div class="vb-reply-options">
            <div class="vb-option-group">
              <label>Worker:</label>
              <select v-model="autoRunWorker" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option value="echs">echs</option>
              </select>
            </div>
            <div class="vb-option-group">
              <label>Model:</label>
              <select v-model="autoRunModel" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option v-for="option in autoRunModelOptions" :key="option.value || 'default'" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div v-if="showAutoRunReasoning" class="vb-option-group">
              <label>Reasoning:</label>
              <select v-model="autoRunReasoning" class="vb-option-select" :disabled="!canEditAutoRun || autoRunBusy">
                <option value="">Default</option>
                <option v-for="option in autoRunReasoningOptions" :key="option" :value="option">
                  {{ formatReasoningLabel(option) }}
                </option>
              </select>
            </div>
            <div v-else class="vb-option-group">
              <label>Reasoning:</label>
              <select class="vb-option-select" disabled>
                <option value="">n/a</option>
              </select>
            </div>
            <div class="vb-option-group">
              <label>Max Replies:</label>
              <input
                v-model.number="autoRunMaxReplies"
                type="number"
                min="1"
                class="vb-option-input"
                :disabled="!canEditAutoRun || autoRunBusy"
              />
          </div>
            <button
              class="vb-small-btn"
              type="button"
              :disabled="!canEditAutoRun || autoRunBusy"
              @click="resetAutoRunCount"
            >
              Reset Count
            </button>
          </div>
          <label>Steer director (optional):</label>
          <textarea
            v-model="autoRunSteerMessage"
            class="vb-option-textarea"
            rows="3"
            :disabled="!canEditAutoRun || autoRunBusy"
            placeholder="Add a one-off steering note for the director."
          ></textarea>
          <button
            class="vb-btn"
            type="button"
            :disabled="!canEditAutoRun || autoRunBusy || !autoRunEnabled"
            @click="runAutoRunDirector"
          >
            {{ autoRunBusy ? 'Running...' : 'Run Director' }}
          </button>
        </div>
      </div>

      <div v-if="state.isLoggedIn.value" class="vb-newthread-form">
        <div v-if="state.isTopicLocked()" class="vb-locked-notice">
          This topic is {{ state.selectedTopic.value?.status }}. No new replies can be posted.
        </div>

        <div class="vb-form-section">
          <div class="vb-form-section-header">Message</div>
          <div class="vb-form-section-body">
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

            <div v-if="willSteerRobot" class="vb-steer-notice">
              Robot is responding right now — submitting this reply will interrupt and steer the agent.
            </div>

            <MessageTemplatePicker
              context="reply"
              :forum-id="state.selectedTopic.value?.forumId ?? null"
              :has-draft="body.length > 0"
              @apply="applyMessageTemplate"
            />
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
            <div class="vb-form-row">
              <textarea
                ref="editorTextareaRef"
                v-model="body"
                class="vb-editor-textarea"
                rows="12"
                placeholder="Enter your reply here. You can use BBCode formatting..."
                :disabled="state.isTopicLocked()"
              ></textarea>
              <div class="vb-char-count" :class="{ 'vb-char-warning': bodyCharCount === 0 }">
                {{ bodyCharCount }} characters
              </div>
            </div>

            <div class="vb-reply-attachments">
              <label class="vb-attachment-label">Attachments:</label>
              <span class="vb-form-hint">Selected files are not included in autosaved drafts.</span>
              <input
                ref="replyFileInputRef"
                class="vb-attachment-input"
                type="file"
                multiple
                @change="handleReplyFiles"
                :disabled="state.isTopicLocked()"
              />
              <div v-if="publishedPostId" class="vb-template-conflict" role="alert">
                Reply posted; attachment upload is incomplete. Retrying cannot duplicate the reply.
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="retryPublishedAttachments">
                  {{ replyFiles.length ? 'Retry remaining files' : 'Retry dispatch' }}
                </button>
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="abandonPublishedAttachments">
                  {{ replyFiles.length ? 'Abandon files' : 'Continue'
                  }}{{ publishedNeedsDispatch ? ' and dispatch' : '' }}
                </button>
                <button type="button" class="vb-small-btn" :disabled="isUploading" @click="goToPublishedReply">
                  Go to posted reply
                </button>
              </div>
              <div v-if="replyFiles.length > 0" class="vb-attachment-selected">
                <span>Selected:</span>
                <ul>
                  <li v-for="file in replyFiles" :key="file.name">{{ file.name }} ({{ formatBytes(file.size) }})</li>
                </ul>
                <div class="vb-attachment-status">
                  Total: {{ formatBytes(attachmentTotalBytes) }}
                  <span v-if="hasLargeAttachment">· Large files upload in chunks — keep this tab open.</span>
                </div>
              </div>
            </div>

            <div class="vb-preview-toggle">
              <button type="button" class="vb-small-btn" @click="togglePreview">
                {{ showPreview ? 'Hide Preview' : 'Show Preview' }}
              </button>
            </div>

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
              <div class="vb-reply-options">
                <div class="vb-option-group">
                  <label for="reply-model-select">Model:</label>
                  <select
                    id="reply-model-select"
                    v-model="selectedModel"
                    class="vb-option-select"
                    :disabled="silentPost || robotMode === 'off'"
                  >
                    <option v-for="model in replyModels" :key="model" :value="model">{{ model }}</option>
                  </select>
                </div>
                <div class="vb-option-group" v-if="supportsReasoning">
                  <label for="reply-reasoning-select">Reasoning:</label>
                  <select
                    id="reply-reasoning-select"
                    v-model="selectedReasoning"
                    class="vb-option-select"
                    :disabled="silentPost || robotMode === 'off'"
                  >
                    <option v-for="option in replyReasoningOptions" :key="option" :value="option">
                      {{ formatReasoningLabel(option) }}
                    </option>
                  </select>
                </div>
                <span v-if="robotMode === 'mention'" class="vb-reply-options-callout"
                  >Robot replies only when @robot is included.</span
                >
                <span v-else-if="robotMode === 'off'" class="vb-reply-options-callout"
                  >Robot replies are disabled for this thread.</span
                >
              </div>
              <AutoCompactOption v-model="autoCompactEnabled" :can-edit="isAdmin" :busy="isRobotBusy" />
              <div v-if="sessionContext" class="vb-reply-context-meter">
                <strong>Context:</strong>
                <span
                  v-if="sessionContext.usedTokens !== null && sessionContext.contextWindowTokens"
                  class="vb-context-value"
                >
                  {{ formatTokenCount(sessionContext.usedTokens) }} /
                  {{ formatTokenCount(sessionContext.contextWindowTokens) }}
                  <span v-if="typeof sessionContext.percent === 'number'"
                    >({{ sessionContext.percent.toFixed(1) }}%)</span
                  >
                  <span v-if="!sessionContext.exact" class="vb-context-warning"
                    >best Pi usage; not exact current context</span
                  >
                </span>
                <span v-else>usage unavailable</span>
                <span v-if="sessionContext.model" class="vb-context-model">· {{ sessionContext.model }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="vb-form-actions">
          <button class="vb-btn vb-btn-primary" :disabled="!canSubmit || state.isTopicLocked()" @click="handleSubmit">
            <span v-if="isSubmitting" class="vb-btn-spinner"></span>
            {{
              isUploading
                ? 'Uploading...'
                : isSubmitting
                  ? 'Posting...'
                  : willSteerRobot
                    ? 'Steer Reply'
                    : 'Submit Reply'
            }}
          </button>
          <button class="vb-btn" @click="handlePreviewButton">Preview Reply</button>
          <button class="vb-btn vb-btn-secondary" @click="handleCancel">Back (keep draft)</button>
        </div>

        <div class="vb-posting-rules">
          <div class="vb-posting-rules-header">Posting Rules</div>
          <div class="vb-posting-rules-body">
            <ul>
              <li>You <strong>may</strong> post replies</li>
              <li>You <strong>may</strong> edit your posts</li>
              <li>You <strong>may</strong> use Markdown and BBCode formatting</li>
            </ul>
            <div class="vb-bbcode-legend">
              <strong>Formatting:</strong> Markdown fences for code; [B]bold[/B], [I]italic[/I], [U]underline[/U], [URL]link[/URL],
              [IMG]image[/IMG], [QUOTE]quote[/QUOTE], and legacy [CODE]code[/CODE]
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

.vb-char-count {
  text-align: right;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-disabled);
}

.vb-char-count.vb-char-warning {
  color: var(--status-error);
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
</style>
