import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchsClient } from './echsClient';

describe('secret broker configuration errors', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('passes the configured service token, never browser credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid', apiToken: 'synthetic-service-token' });
    await client.putSecret('synthetic-id', { value: 'synthetic-value', name: 'Example', tags: [], expiresAt: null, enabled: true });
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer synthetic-service-token');
  });
  it('explains internal 401 without suggesting browser reauthentication', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 })));
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    await expect(client.disableSecret('id')).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('Signing in again will not fix this') });
  });
  it('reports missing encryption configuration as a service problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'secret_store_unconfigured' }, { status: 503 })));
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    await expect(client.deleteSecret('id')).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('encryption-key') });
  });
});
