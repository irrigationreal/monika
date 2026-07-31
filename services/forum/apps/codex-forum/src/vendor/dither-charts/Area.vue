<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';

import { curveMonotoneX, area as d3Area } from 'd3-shape';

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

const context = useChartPart('Area', 'area');

watch(
  () => [props.dataKey, props.variant, props.strokeVariant, props.opacity] as const,
  ([dataKey, variant, strokeVariant, opacity], previous) => {
    if (previous?.[0] !== dataKey) context.unregisterSeries(previous?.[0] ?? '');
    context.registerSeries({ dataKey, variant, strokeVariant, opacity });
  },
  { immediate: true }
);
onBeforeUnmount(() => context.unregisterSeries(props.dataKey));

const path = computed(() => {
  const band = context.bands[props.dataKey];
  if (!band?.length) return null;
  return d3Area<[number, number]>()
    .x((_, index) => context.xCenter(index))
    .y0((point) => context.y(point[0]))
    .y1((point) => context.y(point[1]))
    .curve(curveMonotoneX)(band);
});
const stroke = computed(() => cssColor(context.config[props.dataKey]?.color ?? 'grey'));
</script>

<template>
  <path
    v-if="context.ready && path"
    class="vb-dither-chart-area"
    :d="path"
    :fill="`url(#${context.patternId(dataKey)})`"
    :stroke="stroke"
    :stroke-dasharray="strokeVariant === 'dashed' ? '5 4' : undefined"
    :opacity="opacity"
  />
</template>
