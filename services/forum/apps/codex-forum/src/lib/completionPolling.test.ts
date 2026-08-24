import { describe, expect, it, vi } from 'vitest';

import { createCompletionPoller } from './completionPolling';

function fakeDocument() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) =>
      listeners.add(listener as () => void),
    removeEventListener: (_name: string, listener: EventListenerOrEventListenerObject) =>
      listeners.delete(listener as () => void),
    change(hidden: boolean) {
      this.hidden = hidden;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('createCompletionPoller', () => {
  it('shares the in-flight request and schedules only after completion', async () => {
    vi.useFakeTimers();
    const doc = fakeDocument();
    let resolve!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const poller = createCompletionPoller({ task, intervalMs: 5_000, document: doc as unknown as Document });
    poller.start();
    const manual = poller.refresh();
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    resolve();
    await manual;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(task).toHaveBeenCalledTimes(1);
    poller.stop();
    vi.useRealTimers();
  });

  it('forces one follow-up refresh after an older request completes', async () => {
    const doc = fakeDocument();
    let resolveCurrent!: () => void;
    const task = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolveCurrent = done;
          })
      )
      .mockResolvedValue(undefined);
    const poller = createCompletionPoller({ task, intervalMs: 5_000, document: doc as unknown as Document });

    const current = poller.refresh();
    const afterCurrent = poller.refreshAfterCurrent();
    expect(task).toHaveBeenCalledTimes(1);

    resolveCurrent();
    await current;
    await afterCurrent;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent follow-up requests behind the same older request', async () => {
    const doc = fakeDocument();
    let resolveCurrent!: () => void;
    let resolveFollowUp!: () => void;
    const task = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolveCurrent = done;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolveFollowUp = done;
          })
      );
    const poller = createCompletionPoller({ task, intervalMs: 5_000, document: doc as unknown as Document });

    const current = poller.refresh();
    const first = poller.refreshAfterCurrent();
    const second = poller.refreshAfterCurrent();
    resolveCurrent();
    await current;
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);
    resolveFollowUp();
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden, refreshes immediately when visible, and cleans up', async () => {
    vi.useFakeTimers();
    const doc = fakeDocument();
    const task = vi.fn(() => Promise.resolve());
    const poller = createCompletionPoller({ task, intervalMs: 5_000, document: doc as unknown as Document });
    poller.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    doc.change(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    doc.change(false);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);
    poller.stop();
    expect(doc.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
