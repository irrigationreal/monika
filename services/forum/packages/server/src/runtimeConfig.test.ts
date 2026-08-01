import { describe, expect, it } from 'vitest';
import { parseTrustProxyValue } from './runtimeConfig';

describe('parseTrustProxyValue', () => {
  it('keeps proxy trust disabled by default', () => {
    expect(parseTrustProxyValue(undefined)).toBe(false);
    expect(parseTrustProxyValue('')).toBe(false);
    expect(parseTrustProxyValue('0')).toBe(false);
    expect(parseTrustProxyValue('false')).toBe(false);
  });

  it('distinguishes an explicit boolean from a bounded hop count', () => {
    expect(parseTrustProxyValue('true')).toBe(true);
    expect(parseTrustProxyValue('1')).toBe(1);
    expect(parseTrustProxyValue('2')).toBe(2);
  });

  it('passes CIDR and address expressions through to Fastify', () => {
    expect(parseTrustProxyValue('loopback, 172.16.0.0/12')).toBe('loopback, 172.16.0.0/12');
  });
});
