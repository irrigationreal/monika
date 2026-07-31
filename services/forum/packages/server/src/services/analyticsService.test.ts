import { describe, expect, it } from 'vitest';

import { AnalyticsService, mapAgentdAnalytics } from './analyticsService';

import type { ForumAnalyticsReadModel } from '@irrigationreal/codex-forum-core';

const raw = {
  coverage: { sessions_scanned: 2, ignored: 'not-a-number' },
  usage: {
    successful_responses: 3,
    median_tokens: 120,
    by_model: [{ vendor: 'OpenAI', model: 'gpt-5', responses: 3, total_tokens: 360, median_tokens: 120 }],
  },
  tools: { worst: { operation: 'bash:pnpm test', calls: 5, failures: 2, failure_rate: 0.4 }, rows: [] },
  errors: { top: { source: 'provider', category: 'rate_limit', affected_turns: 2 }, rows: [] },
  waiting: { count: 2, p95_ms: 5000, excluded: 1 },
  delegation: {
    successful: 4,
    unsuccessful: 1,
    unsuccessful_rate: 0.2,
    unknown: 2,
    by_profile_mode: [{ profile: 'scout', mode: 'parallel', successful: 4, unsuccessful: 1, unsuccessful_rate: 0.2 }],
  },
  model_vendor_usage_over_time: [{ bucket: '2026-07-01', vendor: 'OpenAI', responses: 3, total_tokens: 360 }],
};

describe('AnalyticsService', () => {
  it('maps the aggregate-only agentd contract without exposing unknown raw fields', () => {
    const mapped = mapAgentdAnalytics({ ...raw, privatePrompt: 'never expose this' });
    expect(mapped.usage.medianTokens).toBe(120);
    expect(mapped.tools.worst?.operation).toBe('bash:pnpm test');
    expect(mapped.errors.top?.category).toBe('rate_limit');
    expect(mapped.waiting.p95Ms).toBe(5000);
    expect(mapped.delegation.unsuccessfulRate).toBe(0.2);
    expect(mapped.modelUsageOverTime[0]?.vendor).toBe('OpenAI');
    expect(JSON.stringify(mapped)).not.toContain('never expose this');
  });

  it('maps wait exclusions and preserves zero-filled canonical time buckets', () => {
    const mapped = mapAgentdAnalytics({
      coverage: { excluded_wait_durations: 2 },
      totals: {
        token_footprint: { median: 100 },
        successful_terminal_responses: 1,
        model_vendors: [{ vendor: 'OpenAI', models: [] }],
        tool_operations: { operations: [], worst_qualifying_operation: null },
        error_clusters: [],
        subagent_wait: { samples: 1, p95_elapsed_ms: 500 },
        subagent_lifecycle: {
          records: 0,
          outcomes_observed: 0,
          unsuccessful: 0,
          unsuccessful_rate: null,
          by_profile_mode: [],
        },
      },
      buckets: [
        {
          start: '2026-07-01T00:00:00.000Z',
          model_vendors: [{ vendor: 'OpenAI', response_count: 1, total_tokens: 100 }],
        },
        { start: '2026-07-02T00:00:00.000Z', model_vendors: [] },
      ],
    });
    expect(mapped.waiting.excluded).toBe(2);
    expect(mapped.modelUsageOverTime).toEqual([
      { bucket: '2026-07-01T00:00:00.000Z', vendor: 'OpenAI', responses: 1, totalTokens: 100 },
      { bucket: '2026-07-02T00:00:00.000Z', vendor: 'OpenAI', responses: 0, totalTokens: 0 },
    ]);
  });

  it('keeps forum vocabulary available when agentd is unavailable', async () => {
    const readModel: ForumAnalyticsReadModel = {
      async getAnalyticsScope() {
        return { forums: [{ id: 'f1', name: 'Writing' }], piSessionIds: ['pi-1'], vocabulary: [] };
      },
    };
    const service = new AnalyticsService(readModel, async () => {
      throw new Error('agentd offline');
    });
    const result = await service.getAnalytics({
      window: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', bucket: 'day' },
      forumId: null,
    });
    expect(result.runtime).toEqual({
      available: false,
      warning: 'Canonical Pi analytics are temporarily unavailable.',
      metrics: null,
    });
    expect(result.forums).toEqual([{ id: 'f1', name: 'Writing' }]);
  });
});
