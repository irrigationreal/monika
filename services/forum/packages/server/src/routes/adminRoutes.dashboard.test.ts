import { describe, expect, it } from 'vitest';

import { groupSubagentRuns } from './adminRoutes';

describe('robot dashboard subagent grouping', () => {
  it('separates safety blockers, pending delivery, and retained terminal history', () => {
    const blocker = { runId: 'active', executionState: 'active', blocking: true, deliveryState: null };
    const uncertain = { runId: 'uncertain', executionState: 'uncertain', blocking: false, deliveryState: 'pending' };
    const pending = { runId: 'pending', executionState: 'terminal', blocking: false, deliveryState: 'pending' };
    const effectsUnknown = { runId: 'effects', executionState: 'terminal', effectsState: 'unknown', blocking: false, deliveryState: 'pending' };
    const history = { runId: 'history', executionState: 'interrupted', blocking: false, deliveryState: 'settled-or-unavailable' };

    expect(groupSubagentRuns([history, pending, effectsUnknown, uncertain, blocker] as any)).toEqual({
      blockers: [effectsUnknown, uncertain, blocker],
      pendingDelivery: [pending],
      history: [history],
    });
  });
});
