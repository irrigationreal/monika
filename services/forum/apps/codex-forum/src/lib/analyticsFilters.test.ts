import { describe, expect, it } from 'vitest';

import { analyticsQuery, analyticsWindow, parseAnalyticsFilters } from './analyticsFilters';

describe('analytics filters', () => {
  it('normalizes malformed URL values and omits the empty forum', () => {
    const filters = parseAnalyticsFilters({ range: 'never', bucket: ['bad'], forum: '  ' });
    expect(filters).toEqual({ range: '30d', bucket: 'auto', forumId: '' });
    expect(analyticsQuery(filters)).toEqual({ range: '30d', bucket: 'auto' });
  });

  it('uses calendar-aligned UTC presets and automatic granularity', () => {
    expect(
      analyticsWindow({ range: '30d', bucket: 'auto', forumId: '' }, new Date('2026-08-01T15:30:00.000Z'))
    ).toEqual({
      from: '2026-07-03T00:00:00.000Z',
      to: '2026-08-01T15:30:00.000Z',
      bucket: 'day',
    });
    expect(
      analyticsWindow({ range: '90d', bucket: 'auto', forumId: '' }, new Date('2026-03-01T01:00:00.000Z'))
    ).toEqual({
      from: '2025-12-02T00:00:00.000Z',
      to: '2026-03-01T01:00:00.000Z',
      bucket: 'week',
    });
  });
});
