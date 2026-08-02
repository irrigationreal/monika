import { describe, expect, it, vi } from 'vitest';

import { createForumSdk, MemoryTokenStorage } from './index';

describe('SDK stream authentication', () => {
  it('requires a custom authorization-capable SSE transport for explicit bearer credentials', () => {
    const storage = new MemoryTokenStorage();
    storage.setAuthToken('cfk_secret');
    const sdk = createForumSdk({ baseUrl: 'https://forum.example/api', storage });

    expect(() => sdk.createStateStream('topic-1')).toThrow(/authorization-capable custom eventSourceFactory/);
  });

  it('never adds an explicit bearer credential to a stream URL', () => {
    const storage = new MemoryTokenStorage();
    storage.setAuthToken('cfk_secret');
    const stream = {} as EventSource;
    const eventSourceFactory = vi.fn((_url: string) => stream);
    const sdk = createForumSdk({ baseUrl: 'https://forum.example/api', storage, eventSourceFactory });

    expect(sdk.createNotificationStream()).toBe(stream);
    expect(eventSourceFactory).toHaveBeenCalledWith('https://forum.example/api/notifications/stream');
    expect(eventSourceFactory.mock.calls[0]?.[0]).not.toContain('cfk_secret');
  });
});
