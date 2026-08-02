const INLINE_MIME_PREFIXES = ['image/', 'audio/', 'video/'] as const;
const INLINE_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'text/csv',
  'text/markdown',
  'text/plain'
]);

export function shouldInlineAttachment(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(';')[0]?.trim().toLowerCase();
  if (!type) return false;
  if (type === 'image/svg+xml') return false;
  if (INLINE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
  return INLINE_MIME_TYPES.has(type);
}
