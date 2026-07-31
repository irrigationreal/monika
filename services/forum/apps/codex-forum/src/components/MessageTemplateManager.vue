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
    <p>Templates insert literal text into a draft. They never submit a post or change robot options.</p>
    <div v-if="error" class="vb-login-error" role="alert">
      {{ error }}
      <button type="button" class="vb-small-btn" @click="load">Reload templates</button>
    </div>
    <div v-if="revisionConflict" class="vb-template-conflict" role="alert">
      Your draft is preserved. Reload the latest version or save this draft as a copy.
      <button type="button" class="vb-small-btn" @click="reloadConflict">Reload latest</button>
      <button type="button" class="vb-small-btn" @click="saveConflictCopy">Save as copy</button>
    </div>
    <div v-if="success" class="vb-success-banner" role="status" aria-live="polite">{{ success }}</div>
    <div class="vb-template-manager-grid">
      <div class="vb-template-list">
        <div class="vb-template-list-header">
          <strong>{{ system ? 'System' : 'My' }} templates ({{ templates.length }} / {{ system ? 500 : 200 }})</strong
          ><button type="button" class="vb-small-btn" @click="reset">New</button>
        </div>
        <div v-if="!templates.length" class="vb-form-hint">No message templates yet.</div>
        <div v-for="(template, index) in templates" :key="template.id" class="vb-template-row">
          <button type="button" class="vb-template-name" @click="edit(template)">{{ template.name }}</button>
          <span>{{ template.category || 'Uncategorized' }} · {{ template.enabled ? 'Enabled' : 'Disabled' }}</span>
          <div>
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
            <button type="button" class="vb-small-btn" @click="duplicate(template)">Duplicate</button
            ><button type="button" class="vb-small-btn vb-btn-danger" @click="remove(template)">Delete</button>
          </div>
        </div>
      </div>
      <div class="vb-template-form">
        <h3>{{ editing ? 'Edit' : 'Create' }} Message Template</h3>
        <label>Name <input v-model="name" maxlength="80" data-testid="message-template-name" /></label>
        <label>Category <input v-model="category" maxlength="40" list="message-template-categories" /></label>
        <datalist id="message-template-categories">
          <option
            v-for="item in [...new Set(templates.map((template) => template.category).filter(Boolean))]"
            :key="item || ''"
            :value="item || ''"
          />
        </datalist>
        <label>Body <textarea v-model="body" rows="10" data-testid="message-template-body"></textarea></label>
        <label>New-thread title (optional) <input v-model="threadTitle" maxlength="255" /></label>
        <fieldset>
          <legend>Available in</legend>
          <label><input v-model="contexts" type="checkbox" value="reply" /> Replies</label
          ><label><input v-model="contexts" type="checkbox" value="new_thread" /> New threads</label>
        </fieldset>
        <fieldset>
          <legend>Forums</legend>
          <label><input v-model="forumScope" type="radio" value="all" /> All forums</label
          ><label><input v-model="forumScope" type="radio" value="selected" /> Selected forums</label>
          <select v-if="forumScope === 'selected'" v-model="forumIds" multiple size="6">
            <option v-for="forum in forums" :key="forum.id" :value="forum.id">
              {{ forum.name }}{{ forum.status === 'archived' ? ' (archived)' : '' }}
            </option>
          </select>
        </fieldset>
        <label><input v-model="enabled" type="checkbox" /> Enabled</label>
        <div class="vb-template-body-preview vb-rendered-content" v-html="bodyPreviewHtml"></div>
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
.vb-template-manager-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(320px, 1.2fr);
  gap: 16px;
}
.vb-template-list-header,
.vb-template-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px;
  border-bottom: 1px solid var(--vb-border, #aaa);
}
.vb-template-row > span {
  flex-basis: 100%;
  font-size: 12px;
}
.vb-template-name {
  font-weight: bold;
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}
.vb-template-form {
  display: grid;
  gap: 10px;
}
.vb-template-form label {
  display: grid;
  gap: 4px;
}
.vb-template-form fieldset label {
  display: inline-flex;
  margin-right: 14px;
}
.vb-template-form select {
  width: 100%;
}
.vb-template-body-preview {
  min-height: 40px;
  max-height: 140px;
  overflow: auto;
  border: 1px solid var(--vb-border, #aaa);
  padding: 8px;
}
@media (max-width: 760px) {
  .vb-template-manager-grid {
    grid-template-columns: 1fr;
  }
}
</style>
