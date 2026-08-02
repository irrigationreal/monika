import type { ErrorCode } from '@irrigationreal/codex-forum-contracts';
import type { FastifyInstance } from 'fastify';

function apiErrorCode(statusCode: number, hasValidationErrors: boolean): ErrorCode {
  if (hasValidationErrors) return 'validation_error';

  switch (statusCode) {
    case 400:
      return 'validation_error';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'internal_error';
  }
}

export function registerApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const errObj = error as unknown as Record<string, unknown>;
    const statusCode = typeof errObj['statusCode'] === 'number' ? errObj['statusCode'] : 500;
    const code = apiErrorCode(statusCode, Boolean(errObj['validation']));
    if (statusCode >= 500) {
      app.log.error(error);
    }
    reply.status(statusCode).send({
      code,
      message: error instanceof Error ? error.message : String(error),
      details: errObj['validation'] ? { validation: errObj['validation'] } : undefined,
    });
  });
}
