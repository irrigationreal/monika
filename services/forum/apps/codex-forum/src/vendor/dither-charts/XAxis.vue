<script setup lang="ts">
import { computed } from 'vue';

import { useChartPart } from './chart-context';

const props = withDefaults(
  defineProps<{
    dataKey?: string | undefined;
    tickFormatter?: ((value: unknown, index: number) => string) | undefined;
    tickMargin?: number;
    maxTicks?: number;
  }>(),
  { dataKey: undefined, tickFormatter: undefined, tickMargin: 8, maxTicks: 8 }
);

const context = useChartPart('XAxis');
const step = computed(() => Math.max(1, Math.ceil(context.data.length / props.maxTicks)));
const labelAt = (row: Record<string, unknown>, index: number) => {
  const raw = props.dataKey ? row[props.dataKey] : index;
  return props.tickFormatter ? props.tickFormatter(raw, index) : String(raw ?? '');
};
</script>

<template>
  <g v-if="context.ready" class="vb-dither-chart-axis">
    <template v-for="(row, index) in context.data" :key="index">
      <text
        v-if="index % step === 0"
        :x="context.xCenter(index)"
        :y="context.plot.height + tickMargin"
        text-anchor="middle"
        dominant-baseline="hanging"
      >
        {{ labelAt(row, index) }}
      </text>
    </template>
  </g>
</template>
