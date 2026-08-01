import { createMemoryHistory, createRouter } from 'vue-router';

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsView from './AnalyticsView.vue';

import type { AdminAnalyticsDto } from '../lib/apiClient';

const { getAdminAnalytics } = vi.hoisted(() => ({ getAdminAnalytics: vi.fn() }));
vi.mock('../lib/apiClient', () => ({ api: { getAdminAnalytics } }));

const payload: AdminAnalyticsDto = {
  generatedAt: '2026-07-31T00:00:00.000Z',
  window: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', bucket: 'day' },
  selectedForumId: null,
  forums: [{ id: 'f1', name: 'Writing' }],
  vocabulary: {
    algorithmVersion: 1,
    groups: [
      {
        forumId: 'f1',
        forumName: 'Writing',
        audience: 'human',
        postCount: 2,
        terms: [{ term: 'starlight', score: 2, count: 3, documentCount: 2 }],
      },
    ],
  },
  runtime: {
    available: true,
    warning: null,
    metrics: {
      generatedAt: '2026-08-01T10:01:00.000Z',
      build: { commit: 'abcdef1234567', createdAt: '2026-08-01T10:00:00.000Z' },
      coverage: {},
      usage: { successfulResponses: 4, medianTokens: 1234, byModel: [] },
      tools: {
        worst: {
          operation: 'relocate_remote',
          backend: 'relocated_ssh',
          calls: 5,
          failures: 1,
          failureRate: 0.2,
          outcomes: { success: 4, transport: 1 },
        },
        rows: [
          {
            operation: 'relocate_remote',
            backend: 'relocated_ssh',
            calls: 5,
            failures: 1,
            failureRate: 0.2,
            outcomes: { success: 4, transport: 1 },
          },
        ],
      },
      errors: { top: { source: 'provider', category: 'rate_limit', operation: null, affectedTurns: 2 }, rows: [] },
      waiting: { count: 3, p95Ms: 4500, excluded: 0 },
      delegation: { successful: 4, unsuccessful: 1, unsuccessfulRate: 0.2, unknown: 1, byProfileMode: [] },
      modelUsageOverTime: [
        {
          bucket: '2026-07-01T00:00:00.000Z',
          bucketEnd: '2026-07-02T00:00:00.000Z',
          observedFrom: '2026-07-01T00:00:00.000Z',
          observedTo: '2026-07-02T00:00:00.000Z',
          isPartial: false,
          vendor: 'OpenAI',
          responses: 4,
          totalTokens: 4936,
        },
      ],
    },
  },
};

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/analytics', name: 'admin.analytics', component: AnalyticsView },
      { path: '/admin', name: 'admin', component: { template: '<div />' } },
    ],
  });
}

async function mountAnalytics(path = '/admin/analytics?range=30d&bucket=auto') {
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  return { router, wrapper: mount(AnalyticsView, { global: { plugins: [router] } }) };
}

describe('AnalyticsView', () => {
  beforeEach(() => {
    getAdminAnalytics.mockReset();
    getAdminAnalytics.mockResolvedValue(payload);
  });

  it('renders the five approved headline metrics and semantic data tables', async () => {
    const router = testRouter();
    await router.push('/admin/analytics?range=30d&bucket=auto');
    await router.isReady();
    const wrapper = mount(AnalyticsView, { global: { plugins: [router] } });
    await vi.waitFor(() => {
      expect(getAdminAnalytics).toHaveBeenCalled();
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.analytics-metric')).toHaveLength(5);
    expect(wrapper.text()).toContain('abcdef1234567');
    expect(wrapper.text()).toContain('1,234');
    expect(wrapper.text()).toContain('relocate_remote');
    expect(wrapper.text()).toContain('relocated_ssh');
    expect(wrapper.text()).toContain('transport: 1');
    expect(wrapper.text()).toContain('rate_limit');
    expect(wrapper.text()).toContain('4.5 s');
    expect(wrapper.text()).toContain('starlight');
    expect(wrapper.findAll('table').length).toBeGreaterThanOrEqual(5);
  });

  it('distinguishes fatal, stale-refresh, and runtime-degraded states', async () => {
    getAdminAnalytics.mockRejectedValueOnce(new Error('initial outage'));
    const fatal = await mountAnalytics();
    await vi.waitFor(() => {
      expect(fatal.wrapper.text()).toContain('initial outage');
      expect(fatal.wrapper.text()).toContain('Retry');
    });
    fatal.wrapper.unmount();

    getAdminAnalytics.mockResolvedValueOnce(payload).mockRejectedValueOnce(new Error('refresh outage'));
    const stale = await mountAnalytics();
    await vi.waitFor(() => {
      expect(stale.wrapper.text()).toContain('1,234');
    });
    const refresh = stale.wrapper.findAll('button').find((button) => button.text() === 'Refresh');
    expect(refresh).toBeTruthy();
    await refresh?.trigger('click');
    await vi.waitFor(() => {
      expect(stale.wrapper.text()).toContain('Showing the last successful result');
      expect(stale.wrapper.text()).toContain('1,234');
    });
    stale.wrapper.unmount();

    getAdminAnalytics.mockResolvedValueOnce({
      ...structuredClone(payload),
      runtime: { available: false, warning: 'runtime offline', metrics: null },
    });
    const degraded = await mountAnalytics();
    await vi.waitFor(() => {
      expect(degraded.wrapper.text()).toContain('runtime offline');
      expect(degraded.wrapper.text()).toContain('starlight');
      expect(degraded.wrapper.findAll('.analytics-metric')).toHaveLength(0);
    });
    degraded.wrapper.unmount();
  });

  it('labels a genuinely empty successful scope', async () => {
    const empty = structuredClone(payload);
    empty.vocabulary.groups = [];
    if (!empty.runtime.metrics) throw new Error('fixture metrics missing');
    empty.runtime.metrics.usage = { successfulResponses: 0, medianTokens: null, byModel: [] };
    empty.runtime.metrics.tools = { worst: null, rows: [] };
    empty.runtime.metrics.errors = { top: null, rows: [] };
    empty.runtime.metrics.delegation = { successful: 0, unsuccessful: 0, unsuccessfulRate: null, unknown: 0, byProfileMode: [] };
    empty.runtime.metrics.waiting = { count: 0, p95Ms: null };
    empty.runtime.metrics.modelUsageOverTime = [];
    getAdminAnalytics.mockResolvedValueOnce(empty);
    const view = await mountAnalytics();
    await vi.waitFor(() => {
      expect(view.wrapper.text()).toContain('No analytics observations or distinctive vocabulary');
    });
  });

  it('ignores a late response from an obsolete URL scope', async () => {
    let resolveFirst!: (value: typeof payload) => void;
    let resolveSecond!: (value: typeof payload) => void;
    getAdminAnalytics
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
      );
    const router = testRouter();
    await router.push('/admin/analytics?range=30d&bucket=auto');
    await router.isReady();
    const wrapper = mount(AnalyticsView, { global: { plugins: [router] } });
    await vi.waitFor(() => {
      expect(getAdminAnalytics).toHaveBeenCalledTimes(1);
    });

    await router.push('/admin/analytics?range=7d&bucket=day&forum=f1');
    await vi.waitFor(() => {
      expect(getAdminAnalytics).toHaveBeenCalledTimes(2);
    });
    resolveSecond({ ...structuredClone(payload), selectedForumId: 'f1' });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Writing ·');
    });
    resolveFirst({ ...structuredClone(payload), forums: [{ id: 'old', name: 'Obsolete scope' }] });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Obsolete scope');
  });
});
