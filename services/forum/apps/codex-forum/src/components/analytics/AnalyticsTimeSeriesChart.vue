<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

import type { AnalyticsChartDatum, AnalyticsChartSeries } from './types';

const props = withDefaults(
  defineProps<{
    data: AnalyticsChartDatum[];
    series: AnalyticsChartSeries[];
    label: string;
    summary: string;
    xKey?: string;
    height?: number;
    xTickFormatter?: (value: unknown, index: number) => string;
    valueFormatter?: (value: number) => string;
  }>(),
  {
    xKey: 'label',
    height: 240,
    xTickFormatter: (value: unknown) => (typeof value === 'string' ? value : ''),
    valueFormatter: (value: number) => new Intl.NumberFormat().format(value),
  }
);

const host = ref<HTMLElement | null>(null);
const width = ref(640);
const activeIndex = ref<number | null>(null);
const focused = ref(false);
let observer: ResizeObserver | null = null;
const descriptionId = `analytics-chart-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const margins = { top: 14, right: 14, bottom: 34, left: 42 };
const plotWidth = computed(() => Math.max(1, width.value - margins.left - margins.right));
const plotHeight = computed(() => Math.max(1, props.height - margins.top - margins.bottom));
const maximum = computed(() =>
  Math.max(1, ...props.data.flatMap((row) => props.series.map((series) => Number(row[series.key]) || 0)))
);
const x = (index: number) =>
  margins.left + (props.data.length <= 1 ? plotWidth.value / 2 : (index / (props.data.length - 1)) * plotWidth.value);
const y = (value: number) => margins.top + plotHeight.value - (value / maximum.value) * plotHeight.value;
const paths = computed(() =>
  props.series.map((series) => ({
    series,
    d: props.data
      .map((row, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(Number(row[series.key]) || 0).toFixed(2)}`)
      .join(' '),
  }))
);
const tickIndices = computed(() => {
  if (!props.data.length) return [];
  const count = Math.max(2, Math.floor(plotWidth.value / 82));
  if (props.data.length <= count) return props.data.map((_, index) => index);
  const output = new Set<number>([0, props.data.length - 1]);
  for (let index = 1; index < count - 1; index += 1)
    output.add(Math.round((index * (props.data.length - 1)) / (count - 1)));
  return [...output].sort((a, b) => a - b);
});
const activeRow = computed(() => (activeIndex.value === null ? null : (props.data[activeIndex.value] ?? null)));
const activeText = computed(() => {
  const row = activeRow.value;
  if (!row) return props.summary;
  const values = props.series.map((series) => `${series.label}: ${formatValue(Number(row[series.key]) || 0)}`);
  const total = props.series.reduce((sum, series) => sum + (Number(row[series.key]) || 0), 0);
  return `${labelAt(activeIndex.value ?? 0)}${row['isPartial'] ? ' (partial bucket)' : ''}. ${values.join('; ')}. Total: ${formatValue(total)}.`;
});

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}
function labelAt(index: number): string {
  const row = props.data[index];
  const value = row?.[props.xKey];
  return props.xTickFormatter(value, index) || textValue(value);
}
function formatValue(value: number): string {
  return props.valueFormatter(value);
}
function selectFromPointer(event: PointerEvent): void {
  if (!props.data.length || !host.value) return;
  const rect = host.value.getBoundingClientRect();
  const relative = Math.max(0, Math.min(plotWidth.value, event.clientX - rect.left - margins.left));
  activeIndex.value = Math.round((relative / plotWidth.value) * Math.max(0, props.data.length - 1));
}
function move(delta: number): void {
  if (!props.data.length) return;
  const current = activeIndex.value ?? (delta > 0 ? -1 : props.data.length);
  activeIndex.value = Math.max(0, Math.min(props.data.length - 1, current + delta));
}
function onBlur(): void {
  focused.value = false;
  activeIndex.value = null;
}

onMounted(() => {
  const node = host.value;
  if (!node) return;
  width.value = node.clientWidth || 640;
  observer = new ResizeObserver(([entry]) => {
    if (entry) width.value = Math.round(entry.contentRect.width);
  });
  observer.observe(node);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <figure class="vb-analytics-chart">
    <figcaption class="vb-analytics-chart-summary">{{ summary }}</figcaption>
    <div v-if="!data.length" class="vb-analytics-chart-empty">No chart data.</div>
    <button
      v-else
      ref="host"
      type="button"
      class="analytics-line-chart"
      :aria-label="`${label}. Use left and right arrow keys to inspect buckets.`"
      :aria-describedby="descriptionId"
      @pointerdown="selectFromPointer"
      @pointermove="selectFromPointer"
      @pointerleave="
        () => {
          if (!focused) activeIndex = null;
        }
      "
      @focus="
        focused = true;
        activeIndex = activeIndex ?? 0;
      "
      @blur="onBlur"
      @keydown.left.prevent="move(-1)"
      @keydown.right.prevent="move(1)"
      @keydown.home.prevent="activeIndex = 0"
      @keydown.end.prevent="activeIndex = data.length - 1"
      @keydown.esc="activeIndex = null"
    >
      <svg :width="width" :height="height" aria-hidden="true" focusable="false">
        <line
          v-for="tick in [0, 0.25, 0.5, 0.75, 1]"
          :key="tick"
          class="vb-dither-chart-grid"
          :x1="margins.left"
          :x2="width - margins.right"
          :y1="margins.top + plotHeight * (1 - tick)"
          :y2="margins.top + plotHeight * (1 - tick)"
        />
        <text
          v-for="tick in [0, 0.25, 0.5, 0.75, 1]"
          :key="`y${tick}`"
          class="vb-dither-chart-axis"
          :x="margins.left - 7"
          :y="margins.top + plotHeight * (1 - tick)"
          text-anchor="end"
          dominant-baseline="central"
        >
          {{ formatValue(maximum * tick) }}
        </text>
        <rect
          v-for="(row, index) in data"
          v-show="row['isPartial']"
          :key="`partial${index}`"
          class="analytics-chart-partial"
          :x="x(index) - Math.max(3, plotWidth / Math.max(1, data.length) / 2)"
          :y="margins.top"
          :width="Math.max(6, plotWidth / Math.max(1, data.length))"
          :height="plotHeight"
        />
        <path
          v-for="(path, index) in paths"
          :key="path.series.key"
          class="analytics-chart-line"
          :class="`analytics-series-${(index % 8) + 1}`"
          :d="path.d"
        />
        <template v-for="(path, seriesIndex) in paths" :key="`points-${path.series.key}`">
          <circle
            v-for="(row, index) in data"
            :key="index"
            class="analytics-chart-point"
            :class="`analytics-series-${(seriesIndex % 8) + 1}`"
            :cx="x(index)"
            :cy="y(Number(row[path.series.key]) || 0)"
            r="2.5"
          />
        </template>
        <line
          v-if="activeIndex !== null"
          class="analytics-chart-cursor"
          :x1="x(activeIndex)"
          :x2="x(activeIndex)"
          :y1="margins.top"
          :y2="margins.top + plotHeight"
        />
        <text
          v-for="index in tickIndices"
          :key="`x${index}`"
          class="vb-dither-chart-axis"
          :x="x(index)"
          :y="margins.top + plotHeight + 10"
          text-anchor="middle"
          dominant-baseline="hanging"
        >
          {{ labelAt(index) }}
        </text>
      </svg>
      <span
        v-if="activeRow"
        class="analytics-chart-tooltip"
        :style="{ left: `${(x(activeIndex ?? 0) / width) * 100}%` }"
      >
        {{ activeText }}
      </span>
    </button>
    <p :id="descriptionId" class="vb-analytics-chart-summary" aria-live="polite">{{ activeText }}</p>
    <ul v-if="series.length" class="vb-analytics-chart-legend" aria-label="Chart series">
      <li v-for="(item, index) in series" :key="item.key">
        <span class="analytics-line-swatch" :class="`analytics-series-${(index % 8) + 1}`" aria-hidden="true" />{{
          item.label
        }}
      </li>
      <li><span class="analytics-partial-swatch" aria-hidden="true" />Partial bucket</li>
    </ul>
  </figure>
</template>
