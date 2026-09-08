<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import type { CloneOperationDto } from '../lib/apiClient';

const props = defineProps<{
  title: string;
  submitting: boolean;
  operationStatus: CloneOperationDto['status'] | null;
  error: string;
  canSubmit: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [];
  'update:title': [value: string];
}>();

const modalRef = ref<HTMLElement | null>(null);
let focusOrigin: HTMLElement | null = null;
let previousBodyOverflow = '';

function close(): void {
  if (!props.submitting) emit('close');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.submitting) {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    modalRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]') ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    modalRef.value?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
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
  void nextTick(() => {
    const title = modalRef.value?.querySelector<HTMLInputElement>('#duplicate-title');
    title?.focus();
    title?.select();
  });
});

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow;
  focusOrigin?.focus();
});
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
  <div class="vb-modal-overlay vb-duplicate-modal-overlay" tabindex="-1" @click.self="close">
    <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
    <div
      ref="modalRef"
      class="vb-modal vb-duplicate-modal"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="duplicate-modal-title"
      aria-describedby="duplicate-modal-description"
      @keydown.stop="handleKeydown"
    >
      <div class="vb-modal-header">
        <span id="duplicate-modal-title">Duplicate Thread</span>
        <button
          class="vb-modal-close"
          type="button"
          aria-label="Close duplicate thread dialog"
          :disabled="submitting"
          @click="close"
        >
          &times;
        </button>
      </div>
      <div class="vb-modal-body">
        <p id="duplicate-modal-description">
          Copy the exact current conversation into a new idle thread. No message will be sent.
        </p>
        <div class="vb-modal-field">
          <label for="duplicate-title">New thread title</label>
          <input
            id="duplicate-title"
            :value="title"
            class="vb-modal-input"
            type="text"
            maxlength="300"
            :disabled="submitting"
            @input="emit('update:title', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <p v-if="error" class="vb-error" role="alert">{{ error }}</p>
      </div>
      <div class="vb-modal-actions vb-duplicate-modal-actions">
        <button class="vb-btn" type="button" :disabled="!canSubmit" @click="emit('submit')">
          {{
            submitting || operationStatus === 'pending' || operationStatus === 'running' ? 'Duplicating…' : 'Duplicate'
          }}
        </button>
        <button class="vb-btn vb-btn-secondary" type="button" :disabled="submitting" @click="close">Cancel</button>
      </div>
    </div>
  </div>
</template>
