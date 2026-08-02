import { describe, expect, it, vi } from 'vitest';

import { MemoryTokenStorage, createForumSdk } from './index';

describe('SDK empty JSON POST requests', () => {
  it('sends an explicit empty JSON object for challenge starts and other bodyless POSTs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ challengeId: 'challenge-1', options: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const sdk = createForumSdk({ baseUrl: 'https://forum.example/api', fetch: fetchImpl });

    await sdk.api.webauthnLoginOptions();
    await sdk.api.webauthnRegistrationOptions();
    await sdk.api.logout();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });
});

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
