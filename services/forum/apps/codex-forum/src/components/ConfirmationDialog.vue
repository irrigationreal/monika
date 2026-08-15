<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    pending?: boolean;
    pendingLabel?: string;
    restoreFocus?: boolean;
  }>(),
  {
    cancelLabel: 'Cancel',
    pending: false,
    pendingLabel: 'Working…',
    restoreFocus: true,
  }
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const dialogRef = ref<HTMLElement | null>(null);
const cancelRef = ref<HTMLButtonElement | null>(null);
const dialogId = useId();
const titleId = `${dialogId}-title`;
const descriptionId = `${dialogId}-description`;
let focusOrigin: HTMLElement | null = null;
let bodyOverflowBeforeOpen = '';

function restoreEnvironment(): void {
  document.body.style.overflow = bodyOverflowBeforeOpen;
  const target = focusOrigin;
  const shouldRestoreFocus = props.restoreFocus;
  focusOrigin = null;
  if (shouldRestoreFocus) void nextTick(() => target?.focus());
}

function cancel(): void {
  if (props.pending) return;
  emit('cancel');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.pending) {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    dialogRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])') ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialogRef.value?.focus();
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
  () => props.open,
  (open, wasOpen) => {
    if (open) {
      focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      bodyOverflowBeforeOpen = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      void nextTick(() => cancelRef.value?.focus());
    } else if (wasOpen) {
      restoreEnvironment();
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (props.open) restoreEnvironment();
});
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
  <div
    v-if="open"
    class="vb-modal-overlay vb-confirmation-modal-overlay"
    tabindex="-1"
    @click.self="cancel"
    @keydown.esc="cancel"
  >
    <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
    <div
      ref="dialogRef"
      class="vb-modal vb-confirmation-modal"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      @keydown.stop="handleKeydown"
    >
      <div class="vb-modal-header">
        <span :id="titleId">{{ title }}</span>
        <button class="vb-modal-close" type="button" :aria-label="`Close ${title}`" :disabled="pending" @click="cancel">
          &times;
        </button>
      </div>
      <div class="vb-modal-body">
        <p :id="descriptionId" class="vb-delete-warning">{{ message }}</p>
      </div>
      <div class="vb-modal-actions vb-confirmation-modal-actions">
        <button class="vb-btn vb-btn-danger" type="button" :disabled="pending" @click="emit('confirm')">
          {{ pending ? pendingLabel : confirmLabel }}
        </button>
        <button ref="cancelRef" class="vb-btn vb-btn-secondary" type="button" :disabled="pending" @click="cancel">
          {{ cancelLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
