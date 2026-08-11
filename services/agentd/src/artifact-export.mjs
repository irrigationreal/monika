import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

function isPathWithin(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function cleanFilename(value) {
  return String(value).replace(/[\r\n"]/g, '');
}

/**
 * Reads a legacy artifact through an O_NOFOLLOW descriptor and proves that the
 * opened inode is still the requested path inside a canonical allowed root.
 * The descriptor, rather than a pathname reopened after validation, is the
 * source of the exported bytes.
 */
export async function resolveLegacyArtifact(input, options) {
  const raw = input?.path ?? input?.file ?? null;
  if (!raw || typeof raw !== 'string') throw new Error('path is required');
  const resolved = path.resolve(raw);
  const lexicalRoots = options.allowedRoots.map((root) => path.resolve(root));
  if (!lexicalRoots.some((root) => isPathWithin(root, resolved))) throw new Error('artifact path is not allowed');

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(resolved, flags);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('artifact symlinks are not allowed');
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('artifact path is not a file');
    if (opened.size <= 0) throw new Error('artifact is empty');
    if (opened.size > options.maxBytes) throw new Error('artifact exceeds export size limit');

    // /proc/self/fd resolves the object actually held by the descriptor. This
    // closes the intermediate-directory symlink and pathname-swap gap left by
    // checking realpath before opening.
    const descriptorPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    const canonicalRoots = (await Promise.all(lexicalRoots.map(async (root) => {
      try { return await fs.realpath(root); } catch { return null; }
    }))).filter(Boolean);
    if (!canonicalRoots.some((root) => isPathWithin(root, descriptorPath))) {
      throw new Error('artifact canonical path is not allowed');
    }

    if (typeof options.afterOpen === 'function') await options.afterOpen({ resolved, descriptorPath });
    const current = await fs.lstat(resolved);
    if (current.isSymbolicLink()) throw new Error('artifact symlinks are not allowed');
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('artifact path changed during validation');

    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || buffer.length !== opened.size) {
      throw new Error('artifact changed during read');
    }
    const filename = cleanFilename(input?.filename ?? input?.name ?? path.basename(descriptorPath));
    return {
      path: descriptorPath,
      filename,
      mimeType: String(input?.mimeType ?? input?.mime ?? options.guessMimeType(filename)),
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      dataBase64: buffer.toString('base64'),
    };
  } finally {
    await handle.close();
  }
}
