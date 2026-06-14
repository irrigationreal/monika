import { randomNonce } from 'openid-client';
import { randomUUID } from 'node:crypto';

export type OidcAuthState = {
  state: string;
  nonce: string;
  pkceCodeVerifier: string;
  createdAtMs: number;
  /** When present, links the OIDC callback to an already-authenticated forum user. */
  forumIdentityId?: string | null;
};

export type OidcStateStore = {
  create(input: { pkceCodeVerifier: string; forumIdentityId?: string | null }): OidcAuthState;
  consume(state: string): OidcAuthState | null;
};

export function createInMemoryOidcStateStore(options?: { ttlMs?: number; maxEntries?: number }): OidcStateStore {
  const ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = options?.maxEntries ?? 10_000;
  const map = new Map<string, OidcAuthState>();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, value] of map) {
      if (now - value.createdAtMs > ttlMs) map.delete(key);
    }
    // crude cap
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  };

  return {
    create: ({ pkceCodeVerifier, forumIdentityId }) => {
      cleanup();
      const state = randomUUID();
      const value: OidcAuthState = {
        state,
        nonce: randomNonce(),
        pkceCodeVerifier,
        createdAtMs: Date.now(),
        forumIdentityId: forumIdentityId ?? null
      };
      map.set(state, value);
      return value;
    },
    consume: (state) => {
      cleanup();
      const value = map.get(state) ?? null;
      if (value) map.delete(state);
      return value;
    }
  };
}

