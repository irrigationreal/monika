export const ANALYTICS_RANGE_VALUES = ['7d', '30d', '90d', '1y'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGE_VALUES)[number];
export type AnalyticsBucketChoice = 'auto' | 'day' | 'week';

export interface AnalyticsFilters {
  range: AnalyticsRange;
  bucket: AnalyticsBucketChoice;
  forumId: string;
}

export interface AppliedAnalyticsWindow {
  from: string;
  to: string;
  bucket: 'day' | 'week';
}

const DAYS_BY_RANGE: Record<AnalyticsRange, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

function scalar(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function parseAnalyticsFilters(query: Record<string, unknown>): AnalyticsFilters {
  const rangeValue = scalar(query['range']);
  const bucketValue = scalar(query['bucket']);
  const forumValue = scalar(query['forum']);
  return {
    range: ANALYTICS_RANGE_VALUES.includes(rangeValue as AnalyticsRange) ? (rangeValue as AnalyticsRange) : '30d',
    bucket: bucketValue === 'day' || bucketValue === 'week' || bucketValue === 'auto' ? bucketValue : 'auto',
    forumId: forumValue?.trim() ?? '',
  };
}

export function analyticsQuery(filters: AnalyticsFilters): Record<string, string> {
  const query: Record<string, string> = { range: filters.range, bucket: filters.bucket };
  if (filters.forumId) query['forum'] = filters.forumId;
  return query;
}

export function analyticsWindow(filters: AnalyticsFilters, now = new Date()): AppliedAnalyticsWindow {
  const days = DAYS_BY_RANGE[filters.range];
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const bucket = filters.bucket === 'auto' ? (days <= 30 ? 'day' : 'week') : filters.bucket;
  return { from: from.toISOString(), to: now.toISOString(), bucket };
}

export function rangeLabel(range: AnalyticsRange): string {
  return { '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': '1 year' }[range];
}

export function shortUtcDate(value: string, includeYear = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(date);
}

export function utcDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}
