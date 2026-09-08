import { describe, expect, it, vi } from 'vitest';

import { EchsClient } from './echsClient';

describe('EchsClient clone contract', () => {
  it('uses distinct encoded snapshot, clone, and acknowledgement routes', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const snapshot = { leaf_entry_id: 'leaf-1', active_entry_ids: ['user-1', 'leaf-1'] };
    const result = {
      child_session_id: 'child',
      child_session_path: '/pi/child.jsonl',
      inherited_generation: 3,
      active_entry_ids: ['user-1', 'leaf-1', 'lineage'],
    };
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(result);

    await expect(client.getCloneSnapshot('conversation/1')).resolves.toEqual(snapshot);
    await expect(
      client.cloneConversation('conversation/1', { operationId: 'clone-one', expectedLeafId: 'leaf-1' })
    ).resolves.toEqual(result);
    expect(request).toHaveBeenNthCalledWith(1, '/v1/conversations/conversation%2F1/clone-snapshot');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/conversations/conversation%2F1/clone', {
      method: 'POST',
      body: { operation_id: 'clone-one', expected_leaf_id: 'leaf-1' },
      timeoutMs: 10 * 60_000,
    });

    request.mockResolvedValueOnce({ acknowledged: true });
    await client.acknowledgeForumClone('clone/one', 'child');
    expect(request).toHaveBeenNthCalledWith(3, '/v1/forum-clones/clone%2Fone/ack', {
      method: 'POST',
      body: { child_session_id: 'child' },
    });
  });
});
