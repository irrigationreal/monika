import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DISPATCH_NOT_ACCEPTED,
  DISPATCH_SAFE_RETRY,
  DispatchNotAcceptedError,
  notAcceptedBody,
} from '../src/dispatch-acceptance.mjs';

const serverSource = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('dispatch acceptance markers distinguish terminal and explicitly safe retry', () => {
  const original = { error: 'internal_error', message: 'initialization failed' };
  assert.deepEqual(notAcceptedBody(original), {
    ...original,
    dispatch_acceptance: DISPATCH_NOT_ACCEPTED,
  });
  assert.deepEqual(notAcceptedBody(original, { safeRetry: true }), {
    ...original,
    dispatch_acceptance: DISPATCH_NOT_ACCEPTED,
    dispatch_retry: DISPATCH_SAFE_RETRY,
  });
  assert.equal(original.dispatch_acceptance, undefined);
  assert.equal(new DispatchNotAcceptedError(new Error('failed')).cause.message, 'failed');
});

test('message route wires HTTP success behind the behavioral preflight gate', () => {
  const messageStart = serverSource.indexOf("if (method === 'POST' && tail === 'messages')");
  const messageEnd = serverSource.indexOf("if (method === 'POST' && tail === 'interrupt')", messageStart);
  assert.ok(messageStart >= 0 && messageEnd > messageStart);
  const route = serverSource.slice(messageStart, messageEnd);
  assert.match(route, /createDispatchPreflightGate\(/);
  assert.match(route, /await preflight\.accepted/);
  assert.ok(route.indexOf('await preflight.accepted') < route.lastIndexOf('return json(res, 200'));
  assert.match(route, /throw new DispatchNotAcceptedError\(error\)/);
});

test('post-acceptance failures retain markerless asynchronous handling', () => {
  const messageStart = serverSource.indexOf("if (method === 'POST' && tail === 'messages')");
  const messageEnd = serverSource.indexOf("if (method === 'POST' && tail === 'interrupt')", messageStart);
  const route = serverSource.slice(messageStart, messageEnd);
  assert.ok(route.indexOf('await preflight.accepted') < route.indexOf('void (async () =>'));
  assert.match(route, /await promptPromise/);
  assert.match(route, /emit\(conv, 'turn_error'/);
});
