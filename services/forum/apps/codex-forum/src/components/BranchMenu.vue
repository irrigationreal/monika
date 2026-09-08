<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue';

const props = defineProps<{
  duplicateDisabled?: boolean;
  forkDisabled?: boolean;
}>();

const emit = defineEmits<{
  duplicate: [];
  fork: [];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const menuId = `branch-menu-${useId()}`;

function menuItems(): HTMLButtonElement[] {
  return Array.from(rootRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
}

function closeMenu({ restoreFocus = false } = {}): void {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) {
    void nextTick(() =>
      window.setTimeout(() => rootRef.value?.querySelector<HTMLButtonElement>('.vb-branch-trigger')?.focus(), 0)
    );
  }
}

function openMenu(focus: 'first' | 'last' | null = null): void {
  open.value = true;
  if (focus) void nextTick(() => (focus === 'first' ? menuItems().at(0) : menuItems().at(-1))?.focus());
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function choose(kind: 'duplicate' | 'fork'): void {
  closeMenu();
  if (kind === 'duplicate') emit('duplicate');
  else emit('fork');
}

function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openMenu('first');
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu('last');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function handleMenuKeydown(event: KeyboardEvent): void {
  const items = menuItems();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    (event.key === 'Home' ? items.at(0) : items.at(-1))?.focus();
  } else if (event.key === 'Tab') {
    closeMenu();
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (!rootRef.value?.contains(event.target as Node)) closeMenu();
}

function handleFocusIn(event: FocusEvent): void {
  if (open.value && !rootRef.value?.contains(event.target as Node)) closeMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('focusin', handleFocusIn);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', handlePointerDown);
  document.removeEventListener('focusin', handleFocusIn);
});
</script>

<template>
  <div ref="rootRef" class="vb-branch-menu">
    <button
      class="vb-btn vb-branch-trigger"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      Branch <span aria-hidden="true">▾</span>
    </button>
    <div v-if="open" :id="menuId" class="vb-branch-menu-popover" role="menu" @keydown="handleMenuKeydown">
      <button role="menuitem" type="button" :disabled="props.duplicateDisabled" @click="choose('duplicate')">
        Duplicate current thread
      </button>
      <button role="menuitem" type="button" :disabled="props.forkDisabled" @click="choose('fork')">
        Fork from an earlier message
      </button>
    </div>
  </div>
</template>

<style scoped>
.vb-branch-menu {
  position: relative;
  display: inline-flex;
}

.vb-branch-menu-popover {
  position: absolute;
  z-index: 40;
  top: calc(100% + 0.3rem);
  left: 0;
  display: grid;
  min-width: min(18rem, calc(100vw - 2rem));
  padding: 0.3rem;
  border: 1px solid var(--border-color, #777);
  border-radius: 0.35rem;
  background: var(--panel-bg, #fff);
  box-shadow: 0 0.4rem 1rem rgb(0 0 0 / 18%);
}

.vb-branch-menu-popover button {
  padding: 0.55rem 0.7rem;
  border: 0;
  border-radius: 0.25rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.vb-branch-menu-popover button:focus-visible,
.vb-branch-menu-popover button:hover:not(:disabled) {
  background: rgb(127 127 127 / 18%);
  outline: none;
}

.vb-branch-menu-popover button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 600px) {
  .vb-branch-menu,
  .vb-branch-trigger {
    width: 100%;
  }

  .vb-branch-menu-popover {
    right: 0;
    left: auto;
    width: min(22rem, calc(100vw - 2rem));
  }
}
</style>
