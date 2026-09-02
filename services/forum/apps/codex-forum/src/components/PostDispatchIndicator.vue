<script setup lang="ts">
import { computed, ref } from 'vue';

import type { TopicPostDispatchProjectionDto } from '../lib/apiClient';

const props = withDefaults(
  defineProps<{
    postId: string;
    projection: TopicPostDispatchProjectionDto;
    retrying?: boolean;
    retryError?: string;
  }>(),
  { retrying: false, retryError: '' }
);
const emit = defineEmits<{ retry: [postId: string] }>();
const expanded = ref(false);
const current = computed(() => props.projection.current.find((item) => item.postId === props.postId) ?? null);
const attempts = computed(() => {
  const dispatchId = current.value?.dispatchId ?? props.projection.attempts.find((item) => item.dispatchId)?.dispatchId;
  return dispatchId ? props.projection.attempts.filter((item) => item.dispatchId === dispatchId) : [];
});
const label = computed(() => (current.value?.status === 'failed' ? 'Dispatch failed' : 'Dispatch delayed'));
function when(value: string): string {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <aside v-if="current" class="vb-dispatch-indicator" role="status" :data-post-id="postId">
    <div>
      <strong>{{ label }}</strong>
      <span> · attempt {{ current.attemptCount }}</span>
      <span v-if="current.nextAttemptAt"> · retry {{ when(current.nextAttemptAt) }}</span>
    </div>
    <button
      v-if="current.status === 'failed'"
      class="vb-small-btn"
      type="button"
      :disabled="retrying"
      @click="emit('retry', postId)"
    >
      {{ retrying ? 'Retrying…' : 'Retry' }}
    </button>
    <button class="vb-small-btn" type="button" @click="expanded = !expanded">
      {{ expanded ? 'Hide history' : 'Attempt history' }}
    </button>
    <p v-if="retryError" class="vb-dispatch-error" role="alert">{{ retryError }}</p>
    <ol v-if="expanded" class="vb-dispatch-attempts">
      <li v-for="attempt in attempts" :key="attempt.id">
        {{ when(attempt.createdAt) }} · {{ attempt.event.replaceAll('_', ' ') }}
        <span v-if="attempt.classification"> ({{ attempt.classification }})</span>
        <span v-if="attempt.retryAt"> · retry {{ when(attempt.retryAt) }}</span>
        <span v-if="attempt.errorMessage"> · {{ attempt.errorMessage }}</span>
      </li>
    </ol>
  </aside>
</template>

<style scoped>
.vb-dispatch-indicator {
  margin: 0 12px 12px;
  padding: 10px 12px;
  border: 1px solid #b87800;
  background: #fff5d6;
  color: #5e3b00;
}
.vb-dispatch-indicator > div {
  display: inline;
  margin-right: 10px;
}
.vb-dispatch-error {
  margin: 8px 0 0;
  color: #8b1a1a;
}
.vb-dispatch-attempts {
  margin: 8px 0 0;
  padding-left: 22px;
}
</style>
