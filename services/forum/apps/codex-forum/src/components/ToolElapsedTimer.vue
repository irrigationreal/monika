<template>
  <span v-if="label" class="vb-live-turn-elapsed">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{
  /** ISO timestamp when the tool started */
  startedAt: string;
  /** Configured timeout in milliseconds (from tool input) */
  timeoutMs: number;
  /** Whether the tool has finished (stop ticking) */
  finished?: boolean;
}>();

const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (!props.finished) {
    timer = setInterval(() => { tick.value += 1; }, 1000);
  }
});

onUnmounted(() => {
  if (timer) { clearInterval(timer); timer = null; }
});

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

const label = computed(() => {
  void tick.value; // reactive dependency for ticking
  const started = new Date(props.startedAt).getTime();
  if (!Number.isFinite(started)) return `timeout ${fmt(props.timeoutMs)}`;
  if (props.finished) return `timeout ${fmt(props.timeoutMs)}`;
  const elapsed = Math.max(0, Date.now() - started);
  // Quantize to whole seconds for clean display
  const elapsedSec = Math.floor(elapsed / 1000) * 1000;
  return `${fmt(elapsedSec)} / ${fmt(props.timeoutMs)}`;
});
</script>
