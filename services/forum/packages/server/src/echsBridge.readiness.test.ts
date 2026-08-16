import { describe, expect, it, vi } from 'vitest';

import { EchsBridge } from './echsBridge';

describe('agentd readiness', () => {
  function bridge() {
    return new EchsBridge({} as any, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
  }

  it.each([
    [{ ok: true, status: 'healthy' }, true],
    [{ ok: true, status: 'draining' }, false],
    [null, false],
  ] as const)('maps health %j to readiness %s', async (health, expected) => {
    const subject = bridge();
    vi.spyOn((subject as any).client, 'checkHealth').mockResolvedValue(health);
    await expect(subject.checkReadiness()).resolves.toBe(expected);
  });
});
