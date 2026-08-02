import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { apiRoutes } from './routes';

extendZodWithOpenApi(z);

export type OpenApiBuildOptions = {
  title?: string;
  version?: string;
  serverUrl?: string;
};

export function buildOpenApiDocument(options?: OpenApiBuildOptions): unknown {
  const registry = new OpenAPIRegistry();

  for (const route of apiRoutes) {
    const contentType = route.response.contentType ?? 'application/json';
    const responseContent = {
      [contentType]: {
        schema: route.response.schema
      }
    };
    const bodyContentType = route.request?.body?.contentType ?? 'application/json';
    const requestBody =
      route.request?.body
        ? {
          required: true,
          content: {
            [bodyContentType]: {
              schema: route.request.body.schema
            }
          }
        }
        : undefined;

    registry.registerPath({
      method: route.method,
      path: route.path,
      tags: route.tags,
      summary: route.summary,
      request: {
        params: route.request?.params as never,
        query: route.request?.query as never,
        body: requestBody
      },
      responses: {
        [route.response.statusCode ?? 200]: {
          description: route.response.description ?? 'OK',
          content: responseContent
        }
      }
    });
  }

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: options?.title ?? 'Codex Forum API',
      version: options?.version ?? '0.1.0'
    },
    servers: options?.serverUrl ? [{ url: options.serverUrl }] : [{ url: '/api' }]
  });
}
