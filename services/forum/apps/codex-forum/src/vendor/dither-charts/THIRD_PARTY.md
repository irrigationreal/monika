# Third-party provenance

This directory contains a narrow, adapted subset of the Vue area/bar chart code from
[Dither UI](https://github.com/drvova/dither-ui).

- Upstream commit: `1ebb20a3601eb5fd0694af8c64706e2aa5cefc25`
- Upstream paths:
  `dither-kit/{area-chart.ts,bar-chart.ts,cartesian-root.ts,chart-context.ts,scales.ts,use-chart-dimensions.ts,Area.vue,Bar.vue,Grid.vue,XAxis.vue,YAxis.vue}`
- License: MIT
- Copyright: Copyright (c) 2026 Sasha Fortel

## Local adaptations

The subset uses static SVG dither patterns instead of the upstream canvas painter. Animation, sparkles, bloom,
precompiled images, line/pie/radar charts, legends, tooltips, and unrelated UI components are intentionally omitted.
Tailwind/shadcn utility classes and the upstream `clsx`/`tailwind-merge` helper were replaced with `vb-dither-*` rules
in the forum stylesheet. The only added runtime dependencies are `d3-scale` and `d3-shape`; Vue is already provided by
the forum application.

The complete upstream MIT notice is retained in `NOTICE` next to this file.
