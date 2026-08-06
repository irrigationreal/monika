<template>
  <section class="vb-live-turn-item" :class="[`vb-live-turn-item--${item.type}`, `vb-live-turn-item--${item.status}`]">
    <span class="vb-live-turn-dot" :class="dotClass(item.status)">{{ dotFor(item.status) }}</span>
    <div class="vb-live-turn-card">
      <div v-if="item.type !== 'assistant_text'" class="vb-live-turn-item-head">
        <span class="vb-live-turn-title">{{ item.title }}</span>
        <span v-if="item.meta" class="vb-live-turn-meta">{{ item.meta }}</span>
        <span
          v-if="item.type === 'tool' && item.status === 'running'"
          class="vb-spinner vb-spinner-dark vb-live-turn-spinner"
        ></span>
        <ToolElapsedTimer
          v-if="item.startedAt && item.timeoutMs"
          :startedAt="item.startedAt"
          :timeoutMs="item.timeoutMs"
          :finished="item.finished"
        />
        <button v-if="hasDetails(item)" class="vb-live-turn-toggle" type="button" @click="$emit('toggle', item.id)">
          {{ expanded ? 'Hide' : 'Details' }}
        </button>
      </div>

      <div
        v-if="item.type === 'assistant_text'"
        v-enhance-mermaid
        class="vb-live-turn-assistant vb-rendered-content"
        v-html="renderMarkdown(item.text ?? '')"
      ></div>
      <div
        v-else-if="item.markdown && (item.type === 'reasoning' || expanded)"
        class="vb-live-turn-detail vb-rendered-content"
        v-html="renderMarkdown(item.markdown)"
      ></div>
      <pre
        v-else-if="item.detail && (item.type === 'error' || expanded)"
        class="vb-live-turn-detail vb-live-turn-detail--pre"
        >{{ item.detail }}</pre
      >
    </div>
  </section>
</template>

<script setup lang="ts">
import { useMarkdown } from '../composables/useMarkdown';
import ToolElapsedTimer from './ToolElapsedTimer.vue';

export type LiveTurnItem = {
  id: string;
  type: 'status' | 'reasoning' | 'tool' | 'assistant_text' | 'error';
  title: string;
  status: 'running' | 'success' | 'error' | 'done';
  meta?: string | null;
  detail?: string | null;
  markdown?: string | null;
  text?: string | null;
  startedAt?: string | null;
  timeoutMs?: number | null;
  finished?: boolean;
};

const props = defineProps<{
  item: LiveTurnItem;
  expanded: boolean;
  topicId?: string | null;
}>();

defineEmits<{
  toggle: [id: string];
}>();

const { renderContent } = useMarkdown();

function renderMarkdown(text: string): string {
  return renderContent(text, { topicId: props.topicId });
}

function hasDetails(item: LiveTurnItem): boolean {
  if (item.type === 'reasoning') return Boolean(item.markdown || item.detail);
  if (item.type === 'error') return false;
  return Boolean(item.markdown || item.detail);
}

function dotFor(status: LiveTurnItem['status']): string {
  if (status === 'running') return '◉';
  if (status === 'error') return '⛔';
  return '✓';
}

function dotClass(status: LiveTurnItem['status']): string {
  if (status === 'running') return 'vb-live-turn-dot--running';
  if (status === 'error') return 'vb-live-turn-dot--error';
  return 'vb-live-turn-dot--success';
}
</script>
