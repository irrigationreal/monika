import { describe, expect, it } from 'vitest';

import { groupSubagentRuns, retentionDashboard, unavailableRetentionDashboard } from './adminRoutes';

describe('robot dashboard subagent grouping', () => {
  it('separates safety blockers, pending delivery, and retained terminal history', () => {
    const blocker = { runId: 'active', executionState: 'active', blocking: true, deliveryState: null };
    const uncertain = { runId: 'uncertain', executionState: 'uncertain', blocking: false, deliveryState: 'pending' };
    const pending = { runId: 'pending', executionState: 'terminal', blocking: false, deliveryState: 'pending' };
    const effectsUnknown = { runId: 'effects', executionState: 'terminal', effectsState: 'unknown', blocking: false, deliveryState: 'pending' };
    const unproven = { runId: 'unproven', executionState: 'terminal', blocking: false, deliveryState: 'unproven' };
    const history = { runId: 'history', executionState: 'interrupted', blocking: false, deliveryState: 'settled' };

    expect(groupSubagentRuns([history, pending, unproven, effectsUnknown, uncertain, blocker] as any)).toEqual({
      blockers: [effectsUnknown, uncertain, blocker],
      pendingDelivery: [pending, unproven],
      history: [history],
    });
  });

  it('maps the full retention DTO and preserves an unavailable fallback', () => {
    expect(retentionDashboard({ ok: true, digest: 'abc', generatedAt: 1_700_000_000_000, retentionMs: 14 * 86_400_000,
      counts: { protected: 2, waiting: 3, eligible: 4, compacted: 5, error: 0 }, bytes: { tracked_removable: 100, eligible: 40 }, omitted: 6, running: true,
      last_run_at: 1_700_000_000_001, last_error: null })).toEqual({ available: true, generatedAt: '2023-11-14T22:13:20.000Z', retentionDays: 14,
      counts: { protected: 2, waiting: 3, eligible: 4, compacted: 5, error: 0 }, trackedRemovableBytes: 100, eligibleBytes: 40, omitted: 6, running: true, lastError: null });
    expect(unavailableRetentionDashboard(new Error('agentd unavailable'))).toEqual({ available: false, generatedAt: null, retentionDays: 14,
      counts: { protected: 0, waiting: 0, eligible: 0, compacted: 0, error: 0 }, trackedRemovableBytes: 0, eligibleBytes: 0, omitted: 0, running: false, lastError: 'agentd unavailable' });
  });
});
