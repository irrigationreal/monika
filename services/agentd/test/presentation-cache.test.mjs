import assert from "node:assert/strict";
import test from "node:test";
import { PresentationDtoCache } from "../src/presentation-cache.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("presentation cache handles cold, fresh, stale, and expired reads", async () => {
  let now = 0;
  let calls = 0;
  const refresh = deferred();
  const cache = new PresentationDtoCache({ ttlMs: 10, staleMs: 30, now: () => now });
  const first = await cache.get(async () => ({ version: ++calls }));
  assert.deepEqual(first, { version: 1 });
  assert.equal(await cache.get(async () => ({ version: ++calls })), first);
  assert.equal(calls, 1);

  now = 20;
  assert.equal(await cache.get(async () => { calls += 1; return refresh.promise; }), first);
  assert.equal(calls, 2);
  refresh.resolve({ version: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cache.get(async () => ({ version: ++calls })), { version: 2 });

  now = 100;
  const expired = await cache.get(async () => ({ version: ++calls }));
  assert.deepEqual(expired, { version: 3 });
});

test("presentation cache coalesces cold reads and stores an immutable JSON copy", async () => {
  const pending = deferred();
  let calls = 0;
  const source = { nested: { count: 1 } };
  const cache = new PresentationDtoCache({ ttlMs: 10, staleMs: 30 });
  const one = cache.get(async () => { calls += 1; await pending.promise; return source; });
  const two = cache.get(async () => { calls += 1; return source; });
  assert.equal(calls, 0);
  pending.resolve();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  source.nested.count = 9;
  assert.equal(a.nested.count, 1);
  assert.equal(Object.isFrozen(a.nested), true);
});

test("clear detaches an old in-flight presentation refresh", async () => {
  const pending = deferred();
  const cache = new PresentationDtoCache({ ttlMs: 10, staleMs: 30 });
  const oldRead = cache.get(async () => pending.promise);
  await new Promise((resolve) => setImmediate(resolve));
  cache.clear();
  const newRead = cache.get(async () => ({ version: 2 }));
  pending.resolve({ version: 1 });
  assert.deepEqual(await newRead, { version: 2 });
  assert.deepEqual(await oldRead, { version: 1 });
  assert.deepEqual(await cache.get(async () => ({ version: 3 })), { version: 2 });
});

test("failed stale refresh preserves the bounded stale value", async () => {
  let now = 0;
  const cache = new PresentationDtoCache({ ttlMs: 10, staleMs: 30, now: () => now });
  const value = await cache.get(async () => ({ ok: true }));
  now = 20;
  assert.equal(await cache.get(async () => { throw new Error("scan failed"); }), value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.get(async () => { throw new Error("scan failed"); }), value);
});
