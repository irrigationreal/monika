import { computed, inject, markRaw, ref } from 'vue';

import { buildBandScale, buildXScale, buildYScale, computeBands } from './scales';

import type { ScaleLinear } from 'd3-scale';
import type { InjectionKey } from 'vue';

import type { DitherColor } from './palette';
import type { ChartRow, StackType } from './scales';

export type ChartType = 'area' | 'bar';
export type ChartConfig = Record<string, { label?: string; color: DitherColor | number | string }>;
export type Margins = { top: number; right: number; bottom: number; left: number };
export type AreaVariant = 'gradient' | 'dotted' | 'hatched' | 'solid';
export type StrokeVariant = 'solid' | 'dashed';

export type SeriesSpec = {
  dataKey: string;
  variant: AreaVariant;
  strokeVariant: StrokeVariant;
  opacity: number;
};

export type ChartContextValue = {
  chartType: ChartType;
  config: ChartConfig;
  configKeys: string[];
  data: ChartRow[];
  stackType: StackType;
  plot: { width: number; height: number };
  ready: boolean;
  xCenter: (index: number) => number;
  y: ScaleLinear<number, number>;
  bands: Record<string, [number, number][]>;
  barSlot: (index: number, seriesIndex: number, seriesCount: number) => { x: number; width: number };
  patternId: (key: string) => string;
  seriesSpecs: Record<string, SeriesSpec>;
  registerSeries: (spec: SeriesSpec) => void;
  unregisterSeries: (dataKey: string) => void;
};

export const ChartKey: InjectionKey<ChartContextValue> = Symbol('vb-dither-chart');

export function useChartPart(part: string, kind?: ChartType): ChartContextValue {
  const context = inject(ChartKey, null);
  if (!context) throw new Error(`<${part} /> must be used within a chart root.`);
  if (kind && context.chartType !== kind) {
    throw new Error(`<${part} /> is not valid inside a ${context.chartType} chart.`);
  }
  return context;
}

export function useChartController(input: {
  chartType: ChartType;
  data: () => ChartRow[];
  config: () => ChartConfig;
  stackType: () => StackType;
  width: () => number;
  height: () => number;
  margins: () => Margins;
  barGap: () => number;
  barEdge: () => number;
  patternPrefix: string;
}): ChartContextValue {
  const seriesSpecs = ref<Record<string, SeriesSpec>>({});
  const configKeys = computed(() => Object.keys(input.config()));
  const computedBands = computed(() => computeBands(input.data(), configKeys.value, input.stackType()));
  const plotWidth = computed(() => Math.max(0, input.width() - input.margins().left - input.margins().right));
  const plotHeight = computed(() => Math.max(0, input.height() - input.margins().top - input.margins().bottom));
  const xPoint = computed(() => buildXScale(input.data().length, plotWidth.value));
  const xBand = computed(() => buildBandScale(input.data().length, plotWidth.value, input.barGap(), input.barEdge()));
  const yScale = computed(() => buildYScale(computedBands.value.max, plotHeight.value));

  const xCenter = (index: number) =>
    input.chartType === 'bar' ? (xBand.value(index) ?? 0) + xBand.value.bandwidth() / 2 : (xPoint.value(index) ?? 0);

  const barSlot = (index: number, seriesIndex: number, seriesCount: number) => {
    const bandwidth = xBand.value.bandwidth();
    if (input.stackType() !== 'default') {
      const width = bandwidth * 0.9;
      return { x: xCenter(index) - width / 2, width };
    }
    const slot = bandwidth / Math.max(seriesCount, 1);
    return {
      x: xCenter(index) - bandwidth / 2 + seriesIndex * slot + slot * 0.08,
      width: slot * 0.84,
    };
  };

  return markRaw({
    chartType: input.chartType,
    get config() {
      return input.config();
    },
    get configKeys() {
      return configKeys.value;
    },
    get data() {
      return input.data();
    },
    get stackType() {
      return input.stackType();
    },
    get plot() {
      return { width: plotWidth.value, height: plotHeight.value };
    },
    get ready() {
      return plotWidth.value > 0 && plotHeight.value > 0;
    },
    xCenter,
    get y() {
      return yScale.value;
    },
    get bands() {
      return computedBands.value.bands;
    },
    barSlot,
    patternId: (key: string) => `${input.patternPrefix}-${Math.max(0, configKeys.value.indexOf(key))}`,
    get seriesSpecs() {
      return seriesSpecs.value;
    },
    registerSeries: (spec: SeriesSpec) => {
      seriesSpecs.value = { ...seriesSpecs.value, [spec.dataKey]: spec };
    },
    unregisterSeries: (dataKey: string) => {
      const next = { ...seriesSpecs.value };
      delete next[dataKey];
      seriesSpecs.value = next;
    },
  });
}
