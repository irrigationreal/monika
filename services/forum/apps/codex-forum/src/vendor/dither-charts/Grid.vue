<script setup lang="ts">
import { useChartPart } from './chart-context';

withDefaults(
  defineProps<{
    horizontal?: boolean;
    vertical?: boolean;
    strokeDasharray?: string;
    tickCount?: number;
  }>(),
  { horizontal: true, vertical: false, strokeDasharray: '3 3', tickCount: 4 }
);

const context = useChartPart('Grid');
</script>

<template>
  <g v-if="context.ready" class="vb-dither-chart-grid" :stroke-dasharray="strokeDasharray">
    <template v-if="horizontal">
      <line
        v-for="tick in context.y.ticks(tickCount)"
        :key="`horizontal-${tick}`"
        :x1="0"
        :x2="context.plot.width"
        :y1="context.y(tick)"
        :y2="context.y(tick)"
      />
    </template>
    <template v-if="vertical">
      <line
        v-for="(_, index) in context.data"
        :key="`vertical-${index}`"
        :x1="context.xCenter(index)"
        :x2="context.xCenter(index)"
        :y1="0"
        :y2="context.plot.height"
      />
    </template>
  </g>
</template>
