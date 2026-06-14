import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  const keyBuffer = Buffer.from(key, 'hex');
  return timingSafeEqual(derivedKey, keyBuffer);
}

export type AuthScope = 'read' | 'write' | 'admin' | '*';
export type AuthType = 'session' | 'apiKey' | 'impersonation';

export interface AuthContext {
  identityId: string;
  authType: AuthType;
  scopes: AuthScope[] | null;
  tokenId?: string | null;
  ownerIdentityId?: string | null;
}

export const API_KEY_PREFIX = 'cfk_';
export const IMPERSONATION_PREFIX = 'cfi_';
export const ALLOWED_API_SCOPES: Set<AuthScope> = new Set<AuthScope>(['read', 'write', 'admin', '*']);

export function generateToken(prefix: string = 'cforum'): string {
  return `${prefix}_${Date.now()}_${randomBytes(24).toString('hex')}`;
}

export function generateApiToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseScopes(input: unknown, fallback: AuthScope[] = ['read', 'write']): AuthScope[] {
  if (!Array.isArray(input)) return fallback;
  const normalized = input
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter((item): item is AuthScope => Boolean(item) && ALLOWED_API_SCOPES.has(item as AuthScope));
  return normalized.length ? normalized : fallback;
}

export function isTokenExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

export function normalizePrivateEmail(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > 254) return null;
  if (/\s/.test(trimmed)) return null;
  // Very lightweight sanity check. We intentionally avoid strict RFC parsing here.
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return null;
  return trimmed;
}
