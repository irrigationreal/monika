import { describe, expect, it, vi } from 'vitest';

import { EchsBridge, selectTopicContext } from './echsBridge';

describe('ECHS context snapshots', () => {
  it('prefers a measured live estimate over older historical usage', () => {
    const live = { usedTokens: 52_000, exact: false, source: 'pi-runtime-estimate' };
    const historical = { usedTokens: 41_000, exact: true, source: 'pi-usage' };
    expect(selectTopicContext(live, historical)).toBe(live);
  });

  it('falls back to historical usage when the live runtime has no measurement', () => {
    const live = { usedTokens: null, exact: false, source: 'unavailable' };
    const historical = { usedTokens: 41_000, exact: true, source: 'pi-usage' };
    expect(selectTopicContext(live, historical)).toBe(historical);
  });

  it('falls back to the canonical export when the loaded conversation lookup fails', async () => {
    const store = {
      getSessionByTopic: vi.fn(() => ({ agent_thread_id: 'conversation-1' })),
      getPiSessionLinkByTopic: vi.fn(() => ({ pi_session_id: 'pi-session-1' })),
    };
    const bridge = new EchsBridge(store as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const historical = { usedTokens: 41_000, exact: true, source: 'pi-usage' };
    vi.spyOn((bridge as any).client, 'getConversationContext').mockRejectedValue(new Error('offline'));
    vi.spyOn((bridge as any).client, 'getPiSessionContext').mockResolvedValue({ context: historical });

    await expect(bridge.getTopicContext('topic-1')).resolves.toBe(historical);
  });

  it('emits a dedicated update and suppresses transient refresh failures', async () => {
    const bus = { emit: vi.fn(), subscribe: vi.fn() };
    const bridge = new EchsBridge({} as any, bus as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const context = { usedTokens: 52_000, exact: false };
    vi.spyOn(bridge, 'getTopicContext').mockResolvedValueOnce(context).mockRejectedValueOnce(new Error('offline'));

    await (bridge as any).emitContext('topic-1');
    await (bridge as any).emitContext('topic-1');

    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith('topic-1', { type: 'context_updated', data: context });
  });
});
