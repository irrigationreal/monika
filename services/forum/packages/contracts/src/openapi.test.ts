import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi';

type OpenApiOperation = {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
};

describe('OpenAPI request bodies', () => {
  it('marks WebAuthn challenge-start empty JSON bodies as required', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, { post?: OpenApiOperation }>;
    };

    for (const path of ['/auth/webauthn/login/options', '/me/webauthn/register/options']) {
      const requestBody = document.paths[path]?.post?.requestBody;
      expect(requestBody?.required).toBe(true);
      expect(requestBody?.content?.['application/json']?.schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });
});
