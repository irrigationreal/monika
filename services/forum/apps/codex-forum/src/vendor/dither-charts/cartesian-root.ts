import { computed, defineComponent, h, provide, useId } from 'vue';

import { ChartKey, useChartController } from './chart-context';
import { cssColor } from './palette';
import { useChartDimensions } from './use-chart-dimensions';

import type { PropType } from 'vue';

import type { AreaVariant, ChartConfig, ChartType, Margins } from './chart-context';
import type { ChartRow, StackType } from './scales';

const DEFAULT_MARGINS: Margins = { top: 10, right: 12, bottom: 24, left: 42 };

function patternChildren(color: string, variant: AreaVariant) {
  if (variant === 'solid') return [h('rect', { width: 4, height: 4, fill: color, opacity: 0.8 })];
  if (variant === 'dotted') {
    return [h('circle', { cx: 1, cy: 1, r: 0.8, fill: color, opacity: 0.9 })];
  }
  if (variant === 'hatched') {
    return [h('path', { d: 'M-1,1 L1,-1 M0,4 L4,0 M3,5 L5,3', stroke: color, 'stroke-width': 1 })];
  }
  return [
    h('rect', { width: 4, height: 4, fill: color, opacity: 0.2 }),
    h('rect', { width: 2, height: 2, fill: color, opacity: 0.9 }),
    h('rect', { x: 2, y: 2, width: 2, height: 2, fill: color, opacity: 0.62 }),
  ];
}

/**
 * Static SVG adaptation of Dither UI's composable cartesian root. The forum
 * subset intentionally excludes animation, sparkle, bloom, canvas and
 * precompiled-image paths.
 */
export function defineCartesianChart(chartType: ChartType) {
  return defineComponent({
    name: `${chartType[0]?.toUpperCase()}${chartType.slice(1)}Chart`,
    props: {
      data: { type: Array as PropType<ChartRow[]>, required: true },
      config: { type: Object as PropType<ChartConfig>, required: true },
      stackType: { type: String as PropType<StackType>, default: 'default' },
      margins: { type: Object as PropType<Partial<Margins>>, default: () => ({}) },
      class: { type: String, default: undefined },
      barGap: { type: Number, default: 0.28 },
      barEdge: { type: Number, default: 0.18 },
    },
    setup(props, { slots }) {
      const { element, size } = useChartDimensions();
      const margins = computed<Margins>(() => ({ ...DEFAULT_MARGINS, ...props.margins }));
      const prefix = `vb-dither-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const context = useChartController({
        chartType,
        data: () => props.data,
        config: () => props.config,
        stackType: () => props.stackType,
        width: () => size.value.width,
        height: () => size.value.height,
        margins: () => margins.value,
        barGap: () => props.barGap,
        barEdge: () => props.barEdge,
        patternPrefix: prefix,
      });
      provide(ChartKey, context);

      return () => {
        const definitions = context.configKeys.map((key) => {
          const variant = context.seriesSpecs[key]?.variant ?? 'gradient';
          return h(
            'pattern',
            {
              id: context.patternId(key),
              key,
              width: 4,
              height: 4,
              patternUnits: 'userSpaceOnUse',
            },
            patternChildren(cssColor(context.config[key]?.color ?? 'grey'), variant)
          );
        });
        const margin = margins.value;
        return h(
          'div',
          {
            ref: element,
            class: ['vb-dither-chart', props.class],
            'aria-hidden': 'true',
            'data-animation': 'off',
            'data-sparkles': 'off',
            'data-bloom': 'off',
          },
          [
            h(
              'svg',
              {
                width: size.value.width,
                height: size.value.height,
                class: 'vb-dither-chart-svg',
                focusable: 'false',
              },
              [
                h('defs', definitions),
                context.ready
                  ? h('g', { transform: `translate(${margin.left},${margin.top})` }, slots['default']?.())
                  : null,
              ]
            ),
          ]
        );
      };
    },
  });
}
