import { nextTick } from 'vue';

import { render, screen } from '@testing-library/vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsBreakdownBarChart from './AnalyticsBreakdownBarChart.vue';
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
  it('gives a model-family time series an explicit accessible name and summary', async () => {
    const view = render(AnalyticsTimeSeriesChart, {
      props: {
        data,
        series,
        ariaLabel: 'Model requests over time',
        summary: 'Opus and GPT request counts for each day.',
      },
    });
    await nextTick();

    const chart = screen.getByRole('img', { name: 'Model requests over time' });
    const descriptionId = chart.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const description = descriptionId ? view.container.querySelector(`#${descriptionId}`)?.textContent : null;
    expect(description).toBe('Opus and GPT request counts for each day.');
    expect(view.container.querySelectorAll('.vb-dither-chart-area')).toHaveLength(2);
    expect(view.container.querySelector('.vb-dither-chart')?.getAttribute('data-animation')).toBe('off');
    expect(view.container.querySelector('.vb-dither-chart')?.getAttribute('data-sparkles')).toBe('off');
    expect(view.container.querySelector('.vb-dither-chart')?.getAttribute('data-bloom')).toBe('off');
  });

  it('renders grouped breakdown bars from the same reusable series contract', async () => {
    const view = render(AnalyticsBreakdownBarChart, {
      props: {
        data,
        series,
        ariaLabel: 'Requests by model family',
        summary: 'Two model-family bars are shown for each day.',
      },
    });
    await nextTick();

    expect(screen.getByRole('img', { name: 'Requests by model family' })).toBeTruthy();
    expect(view.container.querySelectorAll('.vb-dither-chart-bar')).toHaveLength(4);
    expect(view.container.querySelectorAll('pattern')).toHaveLength(2);
  });

  it('keeps the required summary and a visual empty state when no rows are available', () => {
    render(AnalyticsTimeSeriesChart, {
      props: {
        data: [],
        series,
        ariaLabel: 'Empty model request history',
        summary: 'No request records are available for the selected period.',
      },
    });

    expect(screen.getByRole('img', { name: 'Empty model request history' })).toBeTruthy();
    expect(screen.getByText('No request records are available for the selected period.')).toBeTruthy();
    expect(screen.getByText('No chart data.')).toBeTruthy();
  });
});
