export function isValidPersonaKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(key);
}

export function isSafeHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function isSafeAvatarUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/')) return true;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return true;
  return false;
}

export const RESERVED_PERSONA_NAMES: Set<string> = new Set(['admin', 'administrator', 'moderator', 'mod', 'staff', 'system']);
