import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { SseLifecycleRegistry } from './sseLifecycle';

import type { ServerResponse } from 'node:http';

class FakeResponse extends EventEmitter {
  end = vi.fn(() => this.emit('finish'));
  destroy = vi.fn(() => this.emit('close'));
}

describe('SseLifecycleRegistry', () => {
  it.each(['finish', 'close', 'error'] as const)('uses response %s as idempotent authoritative cleanup', (event) => {
    const registry = new SseLifecycleRegistry();
    const response = new FakeResponse();
    const cleanup = vi.fn();
    expect(registry.register(response as unknown as ServerResponse, cleanup)).toBe(true);

    response.emit(event, event === 'error' ? new Error('broken') : undefined);
    response.emit('close');
    response.emit('finish');

    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('runs cleanup synchronously before ending responses and reports active/closed counts', () => {
    const registry = new SseLifecycleRegistry();
    const order: string[] = [];
    const response = new FakeResponse();
    response.end.mockImplementation(() => {
      order.push('end');
      response.emit('finish');
    });
    registry.register(response as unknown as ServerResponse, () => order.push('cleanup'));

    expect(registry.counts).toEqual({ active: 1, closed: 0 });
    expect(registry.closeAll()).toEqual({ active: 0, closed: 1 });
    registry.closeAll();

    expect(order).toEqual(['cleanup', 'end']);
    expect(response.end).toHaveBeenCalledOnce();
    expect(registry.isAccepting).toBe(false);
    expect(registry.register(new FakeResponse() as unknown as ServerResponse, vi.fn())).toBe(false);
  });

  it('isolates broken cleanup and response close operations', () => {
    const registry = new SseLifecycleRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const brokenCleanup = new FakeResponse();
    const brokenEnd = new FakeResponse();
    brokenEnd.end.mockImplementation(() => {
      throw new Error('end failed');
    });
    brokenEnd.destroy.mockImplementation(() => {
      throw new Error('destroy failed');
    });
    const healthy = new FakeResponse();
    const healthyCleanup = vi.fn();

    registry.register(brokenCleanup as unknown as ServerResponse, () => {
      throw new Error('cleanup failed');
    });
    registry.register(brokenEnd as unknown as ServerResponse, vi.fn());
    registry.register(healthy as unknown as ServerResponse, healthyCleanup);

    expect(() => registry.closeAll()).not.toThrow();
    expect(healthyCleanup).toHaveBeenCalledOnce();
    expect(healthy.end).toHaveBeenCalledOnce();
    expect(registry.counts).toEqual({ active: 0, closed: 3 });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
