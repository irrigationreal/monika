import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerApiErrorHandler } from './apiErrorHandler';

describe('API error handler', () => {
  it('classifies unsupported media types without presenting them as internal failures', async () => {
    const app = Fastify();
    registerApiErrorHandler(app);
    app.post('/json', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/x-unsupported' },
      payload: 'not-json',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      code: 'unsupported_media_type',
      message: 'Unsupported Media Type',
    });
    await app.close();
  });
});
