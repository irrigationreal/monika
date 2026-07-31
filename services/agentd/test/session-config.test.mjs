import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAutoCompactionOverride,
  requestedAutoCompaction,
} from "../src/session-config.mjs";

test("accepts only explicit boolean auto-compaction configuration", () => {
  assert.equal(requestedAutoCompaction({}), null);
  assert.equal(requestedAutoCompaction({ auto_compact: true }), true);
  assert.equal(requestedAutoCompaction({ autoCompact: false }), false);
  assert.throws(
    () => requestedAutoCompaction({ auto_compact: "true" }),
    /must be a boolean/,
  );
});

test("applies a runtime override without invoking persistence setters", () => {
  const calls = [];
  const settingsManager = {
    applyOverrides: (value) => calls.push(value),
    setCompactionEnabled: () =>
      assert.fail("must not persist the global setting"),
  };

  assert.equal(
    applyAutoCompactionOverride(settingsManager, { auto_compact: true }),
    true,
  );
  assert.deepEqual(calls, [{ compaction: { enabled: true } }]);
  assert.equal(applyAutoCompactionOverride(settingsManager, {}), null);
  assert.equal(calls.length, 1);
});
