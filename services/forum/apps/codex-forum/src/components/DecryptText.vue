<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';

const props = withDefaults(
  defineProps<{
    text: string;
    mode?: 'replace' | 'append';
  }>(),
  { mode: 'replace' }
);

const SCRAMBLE_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン日月火水木金土天地人中大小上下左右前後東西南北春夏秋冬風雨雷雲';
const TOTAL_DURATION = 3000;
const INITIAL_INTERVAL = 80;
const FINAL_INTERVAL = 15;

function getScrambleInterval(progress: number): number {
  const range = INITIAL_INTERVAL - FINAL_INTERVAL;
  return FINAL_INTERVAL + range * Math.exp(-4 * progress);
}

type DisplayChar = { char: string; settled: boolean };
const displayChars = ref<DisplayChar[]>([]);
let animationFrame: number | null = null;

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

function startReplaceAnimation(text: string) {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  const numChars = text.length;
  if (!numChars) {
    displayChars.value = [];
    return;
  }

  const scrambleDuration = clamp(300, 1200, 3000 / Math.sqrt(numChars));
  const staggerDelay = (TOTAL_DURATION - scrambleDuration) / Math.max(1, numChars - 1);
  const startTime = performance.now();
  let lastUpdate = 0;

  function tick() {
    const now = performance.now();
    const elapsed = now - startTime;

    // Exponential acceleration: starts slow, speeds up
    const progress = Math.min(1, elapsed / TOTAL_DURATION);
    const currentInterval = getScrambleInterval(progress);

    if (now - lastUpdate < currentInterval) {
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    lastUpdate = now;

    const chars: DisplayChar[] = [];
    let allSettled = true;

    for (let i = 0; i < numChars; i++) {
      const charStart = i * staggerDelay;
      const charEnd = charStart + scrambleDuration;

      if (elapsed < charStart) {
        allSettled = false;
      } else if (elapsed < charEnd) {
        chars.push({ char: SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]!, settled: false });
        allSettled = false;
      } else {
        chars.push({ char: text[i]!, settled: true });
      }
    }

    displayChars.value = chars;

    if (!allSettled) {
      animationFrame = requestAnimationFrame(tick);
    } else {
      animationFrame = null;
    }
  }

  tick();
}

function handleAppendMode(newText: string) {
  // Append mode: just show text directly, no animation
  // The decrypt effect only happens on initial load (replace mode)
  const text = newText ?? '';
  displayChars.value = text.split('').map(c => ({ char: c, settled: true }));
}

watch(
  () => props.text,
  (newText) => {
    if (props.mode === 'append') {
      handleAppendMode(newText ?? '');
    } else {
      startReplaceAnimation(newText ?? '');
    }
  },
  { immediate: true }
);

watch(
  () => props.mode,
  () => {
    // Cancel any running animation when mode changes
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }
);

onUnmounted(() => {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
  }
});
</script>

<template>
  <span class="decrypt-text"><span
    v-for="(dc, i) in displayChars"
    :key="i"
    :class="{ 'decrypt-char--scrambling': !dc.settled }"
  >{{ dc.char }}</span></span>
</template>

<style scoped>
.decrypt-char--scrambling {
  opacity: 0.5;
}
</style>
