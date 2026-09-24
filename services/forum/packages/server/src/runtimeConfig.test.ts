import { describe, expect, it } from 'vitest';
import { parseTrustProxyValue } from './runtimeConfig';

describe('parseTrustProxyValue', () => {
  it('keeps proxy trust disabled by default', () => {
    expect(parseTrustProxyValue(undefined)).toBe(false);
    expect(parseTrustProxyValue('')).toBe(false);
    expect(parseTrustProxyValue('0')).toBe(false);
    expect(parseTrustProxyValue('false')).toBe(false);
  });

  it('supports an explicit boolean without allowing unrestricted numeric hop counts', () => {
    expect(parseTrustProxyValue('true')).toBe(true);
    expect(() => parseTrustProxyValue('1')).toThrow(/explicit trusted proxy IP\/CIDR list/);
    expect(() => parseTrustProxyValue('2')).toThrow(/explicit trusted proxy IP\/CIDR list/);
  });

  it('passes CIDR and address expressions through to Fastify', () => {
    expect(parseTrustProxyValue('loopback, 172.16.0.0/12')).toBe('loopback, 172.16.0.0/12');
  });
});
