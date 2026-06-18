<template>
  <div class="vb-live-turn vb-post vb-post--draft">
    <div class="vb-post-header vb-live-turn-header">
      <div>● Monika is responding</div>
      <div class="vb-post-draft-pill">LIVE</div>
    </div>

    <div class="vb-live-turn-body">
      <aside class="vb-post-user vb-live-turn-user">
        <div class="vb-user-name">Monika</div>
        <div class="vb-user-title">Live Trace</div>
        <img class="vb-avatar" src="/avatars/monika.png" alt="" />
        <div class="vb-user-meta">
          <div><span>Status:</span> {{ activityLabel }}</div>
          <div v-if="model"><span>Model:</span> {{ model }}</div>
          <div v-if="reasoning"><span>Reasoning:</span> {{ reasoning }}</div>
        </div>
      </aside>

      <div class="vb-post-content vb-live-turn-content">
        <div class="vb-post-heading vb-live-turn-heading">
          <span>Trace</span>
          <span v-if="active" class="vb-spinner vb-spinner-dark"></span>
        </div>

        <div class="vb-live-turn-stream" aria-live="polite">
          <section
            v-for="item in items"
            :key="item.id"
            class="vb-live-turn-item"
            :class="[`vb-live-turn-item--${item.type}`, `vb-live-turn-item--${item.status}`]"
          >
            <div v-if="item.type !== 'assistant_text'" class="vb-live-turn-item-head">
              <span class="vb-live-turn-dot" :class="dotClass(item.status)">{{ dotFor(item.status) }}</span>
              <span class="vb-live-turn-title">{{ item.title }}</span>
              <span v-if="item.meta" class="vb-live-turn-meta">{{ item.meta }}</span>
            </div>

            <div
              v-if="item.type === 'assistant_text'"
              class="vb-live-turn-assistant vb-rendered-content"
              v-html="renderMarkdown(item.text ?? '')"
            ></div>
            <div
              v-else-if="item.markdown"
              class="vb-live-turn-detail vb-rendered-content"
              v-html="renderMarkdown(item.markdown)"
            ></div>
            <pre v-else-if="item.detail" class="vb-live-turn-detail vb-live-turn-detail--pre">{{ item.detail }}</pre>
          </section>

          <section v-if="items.length === 0" class="vb-live-turn-item vb-live-turn-item--status vb-live-turn-item--running">
            <div class="vb-live-turn-item-head">
              <span class="vb-live-turn-dot vb-live-turn-dot--running">◉</span>
              <span class="vb-live-turn-title">Starting turn…</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useMarkdown } from '../composables/useMarkdown';

export type LiveTurnItem = {
  id: string;
  type: 'status' | 'reasoning' | 'tool' | 'assistant_text' | 'error';
  title: string;
  status: 'running' | 'success' | 'error' | 'done';
  meta?: string | null;
  detail?: string | null;
  markdown?: string | null;
  text?: string | null;
};

const props = defineProps<{
  items: LiveTurnItem[];
  activity?: string | null;
  model?: string | null;
  reasoning?: string | null;
  active?: boolean;
  topicId?: string | null;
}>();

const { renderContent } = useMarkdown();

const activityLabel = computed(() => {
  switch (props.activity) {
    case 'thinking': return 'thinking';
    case 'running_tools': return 'running tools';
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    case 'idle': return 'finishing';
    default: return props.activity ?? 'responding';
  }
});

function renderMarkdown(text: string): string {
  return renderContent(text, { topicId: props.topicId });
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
