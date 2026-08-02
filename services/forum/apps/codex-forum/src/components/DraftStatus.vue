<script setup lang="ts">
import { computed } from 'vue';

import type { DraftSaveStatus } from '../composables/useAutosavedDraft';

const props = defineProps<{ status: DraftSaveStatus; expiresAt: string | null; conflict: boolean }>();
const emit = defineEmits<{ discard: []; retry: []; useSaved: []; keepMine: []; copyMine: [] }>();
const expiry = computed(() =>
  props.expiresAt ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(props.expiresAt)) : ''
);
const text = computed(
  () =>
    ({
      idle: 'Draft not saved',
      saving: 'Saving draft…',
      saved: `Draft saved · expires ${expiry.value}`,
      offline: 'Offline — changes remain in this tab',
      failed: 'Draft could not be saved',
      conflict: 'Draft changed in another tab or device',
      auth: 'Sign in again to save this draft',
      too_large: 'Draft is too large to save',
    })[props.status]
);
</script>
<template>
  <div class="vb-draft-status" :class="`is-${status}`" role="status" aria-live="polite">
    <span>{{ text }}</span>
    <button
      v-if="status === 'failed' || status === 'offline'"
      type="button"
      class="vb-small-btn"
      @click="emit('retry')"
    >
      Retry
    </button>
    <template v-if="status === 'conflict'">
      <button v-if="conflict" type="button" class="vb-small-btn" @click="emit('useSaved')">Use saved version</button>
      <button type="button" class="vb-small-btn" @click="emit('keepMine')">Keep my version</button>
      <button type="button" class="vb-small-btn" @click="emit('copyMine')">Copy my text</button>
    </template>
    <button v-if="expiresAt" type="button" class="vb-small-btn vb-btn-danger" @click="emit('discard')">
      Discard draft
    </button>
  </div>
</template>
<style scoped>
.vb-draft-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0;
  color: var(--text-muted);
  font-size: 12px;
}
.vb-draft-status.is-conflict,
.vb-draft-status.is-failed,
.vb-draft-status.is-offline {
  color: var(--status-warning);
}
</style>
