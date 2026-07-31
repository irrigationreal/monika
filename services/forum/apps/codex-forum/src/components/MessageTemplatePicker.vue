<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useMarkdown } from '../composables/useMarkdown';
import { api } from '../lib/apiClient';

import type { MessageTemplateDto } from '../lib/apiClient';

const props = defineProps<{
  context: 'reply' | 'new_thread';
  forumId: string | null;
  hasDraft: boolean;
}>();
const emit = defineEmits<{ apply: [template: MessageTemplateDto, replace: boolean] }>();
const { renderContent } = useMarkdown();

const templates = ref<MessageTemplateDto[]>([]);
const loading = ref(false);
const error = ref('');
const query = ref('');
const selectedId = ref('');
let loadGeneration = 0;

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return templates.value;
  return templates.value.filter((item) =>
    `${item.name} ${item.category ?? ''} ${item.body}`.toLowerCase().includes(needle)
  );
});
const selected = computed(() => filtered.value.find((item) => item.id === selectedId.value) ?? null);
const previewHtml = computed(() => renderContent(selected.value?.body ?? '', { topicId: null }));

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  if (!props.forumId) {
    templates.value = [];
    selectedId.value = '';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  templates.value = [];
  selectedId.value = '';
  try {
    const response = await api.listEffectiveMessageTemplates(props.context, props.forumId);
    if (generation !== loadGeneration) return;
    templates.value = response.templates;
    if (!templates.value.some((item) => item.id === selectedId.value)) selectedId.value = '';
  } catch (err) {
    if (generation !== loadGeneration) return;
    templates.value = [];
    selectedId.value = '';
    error.value = err instanceof Error ? err.message : 'Failed to load message templates.';
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function apply(replace = false): void {
  if (loading.value || !selected.value) return;
  if (replace && props.hasDraft && !window.confirm('Replace the current draft with this message template?')) return;
  emit('apply', selected.value, replace);
}

async function copyToPersonal(): Promise<void> {
  if (loading.value) return;
  const template = selected.value;
  if (template?.scope !== 'system') return;
  try {
    const copy = await api.createMessageTemplate({
      name: `${template.name} (copy)`,
      category: template.category,
      body: template.body,
      threadTitle: template.threadTitle,
      forumScope: template.forumScope,
      forumIds: template.forumScope === 'selected' && props.forumId ? [props.forumId] : [],
      contexts: template.contexts,
      enabled: true,
    });
    await load();
    selectedId.value = copy.id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to copy template.';
  }
}

watch(filtered, (items) => {
  if (!items.some((item) => item.id === selectedId.value)) selectedId.value = '';
});

watch(
  () => [props.context, props.forumId] as const,
  () => void load(),
  { immediate: true }
);
</script>

<template>
  <div class="vb-message-template-picker" data-testid="message-template-picker">
    <label class="vb-template-label" :for="`message-template-${context}`">Message Template:</label>
    <input
      v-model="query"
      type="search"
      class="vb-template-search"
      placeholder="Search templates"
      aria-label="Search message templates"
      data-testid="message-template-search"
    />
    <select
      :id="`message-template-${context}`"
      v-model="selectedId"
      :disabled="loading || !filtered.length"
      data-testid="message-template-select"
    >
      <option value="">{{ loading ? 'Loading…' : 'Choose a template…' }}</option>
      <optgroup
        v-for="category in [...new Set(filtered.map((item) => item.category || 'Uncategorized'))]"
        :key="category"
        :label="category"
      >
        <option
          v-for="template in filtered.filter((item) => (item.category || 'Uncategorized') === category)"
          :key="template.id"
          :value="template.id"
        >
          {{ template.name }} · {{ template.scope === 'personal' ? 'Personal' : 'System' }}
        </option>
      </optgroup>
    </select>
    <button
      type="button"
      class="vb-small-btn"
      :disabled="loading || !selected"
      data-testid="message-template-insert"
      @click="apply(false)"
    >
      Insert
    </button>
    <button
      v-if="hasDraft"
      type="button"
      class="vb-small-btn vb-btn-secondary"
      :disabled="loading || !selected"
      data-testid="message-template-replace"
      @click="apply(true)"
    >
      Replace draft
    </button>
    <router-link class="vb-template-manage" :to="{ name: 'user.messageTemplates' }">Manage</router-link>
    <div v-if="error" class="vb-form-error" role="alert">{{ error }}</div>
    <div v-if="selected" class="vb-template-preview" data-testid="message-template-preview">
      <div>
        <strong>{{ selected.name }}</strong> <span>{{ selected.scope === 'personal' ? 'Personal' : 'System' }}</span>
      </div>
      <div v-if="selected.threadTitle"><strong>Thread title:</strong> {{ selected.threadTitle }}</div>
      <div class="vb-rendered-content vb-template-preview-body" v-html="previewHtml"></div>
      <button
        v-if="selected.scope === 'system'"
        type="button"
        class="vb-small-btn vb-btn-secondary"
        :disabled="loading"
        @click="copyToPersonal"
      >
        Copy to my templates
      </button>
    </div>
  </div>
</template>

<style scoped>
.vb-message-template-picker {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.vb-template-search {
  min-width: 150px;
}
.vb-message-template-picker select {
  min-width: 220px;
}
.vb-template-manage {
  font-size: 12px;
}
.vb-template-preview {
  flex-basis: 100%;
  border: 1px solid var(--vb-border, #aaa);
  padding: 8px;
}
.vb-template-preview-body {
  max-height: 180px;
  overflow: auto;
  margin: 6px 0;
}
</style>
