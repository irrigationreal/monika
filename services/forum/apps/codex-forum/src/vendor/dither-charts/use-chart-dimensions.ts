import { onBeforeUnmount, onMounted, shallowRef } from 'vue';

import type { ShallowRef } from 'vue';

export type Dimensions = { width: number; height: number };

/** ResizeObserver-based dimensions, adapted from Dither UI's Vue chart hook. */
export function useChartDimensions(): {
  element: ShallowRef<HTMLElement | null>;
  size: ShallowRef<Dimensions>;
} {
  const element = shallowRef<HTMLElement | null>(null);
  const size = shallowRef<Dimensions>({ width: 0, height: 0 });
  let observer: ResizeObserver | null = null;

  const update = (width: number, height: number) => {
    size.value = { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) };
  };

  onMounted(() => {
    const node = element.value;
    if (!node) return;
    update(node.clientWidth, node.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
  });
  onBeforeUnmount(() => observer?.disconnect());

  return { element, size };
}
