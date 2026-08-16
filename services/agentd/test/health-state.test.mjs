import assert from "node:assert/strict";
import test from "node:test";

import { createActiveThreadHealthCache, createSubagentHealthCache } from "../src/health-state.mjs";
import { mergeMappedLifecycleRuns } from "../src/subagent-lifecycle.mjs";

test("active thread health count tracks transitions without registry scans", () => {
  const cache = createActiveThreadHealthCache();
  const first = { id: "first", current: null, pendingMutations: 0 };
  const second = { id: "second", current: {}, pendingMutations: 0 };

  cache.record(first);
  cache.record(second);
  assert.equal(cache.count(), 1);

  first.pendingMutations = 1;
  cache.record(first);
  second.current = null;
  cache.record(second);
  assert.equal(cache.count(), 1);

  cache.close(first);
  assert.equal(cache.count(), 0);
});

test("late events from a closed conversation cannot resurrect its active ID", () => {
  const cache = createActiveThreadHealthCache();
  const closed = { id: "shared", current: {}, pendingMutations: 0 };

  cache.record(closed);
  assert.equal(cache.count(), 1);
  cache.close(closed);
  assert.equal(cache.count(), 0);

  closed.pendingMutations = 1;
  cache.record(closed);
  closed.current = null;
  cache.record(closed);
  assert.equal(cache.count(), 0);
});

test("a new conversation object can reopen an ID without late close races", () => {
  const cache = createActiveThreadHealthCache();
  const closed = { id: "shared", current: {}, pendingMutations: 0 };
  const reopened = { id: "shared", current: {}, pendingMutations: 0 };

  cache.record(closed);
  cache.close(closed);
  cache.record(reopened);
  assert.equal(cache.count(), 1);

  // An old finalizer and event may arrive after the replacement is loaded.
  cache.close(closed);
  cache.record(closed);
  assert.equal(cache.count(), 1);

  reopened.current = null;
  cache.record(reopened);
  assert.equal(cache.count(), 0);
});

test("health lifecycle summary is a synchronous conservative cache read", () => {
  let now = 1_000;
  const cache = createSubagentHealthCache({ now: () => now });

  assert.deepEqual(cache.read(), {
    active_count: 1,
    uncertain_count: 1,
    effects_unknown_count: 0,
    freshness: {
      source: "not_yet_scanned",
      scanned_at_ms: null,
      age_ms: null,
    },
  });

  cache.record({
    active_count: 2,
    uncertain_count: 1,
    effects_unknown_count: 3,
  });
  now = 1_275;
  assert.deepEqual(cache.read(), {
    active_count: 2,
    uncertain_count: 1,
    effects_unknown_count: 3,
    freshness: {
      source: "last_successful_scan",
      scanned_at_ms: 1_000,
      age_ms: 275,
    },
  });
});

test("fresh lifecycle health counts include merge-added fail-closed blockers", () => {
  const cache = createSubagentHealthCache({ now: () => 99 });
  const snapshot = {
    runs: [],
    byId: new Map(),
    byDir: new Map(),
    active_count: 0,
    uncertain_count: 0,
    effects_unknown_count: 0,
  };
  const conversation = {
    subagents: {
      runs: new Map([["missing", {
        runId: "missing",
        sessionId: "parent",
        asyncDir: "/missing-lifecycle-artifact",
      }]]),
    },
  };

  mergeMappedLifecycleRuns(snapshot, [conversation]);
  cache.record(snapshot);

  assert.deepEqual(cache.read(), {
    active_count: 1,
    uncertain_count: 1,
    effects_unknown_count: 0,
    freshness: {
      source: "last_successful_scan",
      scanned_at_ms: 99,
      age_ms: 0,
    },
  });
});

test("invalid lifecycle counts retain fail-safe health diagnostics", () => {
  const cache = createSubagentHealthCache({ now: () => 42 });
  cache.record({ active_count: Number.NaN, uncertain_count: -1 });

  assert.deepEqual(cache.read(), {
    active_count: 1,
    uncertain_count: 1,
    effects_unknown_count: 0,
    freshness: {
      source: "last_successful_scan",
      scanned_at_ms: 42,
      age_ms: 0,
    },
  });
});
