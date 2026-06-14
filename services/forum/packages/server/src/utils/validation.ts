import type { FastifyInstance } from 'fastify';

type ZodIssue = { message?: string };
type ZodErrorLike = { issues?: ZodIssue[]; message?: string };
type ZodSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodErrorLike };

type ZodSchemaLike<T> = {
  safeParse: (data: unknown) => ZodSafeParseResult<T>;
};

export function parseBody<T>(app: FastifyInstance, schema: ZodSchemaLike<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error?.issues?.[0]?.message ?? result.error?.message ?? 'Invalid request body';
    throw app.httpErrors.badRequest(message);
  }
  return result.data;
}
