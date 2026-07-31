import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('test runner uses isolated subagent runtime, session, and runtime-instance roots', () => {
  const tmp = path.resolve(os.tmpdir());
  for (const name of ['PI_SUBAGENT_RUNTIME_ROOT', 'PI_SUBAGENT_SESSION_ROOT', 'PI_SUBAGENT_OPERATOR_ROOT', 'MONIKA_RUNTIME_INSTANCE_FILE']) {
    const value = process.env[name];
    assert.ok(value, `${name} must be explicit in tests`);
    const resolved = path.resolve(value);
    assert.ok(resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`), `${name} must be under the temporary root`);
    assert.notEqual(resolved, '/data/pi-subagents');
  }
});
