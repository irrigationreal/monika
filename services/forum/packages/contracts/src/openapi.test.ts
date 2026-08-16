import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi';

type OpenApiOperation = {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
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

  it('documents multipart file parts as binary and preserves user-file options', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, { post?: OpenApiOperation }>;
    };

    const userFileSchema = document.paths['/user-files']?.post?.requestBody?.content?.['multipart/form-data']?.schema;
    expect(userFileSchema).toMatchObject({
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        visibility: { type: 'string', enum: ['private', 'members', 'public'] },
        expiration: { type: 'string' },
      },
    });
    expect(
      document.paths['/posts/{postId}/attachments']?.post?.requestBody?.content?.['multipart/form-data']?.schema
    ).toMatchObject({
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    });
  });

  it('preserves the legacy user-file array and documents the additive paginated endpoint', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, { get?: OpenApiOperation }>;
    };

    expect(document.paths['/user-files']?.get?.responses?.['200']?.content?.['application/json']?.schema).toMatchObject(
      {
        type: 'array',
      }
    );
    expect(
      document.paths['/user-files/page']?.get?.responses?.['200']?.content?.['application/json']?.schema
    ).toMatchObject({
      type: 'object',
      required: ['items', 'nextCursor'],
      properties: { items: { type: 'array' } },
    });
  });

  it('documents the authenticated Quick Reply preference request and response', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, { patch?: OpenApiOperation }>;
    };
    const operation = document.paths['/me/preferences/quick-reply']?.patch;

    expect(operation?.requestBody?.required).toBe(true);
    expect(operation?.requestBody?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      required: ['desktopMode', 'mobileMode'],
      properties: {
        desktopMode: { type: 'string', enum: ['inline', 'docked'] },
        mobileMode: { type: 'string', enum: ['inline', 'docked'] },
      },
    });
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      required: ['ok', 'desktopMode', 'mobileMode'],
      properties: {
        ok: { type: 'boolean' },
        desktopMode: { type: 'string', enum: ['inline', 'docked'] },
        mobileMode: { type: 'string', enum: ['inline', 'docked'] },
      },
    });
  });
});
