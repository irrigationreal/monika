import type { AreaVariant } from '../../vendor/dither-charts';

export type AnalyticsChartDatum = Record<string, unknown>;

export interface AnalyticsChartSeries {
  key: string;
  label: string;
  color: number | string;
  variant?: AreaVariant;
}
