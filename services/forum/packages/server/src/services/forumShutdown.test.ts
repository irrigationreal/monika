import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSPORT_WATCHDOG_MS, createForumShutdown } from './forumShutdown';

describe('forum shutdown watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('exits nonzero at the hard deadline and suppresses later success when injected exit returns', async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => (resolveClose = resolve));
    const state = { forced: false };
    let databaseClosed = false;
    const app = {
      close: vi.fn(async () => {
        await closePromise;
        // Simulate the server onClose guard when an injected exit returns.
        if (!state.forced) databaseClosed = true;
      }),
      server: { closeAllConnections: vi.fn() },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const exit = vi.fn();
    const shutdown = createForumShutdown({ app, exit, state });

    const first = shutdown('SIGTERM');
    const repeated = shutdown('SIGINT');
    expect(repeated).toBe(first);
    expect(app.close).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TRANSPORT_WATCHDOG_MS - 1);
    expect(app.server.closeAllConnections).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(state.forced).toBe(true);
    expect(app.server.closeAllConnections).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.server.closeAllConnections.mock.invocationCallOrder[0]!).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM', watchdogMs: TRANSPORT_WATCHDOG_MS, forcedTransport: true }),
      'Forum shutdown exceeded its hard deadline; forcing transports closed and exiting nonzero'
    );

    resolveClose();
    await first;
    expect(databaseClosed).toBe(false);
    expect(exit).toHaveBeenCalledOnce();
    expect(app.log.info).not.toHaveBeenCalledWith(expect.anything(), 'Forum durable shutdown completed');
  });

  it('still exits nonzero when forced transport close throws', async () => {
    vi.useFakeTimers();
    const app = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
      server: {
        closeAllConnections: vi.fn(() => {
          throw new Error('transport close failed');
        }),
      },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const exit = vi.fn();

    void createForumShutdown({ app, exit, watchdogMs: 10 })('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs durable completion without forced transport on a graceful close', async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      server: { closeAllConnections: vi.fn() },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const exit = vi.fn();

    await createForumShutdown({ app, exit })('SIGTERM');

    expect(app.log.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ signal: 'SIGTERM', elapsedMs: expect.any(Number), forcedTransport: false }),
      'Forum durable shutdown completed'
    );
    expect(app.server.closeAllConnections).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits a real subprocess with code 1 while a finite HTTP handler remains pending', async () => {
    const shutdownModule = new URL('./forumShutdown.ts', import.meta.url).href;
    const childScript = `
        import Fastify from 'fastify';
        import { createForumShutdown } from ${JSON.stringify(shutdownModule)};

        const app = Fastify({ logger: false });
        app.get('/pending', async () => {
          console.log(JSON.stringify({ event: 'handler-started' }));
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          console.log(JSON.stringify({ event: 'handler-settled' }));
          return { ok: true };
        });
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('missing TCP address');
        const shutdown = createForumShutdown({ app, watchdogMs: 100 });
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        console.log(JSON.stringify({ event: 'listening', port: address.port }));
      `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childScript], {
      cwd: new URL('../../', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events: Array<{ event: string; port?: number }> = [];
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        events.push(JSON.parse(line) as { event: string; port?: number });
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const waitForEvent = async (name: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const event = events.find((candidate) => candidate.event === name);
        if (event) return event;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for child event ${name}; stderr=${stderr}`);
    };

    try {
      const listening = await waitForEvent('listening');
      const request = get(`http://127.0.0.1:${listening.port}/pending`);
      request.on('error', () => undefined);
      await waitForEvent('handler-started');
      child.kill('SIGTERM');

      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      expect(code).toBe(1);
      expect(signal).toBeNull();
      expect(events.some((event) => event.event === 'handler-settled')).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 10_000);
});
