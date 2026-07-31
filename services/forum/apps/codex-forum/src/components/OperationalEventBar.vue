<script setup lang="ts">
import { computed } from 'vue';

import type { TopicOperationalEventDto } from '../lib/apiClient';

const props = defineProps<{
  event: TopicOperationalEventDto;
  canRecover?: boolean;
  recoverDisabled?: boolean;
}>();

const emit = defineEmits<{ recover: [] }>();

const rawError = computed(() => {
  const value = props.event.detail?.['error'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
});

const isContextOverflow = computed(() => {
  if (props.event.detail?.['category'] === 'context_overflow') return true;
  const text = `${props.event.summary} ${rawError.value ?? ''}`.toLowerCase();
  return /context(?: window)?[^.\n]{0,60}(?:overflow|exceed|limit|length|large)|(?:overflow|exceed|limit|length|large)[^.\n]{0,60}context(?: window)?|(?:token|prompt)[^.\n]{0,40}(?:limit|exceed|large)/i.test(
    text
  );
});

const tone = computed(() => (props.event.status === 'failed' ? 'error' : 'success'));
const label = computed(() =>
  props.event.type === 'compaction'
    ? props.event.status === 'succeeded'
      ? 'Session compacted'
      : 'Compaction failed'
    : 'Assistant response failed'
);
</script>

<template>
  <aside class="vb-operational-event" :class="`vb-operational-event--${tone}`" role="status">
    <div class="vb-operational-event-main">
      <span class="vb-operational-event-icon" aria-hidden="true">{{ tone === 'error' ? '!' : '✓' }}</span>
      <div class="vb-operational-event-copy">
        <strong>{{ label }}</strong>
        <span>{{ event.summary }}</span>
      </div>
      <button
        v-if="event.type === 'turn_error' && isContextOverflow && canRecover"
        class="vb-small-btn"
        type="button"
        :disabled="recoverDisabled"
        @click="emit('recover')"
      >
        Compact and recover
      </button>
    </div>
    <details v-if="rawError" class="vb-operational-event-detail">
      <summary>Raw error detail</summary>
      <pre>{{ rawError }}</pre>
    </details>
  </aside>
</template>

<style scoped>
.vb-operational-event {
  border: 1px solid var(--border-default);
  border-left-width: 4px;
  color: var(--text-primary);
  padding: 9px 12px;
  font-size: 0.86rem;
}
.vb-operational-event--error {
  border-left-color: var(--status-error);
  background: var(--status-error-bg);
}
.vb-operational-event--success {
  border-left-color: var(--status-success);
  background: var(--status-success-bg);
}
.vb-operational-event-main {
  display: flex;
  align-items: center;
  gap: 9px;
}
.vb-operational-event-icon {
  flex: 0 0 auto;
  font-weight: 800;
}
.vb-operational-event--error .vb-operational-event-icon {
  color: var(--status-error);
}
.vb-operational-event--success .vb-operational-event-icon {
  color: var(--status-success);
}
.vb-operational-event-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 7px;
  flex-wrap: wrap;
  color: var(--text-secondary);
}
.vb-operational-event-copy strong {
  color: var(--text-primary);
}
.vb-operational-event-detail {
  margin: 7px 0 0 24px;
  color: var(--text-secondary);
}
.vb-operational-event-detail summary {
  cursor: pointer;
  font-weight: 600;
}
.vb-operational-event-detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 7px 0 0;
  padding: 7px 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.78rem;
}
@media (max-width: 640px) {
  .vb-operational-event {
    padding: 8px 10px;
  }
  .vb-operational-event-main {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .vb-operational-event-copy {
    flex-basis: calc(100% - 30px);
  }
  .vb-operational-event-main button {
    margin-left: 24px;
  }
}
</style>
