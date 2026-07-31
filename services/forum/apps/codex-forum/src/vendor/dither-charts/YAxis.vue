<script setup lang="ts">
import { useChartPart } from './chart-context';

const props = withDefaults(
  defineProps<{
    tickFormatter?: ((value: number) => string) | undefined;
    tickCount?: number;
    tickMargin?: number;
  }>(),
  { tickFormatter: undefined, tickCount: 4, tickMargin: 8 }
);

const context = useChartPart('YAxis');
</script>

<template>
  <g v-if="context.ready" class="vb-dither-chart-axis">
    <text
      v-for="tick in context.y.ticks(tickCount)"
      :key="tick"
      :x="-tickMargin"
      :y="context.y(tick)"
      text-anchor="end"
      dominant-baseline="central"
    >
      {{ props.tickFormatter ? props.tickFormatter(tick) : tick }}
    </text>
  </g>
</template>
