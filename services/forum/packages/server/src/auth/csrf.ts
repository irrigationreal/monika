import type { AuthContext } from '../utils/auth';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Unsafe requests may never claim a different browser origin. Cookie
 * authentication is ambient and additionally requires the exact first-party
 * origin; explicit automation credentials may omit Origin. */
export function isTrustedCookieRequest(input: {
  method: string;
  origin: string | string[] | undefined;
  trustedOrigin: string;
  auth: AuthContext | null;
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;
  if (input.origin !== undefined && input.origin !== input.trustedOrigin) return false;
  if (input.auth?.authSource === 'cookie') return input.origin === input.trustedOrigin;
  return true;
}

export function assertCorsCredentialsConfiguration(origins: string[] | null, credentials: boolean): void {
  if (credentials && (!origins?.length || origins.includes('*'))) {
    throw new Error('CODEX_FORUM_CORS_CREDENTIALS=1 requires an explicit CODEX_FORUM_CORS_ORIGINS allowlist');
  }
}
