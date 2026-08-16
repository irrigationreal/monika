import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serverSource = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

function healthRouteSource() {
  const start = serverSource.indexOf('if (method === "GET" && url.pathname === "/healthz")');
  const end = serverSource.indexOf('if (method === "GET" && url.pathname === "/v1/admin/quiescence")', start);
  assert.notEqual(start, -1, 'health route must remain directly identifiable');
  assert.notEqual(end, -1, 'quiescence route must follow health route');
  return serverSource.slice(start, end);
}

test('health route is restricted to constant-time in-memory cache reads', () => {
  const route = healthRouteSource();
  const calls = [...route.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'if')
    .sort();

  assert.deepEqual(calls, [
    'activeThreadHealthCache.count',
    'json',
    'sessionOwnership.approximateLeaseCount',
    'subagentHealthCache.read',
  ]);
  assert.doesNotMatch(route, /\b(?:await|for|while)\b/);
  assert.doesNotMatch(route, /\b(?:existsSync|readFileSync|readdirSync|statSync|subagentSnapshot|scanLifecycleSnapshot|findSession|directSession|deployState)\b|\bfs\s*\./);
  assert.match(route, /build:\s*BUILD_INFO/);
});

test('lifecycle health cache is recorded only after loaded reconciliation', () => {
  const scanStart = serverSource.indexOf('async function subagentSnapshot()');
  const scanEnd = serverSource.indexOf('const subagentCancellation', scanStart);
  const reconcileStart = serverSource.indexOf('async function reconcileLoadedSubagents(snapshot)');
  const reconcileEnd = serverSource.indexOf('async function deployState()', reconcileStart);
  assert.ok(scanStart >= 0 && scanEnd > scanStart);
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart);

  const scan = serverSource.slice(scanStart, scanEnd);
  const reconciliation = serverSource.slice(reconcileStart, reconcileEnd);
  assert.doesNotMatch(scan, /subagentHealthCache\.record/);

  const merge = reconciliation.indexOf('mergeMappedLifecycleRuns');
  const loaded = reconciliation.indexOf('reconcileArtifacts');
  const record = reconciliation.indexOf('subagentHealthCache.record(snapshot)');
  assert.ok(merge >= 0 && merge < loaded && loaded < record);
});

test('build metadata is preloaded before the HTTP listener is created', () => {
  const preload = serverSource.indexOf('const BUILD_INFO = Object.freeze(loadBuildInfo());');
  const createServer = serverSource.indexOf('const server = http.createServer');
  const listen = serverSource.indexOf('server.listen(');

  assert.ok(preload >= 0 && preload < createServer && createServer < listen);
  assert.doesNotMatch(healthRouteSource(), /\bloadBuildInfo\s*\(/);
});
