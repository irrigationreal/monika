import { afterEach, describe, expect, it, vi } from 'vitest';

import { EchsClient, EchsDispatchNotAcceptedError, EchsTransportError } from './echsClient';

describe('EchsClient transport errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('types connection failures and 5xx responses as ambiguous transport outages', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.getSubagentWorkload()).rejects.toBeInstanceOf(EchsTransportError);
    await expect(client.getSubagentWorkload()).rejects.toMatchObject({
      name: 'EchsTransportError',
      retryable: true,
      status: 503,
    });
  });

  it('types a marked pre-acceptance failure separately even when it is 5xx', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'internal_error', dispatch_acceptance: 'not_accepted' }, { status: 500 })
        )
    );

    const error = await client.getSubagentWorkload().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EchsDispatchNotAcceptedError);
    expect(error).toMatchObject({ status: 500, retryable: false });
    expect(error).not.toBeInstanceOf(EchsTransportError);
  });

  it('retains only the explicit safe-retry marker on a not-accepted error', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: 'unavailable', dispatch_acceptance: 'not_accepted', dispatch_retry: 'safe' },
            { status: 503 }
          )
        )
    );

    await expect(client.getSubagentWorkload()).rejects.toMatchObject({
      name: 'EchsDispatchNotAcceptedError',
      retryable: true,
      safeRetry: true,
      status: 503,
    });
  });

  it('keeps an unmarked 5xx ambiguous even when its payload resembles a dispatch error', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'internal_error' }, { status: 500 })));

    await expect(client.getSubagentWorkload()).rejects.toBeInstanceOf(EchsTransportError);
  });

  it('keeps definite 4xx application rejection distinct from transport outage', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"conflict"}', { status: 409 })));

    const error = await client.getSubagentWorkload().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409 });
    expect(error).not.toBeInstanceOf(EchsTransportError);
  });

  it('accepts lightweight health with cached lifecycle diagnostics', async () => {
    const client = new EchsClient({ baseUrl: 'http://agentd.invalid' });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        status: 'healthy',
        queue_depth: 0,
        active_threads: 1,
        active_subagent_runs: 2,
        subagent_lifecycle_freshness: {
          source: 'last_successful_scan',
          scanned_at_ms: 1_000,
          age_ms: 16_500,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.checkHealth()).resolves.toEqual({
      ok: true,
      status: 'healthy',
      queue_depth: 0,
      active_threads: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://agentd.invalid/healthz',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) })
    );
  });
});
