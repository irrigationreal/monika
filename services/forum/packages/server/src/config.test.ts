import { describe, expect, it } from 'vitest';
import { parseRegistrationMode } from './config';

describe('parseRegistrationMode', () => {
  it('defaults to disabled when unset', () => {
    expect(parseRegistrationMode(undefined)).toBe('disabled');
    expect(parseRegistrationMode('')).toBe('disabled');
  });

  it('accepts supported registration modes', () => {
    expect(parseRegistrationMode('disabled')).toBe('disabled');
    expect(parseRegistrationMode('invite-only')).toBe('invite-only');
    expect(parseRegistrationMode('public')).toBe('public');
  });

  it('rejects unsupported registration modes', () => {
    expect(() => parseRegistrationMode('open')).toThrow(/Invalid CODEX_FORUM_REGISTRATION_MODE/);
  });
});
