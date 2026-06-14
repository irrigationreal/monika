import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  'validation_error',
  'rate_limited',
  'internal_error'
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional()
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
