<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import type { ForkBoundaryDto, ForkOperationDto } from '../lib/apiClient';

const props = defineProps<{
  boundaries: ForkBoundaryDto[];
  boundaryPostId: string;
  title: string;
  openingBody: string;
  loading: boolean;
  submitting: boolean;
  operationStatus: ForkOperationDto['status'] | null;
  error: string;
  canSubmit: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [];
  boundaryChange: [];
  'update:boundaryPostId': [value: string];
  'update:title': [value: string];
  'update:openingBody': [value: string];
}>();

const modalRef = ref<HTMLElement | null>(null);
let focusOrigin: HTMLElement | null = null;
let previousBodyOverflow = '';

function close(): void {
  if (!props.submitting) emit('close');
}

function changeBoundary(event: Event): void {
  emit('update:boundaryPostId', (event.target as HTMLSelectElement).value);
  emit('boundaryChange');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.submitting) {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    modalRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    modalRef.value?.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.submitting,
  (submitting) => {
    if (submitting) modalRef.value?.focus();
  },
  { flush: 'post' }
);

onMounted(() => {
  focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  void nextTick(() => modalRef.value?.querySelector<HTMLElement>('.vb-modal-close')?.focus());
});

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow;
  focusOrigin?.focus();
});
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
  <div class="vb-modal-overlay vb-fork-modal-overlay" tabindex="-1" @click.self="close" @keydown.esc="close">
    <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
    <div
      ref="modalRef"
      class="vb-modal vb-fork-modal"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="fork-modal-title"
      aria-describedby="fork-modal-description"
      @keydown.stop="handleKeydown"
    >
      <div class="vb-modal-header">
        <span id="fork-modal-title">Fork Topic</span>
        <button
          class="vb-modal-close"
          type="button"
          aria-label="Close fork dialog"
          :disabled="submitting"
          @click="close"
        >
          &times;
        </button>
      </div>
      <div class="vb-modal-body">
        <p id="fork-modal-description">
          Create a new canonical conversation inheriting history before a completed user message.
        </p>
        <div class="vb-modal-field">
          <label for="fork-boundary">Fork boundary</label>
          <select
            id="fork-boundary"
            :value="boundaryPostId"
            class="vb-modal-select"
            :disabled="loading || submitting || boundaries.length === 0"
            @change="changeBoundary"
          >
            <option v-if="loading" value="">Refreshing canonical boundaries…</option>
            <option v-else-if="boundaries.length === 0" value="">No eligible boundary</option>
            <option v-for="boundary in boundaries" :key="boundary.postId" :value="boundary.postId">
              #{{ boundary.postNumber }} — {{ boundary.excerpt }}
            </option>
          </select>
        </div>
        <div class="vb-modal-field">
          <label for="fork-title">New topic title</label>
          <input
            id="fork-title"
            :value="title"
            class="vb-modal-input"
            type="text"
            maxlength="300"
            :disabled="loading || submitting || boundaries.length === 0"
            @input="emit('update:title', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="vb-modal-field">
          <label for="fork-opening">Edited opening message</label>
          <textarea
            id="fork-opening"
            :value="openingBody"
            class="vb-modal-textarea"
            rows="10"
            maxlength="100000"
            :disabled="loading || submitting || boundaries.length === 0"
            @input="emit('update:openingBody', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>
        <div v-if="loading" class="vb-note" role="status" aria-live="polite">Refreshing canonical fork boundaries…</div>
        <p v-if="error" class="vb-error" role="alert">{{ error }}</p>
      </div>
      <div class="vb-modal-actions vb-fork-modal-actions">
        <button class="vb-btn" type="button" :disabled="!canSubmit" @click="emit('submit')">
          {{
            submitting || operationStatus === 'pending' || operationStatus === 'running' ? 'Forking…' : 'Create fork'
          }}
        </button>
        <button class="vb-btn vb-btn-secondary" type="button" :disabled="submitting" @click="close">Cancel</button>
      </div>
    </div>
  </div>
</template>
