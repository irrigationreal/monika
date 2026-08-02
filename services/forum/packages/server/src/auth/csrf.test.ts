import { describe, expect, it } from 'vitest';

import { assertCorsCredentialsConfiguration, isTrustedCookieRequest } from './csrf';

const cookieAuth = { identityId: 'user', authType: 'session' as const, authSource: 'cookie' as const, scopes: null };

describe('cookie CSRF origin policy', () => {
  it('requires an exact trusted origin for unsafe cookie-authenticated requests', () => {
    expect(
      isTrustedCookieRequest({
        method: 'POST',
        origin: 'https://forum.example',
        trustedOrigin: 'https://forum.example',
        auth: cookieAuth,
      })
    ).toBe(true);
    expect(
      isTrustedCookieRequest({
        method: 'POST',
        origin: undefined,
        trustedOrigin: 'https://forum.example',
        auth: cookieAuth,
      })
    ).toBe(false);
    expect(
      isTrustedCookieRequest({
        method: 'DELETE',
        origin: 'https://forum.example.evil',
        trustedOrigin: 'https://forum.example',
        auth: cookieAuth,
      })
    ).toBe(false);
  });

  it('rejects every mismatched supplied unsafe Origin, including login and explicit automation', () => {
    expect(
      isTrustedCookieRequest({
        method: 'POST',
        origin: 'https://evil.example',
        trustedOrigin: 'https://forum.example',
        auth: null,
      })
    ).toBe(false);
    expect(
      isTrustedCookieRequest({
        method: 'POST',
        origin: 'https://evil.example',
        trustedOrigin: 'https://forum.example',
        auth: { ...cookieAuth, authType: 'apiKey', authSource: 'authorization' },
      })
    ).toBe(false);
  });

  it('does not block safe methods or originless explicit automation credentials', () => {
    expect(
      isTrustedCookieRequest({
        method: 'GET',
        origin: undefined,
        trustedOrigin: 'https://forum.example',
        auth: cookieAuth,
      })
    ).toBe(true);
    expect(
      isTrustedCookieRequest({
        method: 'POST',
        origin: undefined,
        trustedOrigin: 'https://forum.example',
        auth: { ...cookieAuth, authType: 'apiKey', authSource: 'authorization' },
      })
    ).toBe(true);
  });

  it('fails configuration when credentialed CORS has no explicit allowlist', () => {
    expect(() => assertCorsCredentialsConfiguration(null, true)).toThrow(/requires an explicit/);
    expect(() => assertCorsCredentialsConfiguration([], true)).toThrow(/requires an explicit/);
    expect(() => assertCorsCredentialsConfiguration(['*'], true)).toThrow(/requires an explicit/);
    expect(() => assertCorsCredentialsConfiguration(['https://app.example'], true)).not.toThrow();
    expect(() => assertCorsCredentialsConfiguration(null, false)).not.toThrow();
  });
});
