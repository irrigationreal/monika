import type { AreaVariant } from '../../vendor/dither-charts';

export type AnalyticsChartDatum = Record<string, unknown>;

export interface AnalyticsChartSeries {
  key: string;
  label: string;
  color: number | string;
  variant?: AreaVariant;
}

export interface AnalyticsTableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  sortable?: boolean;
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

export interface RankedBarDatum {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  detail: string;
}
