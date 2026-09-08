import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { subagentRunBlocker } from "../src/deploy-blockers.mjs";

const serverSource = readFileSync(
  new URL("../src/server.mjs", import.meta.url),
  "utf8",
);

function run(index, overrides = {}) {
  return {
    run_key: `top:run-${String(index).padStart(2, "0")}`,
    run_id: `run-${String(index).padStart(2, "0")}`,
    execution_state: "active",
    effects_state: "known",
    blocking: true,
    lifecycle_artifact_version: 5,
    async_dir: `/secret/run-${index}`,
    task: `sensitive task ${index}`,
    output: `sensitive output ${index}`,
    ...overrides,
  };
}

test("active subagent blocker exposes deterministic capped opaque run identities", () => {
  const runs = Array.from({ length: 25 }, (_, index) => run(24 - index));
  const blocker = subagentRunBlocker(
    "active_subagent_runs",
    runs,
    25,
    (item) => item.blocking,
  );

  assert.deepEqual(
    {
      code: blocker.code,
      count: blocker.count,
      item_limit: blocker.item_limit,
      truncated: blocker.truncated,
      omitted_count: blocker.omitted_count,
    },
    {
      code: "active_subagent_runs",
      count: 25,
      item_limit: 20,
      truncated: true,
      omitted_count: 5,
    },
  );
  assert.equal(blocker.items.length, 20);
  assert.deepEqual(
    blocker.items.map((item) => item.run_key),
    [...blocker.items.map((item) => item.run_key)].sort(),
  );
  assert.deepEqual(Object.keys(blocker.items[0]).sort(), [
    "effects_state",
    "execution_state",
    "run_id",
    "run_key",
  ]);
  assert.doesNotMatch(JSON.stringify(blocker), /secret|sensitive/);
});

test("legacy active run preserves an unclassified effects state", () => {
  const blocker = subagentRunBlocker(
    "active_subagent_runs",
    [run(0, { lifecycle_artifact_version: 3, effects_state: null })],
    1,
    (item) => item.blocking,
  );

  assert.equal(blocker.items[0].effects_state, null);
});

test("agentd quiescence route wires bounded subagent diagnostics into deploy state", () => {
  const deployStart = serverSource.indexOf("async function deployState()");
  const deployEnd = serverSource.indexOf(
    "async function closeIdleConversations",
    deployStart,
  );
  const deployStateSource = serverSource.slice(deployStart, deployEnd);
  const routeStart = serverSource.indexOf(
    'if (method === "GET" && url.pathname === "/v1/admin/quiescence")',
  );
  const routeSource = serverSource.slice(routeStart, routeStart + 180);

  assert.ok(
    deployStart >= 0 && deployEnd > deployStart,
    "deployState source boundary must remain extractable",
  );
  assert.match(routeSource, /json\(res, 200, await deployState\(\)\)/);
  assert.match(
    deployStateSource,
    /subagentRunBlocker\(\s*"active_subagent_runs"/,
  );
  assert.match(
    deployStateSource,
    /subagentRunBlocker\(\s*"subagent_effects_unknown"/,
  );
  assert.match(deployStateSource, /blockers,\s*drain_required: drainRequired/);
});

test("effects-unknown blocker identifies terminal as well as active runs and preserves aggregate metadata", () => {
  const runs = [
    run(2, {
      blocking: false,
      execution_state: "terminal",
      effects_state: "unknown",
    }),
    run(1, { effects_state: "unknown" }),
    run(0, { effects_state: "known" }),
  ];
  const blocker = subagentRunBlocker(
    "subagent_effects_unknown",
    runs,
    2,
    (item) =>
      item.lifecycle_artifact_version >= 4 && item.effects_state === "unknown",
  );

  assert.equal(blocker.count, 2);
  assert.equal(blocker.truncated, false);
  assert.equal(blocker.omitted_count, 0);
  assert.deepEqual(
    blocker.items.map((item) => item.run_id),
    ["run-01", "run-02"],
  );
  assert.deepEqual(
    blocker.items.map((item) => item.execution_state),
    ["active", "terminal"],
  );
  assert.ok(blocker.items.every((item) => item.effects_state === "unknown"));
});
