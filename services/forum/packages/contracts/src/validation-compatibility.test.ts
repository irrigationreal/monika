import { describe, expect, it } from 'vitest';

import { ApiErrorSchema } from './errors';
import {
  CreateApiKeyRequestSchema,
  LoginRequestSchema,
  NotepadListQuerySchema,
  UpdatePrivateEmailRequestSchema,
} from './schemas';

describe('Zod boundary compatibility', () => {
  it('preserves explicit missing-field and empty-string messages', () => {
    for (const input of [{}, { username: '', password: '' }]) {
      const result = LoginRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toBe('username and password are required');
    }
    const result = CreateApiKeyRequestSchema.safeParse({ label: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('label is required');
  });

  it('does not report present values of the wrong type as missing', () => {
    const result = LoginRequestSchema.safeParse({ username: 123, password: 'password' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('invalid_type');
      expect(result.error.issues[0]?.message).not.toBe('username and password are required');
    }
  });

  it('preserves nullable, optional, coercion, and strict-object boundaries', () => {
    expect(UpdatePrivateEmailRequestSchema.parse({ emailAddress: null })).toEqual({ emailAddress: null });
    expect(UpdatePrivateEmailRequestSchema.safeParse({}).success).toBe(false);
    expect(NotepadListQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(NotepadListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(NotepadListQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('keeps free-form error details as a string-keyed record, not a fixed object', () => {
    const input = { code: 'validation_error', message: 'Invalid request', details: { count: 2, nested: { ok: true } } };
    expect(ApiErrorSchema.parse(input)).toEqual(input);
    expect(ApiErrorSchema.parse({ code: 'not_found', message: 'Missing' })).toEqual({
      code: 'not_found',
      message: 'Missing',
    });
  });
});
