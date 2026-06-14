import { join, resolve } from 'node:path';
import { ROBOT_ATTACHMENTS_DIR } from '../runtimeConfig';

export function resolveRobotAttachmentPath(requested: string): string | null {
  const trimmed = requested.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^file:\/\//i, '');
  const normalized = withoutScheme.replace(/\\/g, '/');
  const base = normalized.startsWith('/') ? normalized : join(ROBOT_ATTACHMENTS_DIR, normalized);
  const resolvedPath = resolve(base);
  const root = resolve(ROBOT_ATTACHMENTS_DIR);
  if (resolvedPath === root || !resolvedPath.startsWith(`${root}/`)) return null;
  return resolvedPath;
}

export function contentTypeForPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'json':
      return 'application/json';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

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
