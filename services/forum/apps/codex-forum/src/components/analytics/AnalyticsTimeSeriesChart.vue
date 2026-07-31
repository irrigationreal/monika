<script setup lang="ts">
import { computed, useId } from 'vue';

import { AreaChart, Area as DitherArea, Grid, XAxis, YAxis, cssColor } from '../../vendor/dither-charts';

import type { CSSProperties } from 'vue';

import type { AnalyticsChartDatum, AnalyticsChartSeries } from './types';

const props = withDefaults(
  defineProps<{
    data: AnalyticsChartDatum[];
    series: AnalyticsChartSeries[];
    ariaLabel: string;
    summary: string;
    xKey?: string;
    height?: number;
    stacked?: boolean;
    xTickFormatter?: ((value: unknown, index: number) => string) | undefined;
    yTickFormatter?: ((value: number) => string) | undefined;
  }>(),
  {
    xKey: 'label',
    height: 240,
    stacked: true,
    xTickFormatter: undefined,
    yTickFormatter: undefined,
  }
);

const summaryId = `vb-analytics-summary-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const config = computed(() =>
  Object.fromEntries(props.series.map((item) => [item.key, { label: item.label, color: item.color }]))
);
const chartStyle = computed<CSSProperties>(() => ({
  '--vb-analytics-chart-height': `${Math.max(120, props.height).toString()}px`,
}));
</script>

<template>
  <figure
    class="vb-analytics-chart"
    role="img"
    :aria-label="ariaLabel"
    :aria-describedby="summaryId"
    :style="chartStyle"
  >
    <figcaption :id="summaryId" class="vb-analytics-chart-summary">{{ summary }}</figcaption>
    <div v-if="data.length === 0" class="vb-analytics-chart-empty" aria-hidden="true">No chart data.</div>
    <AreaChart
      v-else
      class="vb-analytics-chart-plot"
      :data="data"
      :config="config"
      :stack-type="stacked ? 'stacked' : 'default'"
    >
      <Grid />
      <DitherArea v-for="item in series" :key="item.key" :data-key="item.key" :variant="item.variant ?? 'gradient'" />
      <XAxis :data-key="xKey" :tick-formatter="xTickFormatter" />
      <YAxis :tick-formatter="yTickFormatter" />
    </AreaChart>
    <ul v-if="series.length > 0" class="vb-analytics-chart-legend" aria-hidden="true">
      <li v-for="item in series" :key="item.key">
        <span class="vb-analytics-chart-swatch" :style="{ backgroundColor: cssColor(item.color) }" />
        {{ item.label }}
      </li>
    </ul>
  </figure>
</template>
