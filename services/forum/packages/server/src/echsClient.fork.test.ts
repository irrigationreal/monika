import { describe, expect, it, vi } from 'vitest';

import { EchsClient } from './echsClient';

describe('EchsClient fork boundary contract', () => {
  it('requests the atomic canonical fork-boundary snapshot', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const snapshot = {
      leaf_entry_id: 'leaf-1',
      active_entry_ids: ['user-1', 'assistant-1', 'user-2'],
      eligible_boundary_entry_ids: ['user-2'],
    };
    const request = vi.spyOn(client as any, 'request').mockResolvedValue(snapshot);

    await expect(client.getForkBoundarySnapshot('conversation/1')).resolves.toEqual(snapshot);
    expect(request).toHaveBeenCalledWith('/v1/conversations/conversation%2F1/fork-boundaries');
  });
});
