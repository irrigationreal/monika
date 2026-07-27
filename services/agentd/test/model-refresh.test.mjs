import assert from 'node:assert/strict';
import test from 'node:test';

import { modelRefreshIntervalMs, startModelCatalogRefresh } from '../src/model-refresh.mjs';

test('model refresh interval defaults, validates, and supports disabling', () => {
  assert.equal(modelRefreshIntervalMs(undefined), 4 * 60 * 60 * 1000);
  assert.equal(modelRefreshIntervalMs('0'), 0);
  assert.equal(modelRefreshIntervalMs('1234'), 1234);
  assert.equal(modelRefreshIntervalMs('-1'), 4 * 60 * 60 * 1000);
  assert.equal(modelRefreshIntervalMs('nope'), 4 * 60 * 60 * 1000);
});

test('disabled catalog refresh does not touch the runtime', async () => {
  let calls = 0;
  const control = startModelCatalogRefresh(Promise.resolve({
    async refresh() { calls += 1; },
  }), { intervalMs: 0 });

  await control.refresh();
  assert.equal(calls, 0);
});

test('catalog refresh starts in background, is bounded and coalesces overlap', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback;
  let unrefCalled = false;
  let resolveRefresh;
  let calls = 0;
  const warnings = [];
  const refreshed = [];

  globalThis.setInterval = (callback, ms) => {
    assert.equal(ms, 42);
    intervalCallback = callback;
    return { unref() { unrefCalled = true; } };
  };
  globalThis.clearInterval = () => {};

  try {
    const runtime = {
      refresh(options) {
        calls += 1;
        assert.equal(options.allowNetwork, true);
        assert.ok(options.signal instanceof AbortSignal);
        return new Promise((resolve) => { resolveRefresh = resolve; });
      },
    };
    const control = startModelCatalogRefresh(Promise.resolve(runtime), {
      intervalMs: 42,
      timeoutMs: 1000,
      logger: { warn(message) { warnings.push(message); } },
      onRefresh(_runtime, result) { refreshed.push(result); },
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(unrefCalled, true);

    const first = control.refresh();
    intervalCallback();
    assert.equal(calls, 1);

    const result = { aborted: false, errors: new Map([['pi.dev', new Error('offline')]]) };
    resolveRefresh(result);
    assert.equal(await first, result);
    assert.deepEqual(refreshed, [result]);
    assert.match(warnings[0], /pi\.dev.*keeping cached catalog.*offline/);
    control.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
