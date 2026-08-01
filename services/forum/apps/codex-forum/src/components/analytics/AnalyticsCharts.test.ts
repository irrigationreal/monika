import { nextTick } from 'vue';

import { fireEvent, render, screen } from '@testing-library/vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsRankedBarChart from './AnalyticsRankedBarChart.vue';
import AnalyticsTimeSeriesChart from './AnalyticsTimeSeriesChart.vue';

class ChartResizeObserver {
  private active = true;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 640, height: 240 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }

  disconnect() {
    this.active = false;
  }

  unobserve(target: Element) {
    this.active = this.active && Boolean(target);
  }
}

const series = [
  { key: 'opus', label: 'Opus family', color: 'purple' as const },
  { key: 'gpt', label: 'GPT family', color: '#358ff3' },
];
const data = [
  { label: '2026-01-01', opus: 5, gpt: 3 },
  { label: '2026-01-02', opus: 7, gpt: 4 },
];

beforeEach(() => vi.stubGlobal('ResizeObserver', ChartResizeObserver));
afterEach(() => vi.unstubAllGlobals());

describe('analytics chart components', () => {
  it('gives a model-vendor time series an explicit accessible name and summary', async () => {
    const view = render(AnalyticsTimeSeriesChart, {
      props: {
        data,
        series,
        label: 'Model requests over time',
        summary: 'Opus and GPT request counts for each day.',
      },
    });
    await nextTick();

    const chart = screen.getByRole('button', { name: /Model requests over time/ });
    const descriptionId = chart.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const description = descriptionId ? view.container.querySelector(`#${descriptionId}`)?.textContent : null;
    expect(description).toBe('Opus and GPT request counts for each day.');
    expect(view.container.querySelectorAll('.analytics-chart-line')).toHaveLength(2);
    expect(view.container.querySelectorAll('.analytics-chart-point')).toHaveLength(4);
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(descriptionId ? view.container.querySelector(`#${descriptionId}`)?.textContent : null).toContain(
      'Opus family: 5'
    );
    await fireEvent.pointerDown(chart, { clientX: 10, pointerType: 'touch' });
    expect(descriptionId ? view.container.querySelector(`#${descriptionId}`)?.textContent : null).toContain(
      'Opus family: 5'
    );
  });

  it('renders horizontal ranked bars with focusable exact details', async () => {
    render(AnalyticsRankedBarChart, {
      props: {
        data: [
          { key: 'read:local', label: 'read · local', value: 20, valueLabel: '20.0%', detail: '2 failures from 10 calls.' },
          { key: 'write:local', label: 'write · local', value: 0, valueLabel: '0.0%', detail: '0 failures from 12 calls.' },
        ],
        label: 'Tool reliability',
        summary: 'Qualifying operations ranked by failure rate.',
      },
    });
    const bar = screen.getByRole('button', { name: /read.*2 failures from 10 calls/ });
    bar.focus();
    await nextTick();
    expect(screen.getByRole('status').textContent).toContain('2 failures from 10 calls');
    expect(document.querySelectorAll('.analytics-ranked-fill')[1]?.getAttribute('style')).toContain('width: 0%');
  });

  it('keeps the required summary and a visual empty state when no rows are available', () => {
    render(AnalyticsTimeSeriesChart, {
      props: {
        data: [],
        series,
        label: 'Empty model request history',
        summary: 'No request records are available for the selected period.',
      },
    });

    expect(screen.queryByRole('button', { name: /Empty model request history/ })).toBeNull();
    expect(screen.getAllByText('No request records are available for the selected period.').length).toBeGreaterThan(0);
    expect(screen.getByText('No chart data.')).toBeTruthy();
  });
});
