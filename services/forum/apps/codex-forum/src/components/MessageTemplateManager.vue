<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';

import { useMarkdown } from '../composables/useMarkdown';
import { api } from '../lib/apiClient';

import type {
  AdminForumDto,
  ForumApi,
  ForumDto,
  MessageTemplateDto,
  MessageTemplateListResponseDto,
  MessageTemplateWriteRequest,
} from '../lib/apiClient';

const props = defineProps<{ system?: boolean }>();
const { renderContent } = useMarkdown();
const forumApi = api as unknown as ForumApi;
const adminForumApi = api as unknown as { listAdminForums: () => Promise<{ items: AdminForumDto[] }> };
const templates = ref<MessageTemplateDto[]>([]);
const forums = ref<{ id: string; name: string; status?: 'active' | 'archived' }[]>([]);
const selectedId = ref<string | null>(null);
const saving = ref(false);
const error = ref('');
const success = ref('');
const revisionConflict = ref(false);
const savedFormSignature = ref('');

const name = ref('');
const category = ref('');
const body = ref('');
const threadTitle = ref('');
const contexts = ref<('reply' | 'new_thread')[]>(['reply']);
const forumScope = ref<'all' | 'selected'>('all');
const forumIds = ref<string[]>([]);
const enabled = ref(true);
const editing = computed(() => templates.value.find((item) => item.id === selectedId.value) ?? null);
const canSave = computed(
  () =>
    !revisionConflict.value &&
    name.value.trim() &&
    body.value.trim() &&
    contexts.value.length &&
    (forumScope.value === 'all' || forumIds.value.length)
);
const formSignature = computed(() =>
  JSON.stringify({
    selectedId: selectedId.value,
    name: name.value,
    category: category.value,
    body: body.value,
    threadTitle: threadTitle.value,
    contexts: contexts.value,
    forumScope: forumScope.value,
    forumIds: forumIds.value,
    enabled: enabled.value,
  })
);
const hasUnsavedChanges = computed(() => formSignature.value !== savedFormSignature.value);
const bodyPreviewHtml = computed(() => renderContent(body.value, { topicId: null }));

function rememberForm(): void {
  savedFormSignature.value = formSignature.value;
}

function reset(): void {
  selectedId.value = null;
  name.value = '';
  category.value = '';
  body.value = '';
  threadTitle.value = '';
  contexts.value = ['reply'];
  forumScope.value = 'all';
  forumIds.value = [];
  enabled.value = true;
  error.value = '';
  success.value = '';
  revisionConflict.value = false;
  rememberForm();
}
function edit(template: MessageTemplateDto): void {
  selectedId.value = template.id;
  name.value = template.name;
  category.value = template.category ?? '';
  body.value = template.body;
  threadTitle.value = template.threadTitle ?? '';
  contexts.value = [...template.contexts];
  forumScope.value = template.forumScope;
  forumIds.value = [...template.forumIds];
  enabled.value = template.enabled;
  error.value = '';
  success.value = '';
  revisionConflict.value = false;
  rememberForm();
}
function payload(): MessageTemplateWriteRequest {
  return {
    name: name.value,
    category: category.value || null,
    body: body.value,
    threadTitle: threadTitle.value || null,
    contexts: contexts.value,
    forumScope: forumScope.value,
    forumIds: forumScope.value === 'all' ? [] : forumIds.value,
    enabled: enabled.value,
  };
}
async function fetchData(): Promise<void> {
  const templateResponse: MessageTemplateListResponseDto = props.system
    ? await api.listSystemMessageTemplates()
    : await api.listMyMessageTemplates();
  let forumItems: (ForumDto | AdminForumDto)[];
  if (props.system) {
    const response = await adminForumApi.listAdminForums();
    forumItems = response.items;
  } else {
    forumItems = await forumApi.listForums({ includeArchived: true });
  }
  templates.value = templateResponse.templates;
  forums.value = forumItems.map((forum) => ({
    id: forum.id,
    name: forum.name,
    ...(forum.status ? { status: forum.status } : {}),
  }));
}
async function load(): Promise<void> {
  error.value = '';
  try {
    await fetchData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load message templates.';
  }
}
function isConflict(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'status' in err && err.status === 409);
}
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
async function refreshConflict(message: string, preserveDraft = false): Promise<void> {
  try {
    await fetchData();
    revisionConflict.value = preserveDraft;
    error.value = message;
  } catch (err) {
    error.value = `Templates changed, and the latest list could not be loaded: ${errorMessage(err, 'refresh failed')}`;
  }
}
async function save(): Promise<void> {
  if (!canSave.value || revisionConflict.value) return;
  saving.value = true;
  error.value = '';
  success.value = '';
  let mutationCompleted = false;
  try {
    const current = editing.value;
    if (current) {
      const input = { ...payload(), revision: current.revision };
      if (props.system) await api.updateSystemMessageTemplate(current.id, input);
      else await api.updateMessageTemplate(current.id, input);
    } else if (props.system) await api.createSystemMessageTemplate(payload());
    else await api.createMessageTemplate(payload());
    mutationCompleted = true;
    await fetchData();
    reset();
    success.value = 'Message template saved.';
  } catch (err) {
    error.value = mutationCompleted
      ? 'The template was saved, but the latest template list could not be loaded. Reload templates before retrying.'
      : errorMessage(err, 'Failed to save message template.');
    revisionConflict.value = isConflict(err);
  } finally {
    saving.value = false;
  }
}
async function reloadConflict(): Promise<void> {
  const id = selectedId.value;
  try {
    await fetchData();
    const latest = templates.value.find((item) => item.id === id);
    if (latest) edit(latest);
    else reset();
  } catch (err) {
    error.value = `The latest template could not be loaded: ${errorMessage(err, 'refresh failed')}`;
    revisionConflict.value = true;
  }
}
async function saveConflictCopy(): Promise<void> {
  selectedId.value = null;
  name.value = `${name.value} (conflict copy)`;
  revisionConflict.value = false;
  await save();
}
async function remove(template: MessageTemplateDto): Promise<void> {
  if (!window.confirm(`Delete “${template.name}”?`)) return;
  let mutationCompleted = false;
  try {
    if (props.system) await api.deleteSystemMessageTemplate(template.id, template.revision);
    else await api.deleteMessageTemplate(template.id, template.revision);
    mutationCompleted = true;
    await fetchData();
    if (selectedId.value === template.id) reset();
  } catch (err) {
    if (isConflict(err)) {
      await refreshConflict(
        'This template changed before it could be deleted. The latest list has been loaded.',
        selectedId.value === template.id
      );
      return;
    }
    error.value = mutationCompleted
      ? 'The template was deleted, but the latest template list could not be loaded. Reload templates.'
      : errorMessage(err, 'Failed to delete message template.');
  }
}
async function move(index: number, direction: -1 | 1): Promise<void> {
  const target = index + direction;
  if (target < 0 || target >= templates.value.length) return;
  const ordered = [...templates.value];
  const current = ordered[index];
  const next = ordered[target];
  if (!current || !next) return;
  ordered[index] = next;
  ordered[target] = current;
  try {
    const input = { items: ordered.map((item) => ({ id: item.id, revision: item.revision })) };
    const response = props.system
      ? await api.reorderSystemMessageTemplates(input)
      : await api.reorderMessageTemplates(input);
    templates.value = response.templates;
  } catch (err) {
    if (isConflict(err)) {
      await refreshConflict('The template order changed elsewhere. The latest order has been loaded.');
      return;
    }
    error.value = errorMessage(err, 'Failed to reorder message templates.');
  }
}
function duplicate(template: MessageTemplateDto): void {
  edit(template);
  selectedId.value = null;
  name.value = `${template.name} (copy)`;
}
function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (!hasUnsavedChanges.value || window.confirm('Discard unsaved message template changes?')) return true;
  return false;
});
onMounted(() => {
  reset();
  window.addEventListener('beforeunload', warnBeforeUnload);
  void load();
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnBeforeUnload);
});
</script>

<template>
  <div
    class="vb-message-template-manager"
    :data-testid="system ? 'system-message-template-manager' : 'message-template-manager'"
  >
    <p class="vb-template-intro">
      Templates insert literal text into a draft. They never submit a post or change robot options.
    </p>
    <div v-if="error" class="vb-login-error" role="alert">
      {{ error }}
      <button type="button" class="vb-small-btn" @click="load">Reload templates</button>
    </div>
    <div v-if="revisionConflict" class="vb-template-conflict" role="alert">
      <span>Your draft is preserved. Reload the latest version or save this draft as a copy.</span>
      <div class="vb-template-notice-actions">
        <button type="button" class="vb-small-btn" @click="reloadConflict">Reload latest</button>
        <button type="button" class="vb-small-btn" @click="saveConflictCopy">Save as copy</button>
      </div>
    </div>
    <div v-if="success" class="vb-success-banner" role="status" aria-live="polite">{{ success }}</div>
    <div class="vb-template-manager-grid">
      <div class="vb-template-list">
        <div class="vb-template-list-header">
          <strong>{{ system ? 'System' : 'My' }} templates ({{ templates.length }} / {{ system ? 500 : 200 }})</strong>
          <button type="button" class="vb-small-btn" @click="reset">New</button>
        </div>
        <div v-if="!templates.length" class="vb-form-hint">No message templates yet.</div>
        <div v-for="(template, index) in templates" :key="template.id" class="vb-template-row">
          <button type="button" class="vb-template-name" @click="edit(template)">{{ template.name }}</button>
          <span>{{ template.category || 'Uncategorized' }} · {{ template.enabled ? 'Enabled' : 'Disabled' }}</span>
          <div class="vb-template-row-actions">
            <button
              type="button"
              class="vb-small-btn"
              :disabled="index === 0"
              :aria-label="`Move ${template.name} up`"
              @click="move(index, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="vb-small-btn"
              :disabled="index === templates.length - 1"
              :aria-label="`Move ${template.name} down`"
              @click="move(index, 1)"
            >
              ↓
            </button>
            <button type="button" class="vb-small-btn" @click="duplicate(template)">Duplicate</button>
            <button type="button" class="vb-small-btn vb-btn-danger" @click="remove(template)">Delete</button>
          </div>
        </div>
      </div>
      <div class="vb-template-form">
        <h3>{{ editing ? 'Edit' : 'Create' }} Message Template</h3>
        <label class="vb-template-field">
          <span>Name</span>
          <input v-model="name" class="vb-template-control" maxlength="80" data-testid="message-template-name" />
        </label>
        <label class="vb-template-field">
          <span>Category</span>
          <input v-model="category" class="vb-template-control" maxlength="40" list="message-template-categories" />
        </label>
        <datalist id="message-template-categories">
          <option
            v-for="item in [...new Set(templates.map((template) => template.category).filter(Boolean))]"
            :key="item || ''"
            :value="item || ''"
          />
        </datalist>
        <label class="vb-template-field">
          <span>Body</span>
          <textarea
            v-model="body"
            class="vb-template-control vb-template-body-input"
            rows="10"
            data-testid="message-template-body"
          ></textarea>
        </label>
        <label class="vb-template-field">
          <span>New-thread title (optional)</span>
          <input v-model="threadTitle" class="vb-template-control" maxlength="255" />
        </label>
        <fieldset class="vb-template-fieldset">
          <legend>Available in</legend>
          <div class="vb-template-choice-group">
            <label class="vb-template-inline-check"
              ><input v-model="contexts" type="checkbox" value="reply" /> <span>Replies</span></label
            >
            <label class="vb-template-inline-check"
              ><input v-model="contexts" type="checkbox" value="new_thread" /> <span>New threads</span></label
            >
          </div>
        </fieldset>
        <fieldset class="vb-template-fieldset">
          <legend>Forums</legend>
          <div class="vb-template-choice-group">
            <label class="vb-template-inline-check"
              ><input v-model="forumScope" type="radio" value="all" /> <span>All forums</span></label
            >
            <label class="vb-template-inline-check"
              ><input v-model="forumScope" type="radio" value="selected" /> <span>Selected forums</span></label
            >
          </div>
          <select v-if="forumScope === 'selected'" v-model="forumIds" class="vb-template-control" multiple size="6">
            <option v-for="forum in forums" :key="forum.id" :value="forum.id">
              {{ forum.name }}{{ forum.status === 'archived' ? ' (archived)' : '' }}
            </option>
          </select>
        </fieldset>
        <label class="vb-template-inline-check vb-template-enabled">
          <input v-model="enabled" type="checkbox" data-testid="message-template-enabled" />
          <span data-testid="message-template-enabled-label">Enabled</span>
        </label>
        <div class="vb-template-preview-region" role="region" aria-label="Template preview">
          <div class="vb-template-preview-label">Preview</div>
          <div class="vb-template-body-preview vb-rendered-content" v-html="bodyPreviewHtml"></div>
        </div>
        <div class="vb-modal-actions">
          <button
            type="button"
            class="vb-btn"
            :disabled="saving || !canSave"
            data-testid="message-template-save"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save Template' }}
          </button>
          <button type="button" class="vb-btn vb-btn-secondary" @click="reset">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vb-message-template-manager {
  min-width: 0;
  color: var(--text-primary);
}

.vb-template-intro {
  margin: 0 0 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.vb-template-manager-grid {
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(300px, 1.2fr);
  gap: 16px;
  min-width: 0;
}

.vb-template-list,
.vb-template-form {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: 0 1px 3px var(--shadow-color);
}

.vb-template-list-header,
.vb-template-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  padding: 9px 4px;
  border-bottom: 1px solid var(--border-default);
}

.vb-template-list-header {
  color: var(--text-primary);
}

.vb-template-row {
  color: var(--text-secondary);
  transition: background-color var(--transition-fast);
}

.vb-template-row:hover {
  background: var(--bg-surface-hover);
}

.vb-template-row > span {
  flex-basis: 100%;
  min-width: 0;
  color: var(--text-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.vb-template-name {
  min-width: 0;
  max-width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-weight: bold;
  text-align: left;
  text-decoration: underline;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.vb-template-name:hover {
  color: var(--text-secondary);
}

.vb-template-name:focus-visible {
  outline: 2px solid var(--status-info);
  outline-offset: 2px;
}

.vb-template-row-actions,
.vb-template-notice-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.vb-template-form {
  display: grid;
  align-content: start;
  gap: 12px;
}

.vb-template-form h3 {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-heading);
}

.vb-template-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--text-secondary);
  font-weight: bold;
}

.vb-template-control {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background-color var(--transition-fast);
}

.vb-template-control:focus,
.vb-template-control:focus-visible {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-info) 28%, transparent);
}

.vb-template-control:disabled {
  border-color: var(--border-muted);
  background: var(--bg-surface-muted);
  color: var(--text-disabled);
  cursor: not-allowed;
}

.vb-template-control option,
.vb-template-control optgroup {
  background: var(--bg-input);
  color: var(--text-primary);
}

.vb-template-body-input {
  min-height: 180px;
  resize: vertical;
  line-height: 1.5;
}

.vb-template-fieldset {
  min-width: 0;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
}

.vb-template-fieldset legend {
  padding: 0 5px;
  color: var(--text-primary);
  font-weight: bold;
}

.vb-template-choice-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 8px;
}

.vb-template-choice-group:last-child {
  margin-bottom: 0;
}

.vb-template-inline-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  min-width: 0;
  color: var(--text-secondary);
  cursor: pointer;
}

.vb-template-inline-check input[type='checkbox'],
.vb-template-inline-check input[type='radio'] {
  flex: 0 0 auto;
  width: auto;
  height: auto;
  margin: 0;
  padding: 0;
  accent-color: var(--brand-secondary);
}

.vb-template-inline-check input:focus-visible {
  outline: 2px solid var(--status-info);
  outline-offset: 2px;
}

.vb-template-enabled {
  font-weight: bold;
}

.vb-template-preview-region {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: var(--bg-surface-alt);
}

.vb-template-preview-label {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-surface-muted);
  color: var(--text-primary);
  font-weight: bold;
}

.vb-template-body-preview {
  min-height: 48px;
  max-height: 180px;
  overflow: auto;
  padding: 10px;
  color: var(--text-primary);
}

.vb-template-conflict,
.vb-success-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  padding: 9px 10px;
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 11px;
}

.vb-template-conflict {
  border: 1px solid var(--status-warning);
  background: var(--status-warning-bg);
}

.vb-success-banner {
  border: 1px solid var(--status-success);
  background: var(--status-success-bg);
}

@media (max-width: 760px) {
  .vb-template-manager-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 600px) {
  .vb-template-list,
  .vb-template-form {
    padding: 10px;
  }

  .vb-template-list-header,
  .vb-template-row {
    align-items: flex-start;
  }

  .vb-template-row-actions {
    width: 100%;
  }

  .vb-template-row-actions .vb-small-btn {
    flex: 1 1 auto;
  }

  .vb-template-choice-group {
    flex-direction: column;
  }
}
</style>
