import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsView from './AnalyticsView.vue';

const { getAdminAnalytics } = vi.hoisted(() => ({ getAdminAnalytics: vi.fn() }));
vi.mock('../lib/apiClient', () => ({ api: { getAdminAnalytics } }));

const payload = {
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
      coverage: {},
      usage: { successfulResponses: 4, medianTokens: 1234, byModel: [] },
      tools: { worst: { operation: 'bash:pnpm test', calls: 5, failures: 1, failureRate: 0.2 }, rows: [] },
      errors: { top: { source: 'provider', category: 'rate_limit', operation: null, affectedTurns: 2 }, rows: [] },
      waiting: { count: 3, p95Ms: 4500, excluded: 0 },
      delegation: { successful: 4, unsuccessful: 1, unsuccessfulRate: 0.2, unknown: 1, byProfileMode: [] },
      modelUsageOverTime: [{ bucket: '2026-07-01', vendor: 'OpenAI', responses: 4, totalTokens: 4936 }],
    },
  },
};

describe('AnalyticsView', () => {
  beforeEach(() => {
    getAdminAnalytics.mockReset();
    getAdminAnalytics.mockResolvedValue(payload);
  });

  it('renders the five approved headline metrics and semantic data tables', async () => {
    const wrapper = mount(AnalyticsView, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } });
    await vi.waitFor(() => {
      expect(getAdminAnalytics).toHaveBeenCalled();
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.analytics-metric')).toHaveLength(5);
    expect(wrapper.text()).toContain('1,234');
    expect(wrapper.text()).toContain('bash:pnpm test');
    expect(wrapper.text()).toContain('rate_limit');
    expect(wrapper.text()).toContain('4.5 s');
    expect(wrapper.text()).toContain('starlight');
    expect(wrapper.findAll('table').length).toBeGreaterThanOrEqual(5);
  });
});
