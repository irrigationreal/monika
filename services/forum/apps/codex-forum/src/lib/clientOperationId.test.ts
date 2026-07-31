import { describe, expect, it, vi } from 'vitest';

import { createClientOperationId } from './clientOperationId';

describe('createClientOperationId', () => {
  it('prefers the platform UUID implementation when available', () => {
    const randomUUID = vi.fn(() => '4d296835-9af6-4b40-852f-17f647065839' as `${string}-${string}-${string}-${string}-${string}`);
    const getRandomValues = vi.fn();

    expect(createClientOperationId({ randomUUID, getRandomValues } as Crypto)).toBe(
      '4d296835-9af6-4b40-852f-17f647065839'
    );
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('generates an RFC 4122 version 4 id when randomUUID is unavailable on HTTP', () => {
    let seed = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_value, index) => {
        bytes[index] = seed++;
      });
      return bytes;
    });

    const id = createClientOperationId({ getRandomValues } as Crypto);

    expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reports an actionable error when no secure random source exists', () => {
    expect(() => createClientOperationId(null)).toThrow(
      'Secure random number generation is unavailable in this browser.'
    );
  });
});
