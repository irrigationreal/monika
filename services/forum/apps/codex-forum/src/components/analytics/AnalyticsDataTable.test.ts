import { fireEvent, render, screen } from '@testing-library/vue';
import { describe, expect, it } from 'vitest';

import AnalyticsDataTable from './AnalyticsDataTable.vue';

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'count', label: 'Count', numeric: true },
];
const rows = Array.from({ length: 12 }, (_, index) => ({
  name: `row-${String(index + 1).padStart(2, '0')}`,
  count: index + 1,
}));

describe('AnalyticsDataTable', () => {
  it('sorts semantic columns and paginates all rows', async () => {
    render(AnalyticsDataTable, {
      props: {
        rows,
        columns,
        caption: 'Example aggregate data',
        rowKey: (row: Record<string, unknown>) => String(row['name']),
        defaultSort: 'count',
        pageSize: 5,
      },
    });

    expect(screen.getByText('Rows 1–5 of 12')).toBeTruthy();
    expect(screen.getByText('row-12')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /Count/ }));
    expect(screen.getByText('row-01')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Count/ }).getAttribute('aria-sort')).toBe('ascending');
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Rows 6–10 of 12')).toBeTruthy();
  });
});
