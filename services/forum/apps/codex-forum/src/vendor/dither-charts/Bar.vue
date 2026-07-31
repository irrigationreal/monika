<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';

import { useChartPart } from './chart-context';
import { cssColor } from './palette';

import type { AreaVariant, StrokeVariant } from './chart-context';

const props = withDefaults(
  defineProps<{
    dataKey: string;
    variant?: AreaVariant;
    strokeVariant?: StrokeVariant;
    opacity?: number;
  }>(),
  { variant: 'gradient', strokeVariant: 'solid', opacity: 1 }
);

const context = useChartPart('Bar', 'bar');
watch(
  () => [props.dataKey, props.variant, props.strokeVariant, props.opacity] as const,
  ([dataKey, variant, strokeVariant, opacity], previous) => {
    if (previous?.[0] && previous[0] !== dataKey) context.unregisterSeries(previous[0]);
    context.registerSeries({ dataKey, variant, strokeVariant, opacity });
  },
  { immediate: true }
);
onBeforeUnmount(() => context.unregisterSeries(props.dataKey));

const rectangles = computed(() => {
  const band = context.bands[props.dataKey];
  const seriesIndex = context.configKeys.indexOf(props.dataKey);
  if (!band || seriesIndex < 0) return [];
  return band.map((point, index) => {
    const slot = context.barSlot(index, seriesIndex, context.configKeys.length);
    const top = context.y(point[1]);
    const base = context.y(point[0]);
    return {
      x: slot.x,
      y: Math.min(top, base),
      width: slot.width,
      height: Math.abs(base - top),
    };
  });
});
const stroke = computed(() => cssColor(context.config[props.dataKey]?.color ?? 'grey'));
</script>

<template>
  <g v-if="context.ready" class="vb-dither-chart-bars" :opacity="opacity">
    <rect
      v-for="(rectangle, index) in rectangles"
      :key="index"
      class="vb-dither-chart-bar"
      v-bind="rectangle"
      :fill="`url(#${context.patternId(dataKey)})`"
      :stroke="stroke"
      :stroke-dasharray="strokeVariant === 'dashed' ? '5 4' : undefined"
    />
  </g>
</template>
