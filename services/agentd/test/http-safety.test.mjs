import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { endResponse, isClientDisconnect, runAfterRequestBody, writeJson, writeSse } from '../src/http-safety.mjs';

function response(overrides = {}) {
  return {
    destroyed: false,
    writableEnded: false,
    socket: { destroyed: false },
    writeHead() {},
    end() {},
    write() { return true; },
    ...overrides,
  };
}

test('destroyed responses and reset writes are benign', () => {
  assert.equal(writeJson(response({ destroyed: true }), 200, { ok: true }), false);
  assert.equal(endResponse(response({ writableEnded: true })), false);
  assert.equal(writeSse(response({ write() { const error = new Error('aborted'); error.code = 'ECONNRESET'; throw error; } }), 'data: x\n\n'), false);
  assert.equal(isClientDisconnect({ aborted: true }, response(), new Error('aborted')), true);
});

test('ordinary response errors remain visible', () => {
  assert.throws(
    () => writeJson(response({ writeHead() { throw new Error('programming error'); } }), 200, { ok: true }),
    /programming error/,
  );
});

test('request bodies are completely consumed before entering a queued operation', async () => {
  const order = [];
  const result = await runAfterRequestBody(
    { id: 'request' },
    async () => { order.push('body'); return { message: 'hello' }; },
    async (body) => { order.push('operation'); return body.message; },
  );
  assert.equal(result, 'hello');
  assert.deepEqual(order, ['body', 'operation']);
});

test('a real HTTP socket abort makes a delayed response write safely return false', async () => {
  let resolveWrite;
  const wrote = new Promise((resolve) => { resolveWrite = resolve; });
  const server = http.createServer((req, res) => {
    req.on('aborted', () => {
      setImmediate(() => resolveWrite(writeJson(res, 200, { ok: true })));
    });
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const request = http.request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/' });
    request.on('error', () => {});
    request.write('partial-body');
    request.flushHeaders();
    setImmediate(() => request.destroy());
    assert.equal(await wrote, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
