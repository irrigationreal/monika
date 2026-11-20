import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { reportRuntimeDiagnostics } from '../src/runtime-diagnostics.mjs';

test('SDK diagnostics and fallback warnings are logged once per runtime without public events', () => {
  const runtime = new AgentSessionRuntime({}, {}, () => {}, [
    { type: 'error', message: 'extension failed\n\x1b[31mprivate\u2028path\u2029' },
    { type: 'warning', message: 'x'.repeat(10_000) },
  ], 'Could not restore model; using fallback');
  const lines = [];
  reportRuntimeDiagnostics(runtime, line => lines.push(line));
  reportRuntimeDiagnostics(runtime, line => lines.push(line));
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(line)));
  assert.ok(lines.every(line => line.length < 4200));
  assert.match(lines[0], /Pi runtime error: extension failed/);
  assert.match(lines[2], /Could not restore model/);
  // A separate runtime still reports the same warning for its own operator.
  reportRuntimeDiagnostics(new AgentSessionRuntime({}, {}, () => {}, [
    { type: 'error', message: 'another extension failed' },
  ]), line => lines.push(line));
  assert.equal(lines.length, 4);
});
