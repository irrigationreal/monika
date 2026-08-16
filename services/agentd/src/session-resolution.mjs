import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class SessionResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionResolutionError';
    this.code = code;
  }
}

export function initialCanonicalSessionFilePending(conversation, pathExists = existsSync) {
  const manager = conversation.session?.sessionManager;
  return !conversation.sessionFileObserved
    && manager?.getSessionId?.() === conversation.piSessionId
    && manager?.getSessionFile?.() === conversation.sessionPath
    && !pathExists(conversation.sessionPath);
}

export function uniqueSessionById(sessions, sessionId) {
  let match = null;
  for (const session of sessions) {
    if (session.id !== sessionId) continue;
    if (match) {
      throw new SessionResolutionError(
        'session_identity_ambiguous',
        'multiple canonical session paths claim the requested session id',
      );
    }
    match = session;
  }
  return match;
}

export function loadedConversationForCanonicalSession(conversations, session) {
  let exact = null;
  for (const conversation of conversations) {
    const idMatches = conversation.piSessionId === session.id;
    const pathMatches = conversation.sessionPath === session.path;
    if (!idMatches && !pathMatches) continue;
    if (!idMatches || !pathMatches || exact) {
      throw new SessionResolutionError(
        'session_loaded_identity_collision',
        'loaded conversation identity collides with the canonical session',
      );
    }
    exact = conversation;
  }
  return exact;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parentSessionId(parentSession) {
  return parentSession
    ? path.basename(parentSession, '.jsonl').split('_').pop()
    : null;
}

function descriptorPath(fd) {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  // Containers are Linux. Other platforms fail closed until they have a tested
  // equivalent that returns the opened inode's canonical filesystem pathname.
  throw new SessionResolutionError(
    'session_descriptor_validation_unsupported',
    `secure canonical session resolution is unsupported on ${process.platform}`,
  );
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOpenedPath(actualPath, lexicalPath, lexicalRoot) {
  if (!within(lexicalRoot, actualPath) || actualPath !== lexicalPath) {
    throw new SessionResolutionError(
      'session_path_changed',
      'opened canonical session inode is not the intended path beneath its sessions root',
    );
  }
}

/**
 * Keep a descriptor for the previously inspected inode open while Pi performs
 * its unavoidable pathname reopen. Pre/post checks detect stable path changes;
 * they cannot make a third-party pathname API descriptor-relative.
 */
export function withVerifiedSessionReopen(session, opener, fsOps = {}) {
  const openPath = fsOps.openSync ?? openSync;
  const closeFile = fsOps.closeSync ?? closeSync;
  const descriptorStat = fsOps.fstatSync ?? fstatSync;
  const pathnameStat = fsOps.statSync ?? statSync;
  const resolveRealpath = fsOps.realpathSync ?? realpathSync;
  const fd = openPath(session.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const held = descriptorStat(fd);
    if (!held.isFile() || held.dev !== session.device || held.ino !== session.inode) {
      throw new SessionResolutionError('session_path_changed', 'canonical session inode changed before reopening');
    }
    const actual = resolveRealpath(descriptorPath(fd));
    assertOpenedPath(actual, session.path, session.allowed_root);
    if (!sameIdentity(held, pathnameStat(session.path))) {
      throw new SessionResolutionError('session_path_changed', 'canonical session path changed before reopening');
    }
    const result = opener();
    const after = pathnameStat(session.path);
    if (!sameIdentity(held, after) || resolveRealpath(descriptorPath(fd)) !== session.path) {
      throw new SessionResolutionError('session_path_changed', 'canonical session path changed while reopening');
    }
    return result;
  } finally {
    closeFile(fd);
  }
}

/**
 * Resolve one already-known canonical Pi session path without enumerating the
 * archive. The opened descriptor, not a later pathname read, supplies bytes.
 */
export async function readKnownSession({ sessionsRoot, sessionPath, expectedId = null, subagentRoot = null, fsOps = {} }) {
  const resolveRealpath = fsOps.realpath ?? realpath;
  const openFile = fsOps.open ?? open;
  const statPath = fsOps.stat ?? stat;
  if (!sessionPath || !path.isAbsolute(sessionPath)) {
    throw new SessionResolutionError('invalid_session_path', 'canonical session path must be absolute');
  }
  const roots = [];
  let resolvedSubagentRoot = null;
  for (const [kind, candidateRoot] of [
    ['normal', sessionsRoot],
    ['subagent', subagentRoot],
  ]) {
    if (!candidateRoot) continue;
    try {
      const resolved = await resolveRealpath(path.resolve(candidateRoot));
      roots.push(resolved);
      if (kind === 'subagent') resolvedSubagentRoot = resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const lexicalPath = path.resolve(sessionPath);
  const lexicalRoot = roots.find((root) => within(root, lexicalPath));
  if (!lexicalRoot) {
    throw new SessionResolutionError('session_path_outside_root', 'canonical session path is outside an allowed sessions root');
  }

  let canonicalPath;
  try {
    canonicalPath = await resolveRealpath(lexicalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!within(lexicalRoot, canonicalPath)) {
    throw new SessionResolutionError('session_path_outside_root', 'canonical session path resolves outside its sessions root');
  }
  if (canonicalPath !== lexicalPath) {
    throw new SessionResolutionError('session_path_symlink', 'canonical session path must not contain symlinks');
  }

  let handle;
  try {
    handle = await openFile(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') {
      throw new SessionResolutionError('session_path_symlink', 'canonical session path must not be a symlink');
    }
    throw error;
  }
  try {
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) {
      throw new SessionResolutionError('invalid_session_file', 'canonical session path is not a regular file');
    }
    let pathnameStat;
    try {
      pathnameStat = await statPath(canonicalPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new SessionResolutionError('session_path_changed', 'canonical session path disappeared during validation');
      }
      throw error;
    }
    if (!sameIdentity(descriptorStat, pathnameStat)) {
      throw new SessionResolutionError('session_path_changed', 'canonical session path changed during validation');
    }
    let openedPath;
    try {
      openedPath = await resolveRealpath(descriptorPath(handle.fd));
    } catch (error) {
      if (error instanceof SessionResolutionError) throw error;
      throw new SessionResolutionError(
        'session_descriptor_validation_failed',
        `cannot inspect opened canonical session descriptor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertOpenedPath(openedPath, lexicalPath, lexicalRoot);
    const raw = await handle.readFile({ encoding: 'utf8' });
    const firstLine = raw.split('\n', 1)[0] ?? '';
    let header;
    try {
      header = JSON.parse(firstLine || '{}');
    } catch {
      throw new SessionResolutionError('invalid_session_header', 'canonical session header is malformed');
    }
    if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id) {
      throw new SessionResolutionError('invalid_session_header', 'canonical session header is missing its session identity');
    }
    if (expectedId && header.id !== expectedId) {
      throw new SessionResolutionError('session_identity_mismatch', 'canonical session path does not match the requested session id');
    }
    return {
      id: header.id,
      version: header.version ?? null,
      path: canonicalPath,
      allowed_root: lexicalRoot,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      cwd: header.cwd,
      timestamp: header.timestamp,
      parent_session_path: header.parentSession ?? null,
      parent_session_id: parentSessionId(header.parentSession),
      kind: resolvedSubagentRoot && within(resolvedSubagentRoot, canonicalPath)
        ? 'subagent'
        : canonicalPath.includes(`${path.sep}forks${path.sep}`)
          ? 'fork'
          : 'normal',
      mtime_ms: descriptorStat.mtimeMs,
      size_bytes: descriptorStat.size,
      raw,
    };
  } finally {
    await handle.close();
  }
}

export function ensureDurableForumSession(sessionManager, requested, creationId = null) {
  if (requested !== true) return false;
  if (sessionManager.isPersisted?.() !== true) {
    throw new SessionResolutionError('session_not_persisted', 'forum canonical session manager is not persistent');
  }

  sessionManager.appendCustomEntry('monika.forum.session', {
    version: 1,
    created_at: new Date().toISOString(),
    ...(creationId ? { creation_id: creationId } : {}),
  });

  const sessionFile = sessionManager.getSessionFile?.();
  const header = sessionManager.getHeader?.();
  const entries = sessionManager.getEntries?.();
  if (!sessionFile || !header || !Array.isArray(entries)) {
    throw new SessionResolutionError('session_anchor_failed', 'forum canonical session cannot be anchored');
  }

  // Pi intentionally defers a new session file until its first assistant
  // message. Forum must persist the canonical link before submitting a prompt,
  // so create the complete header + invisible anchor atomically and then reload
  // the same manager through its public API. Reloading marks subsequent Pi
  // appends as writes to an established session instead of a second create.
  if (!existsSync(sessionFile)) {
    const contents = [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      writeFileSync(sessionFile, contents, { flag: 'wx' });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new SessionResolutionError('session_anchor_conflict', 'forum canonical session appeared during anchoring');
      }
      throw error;
    }
    const expectedId = header.id;
    sessionManager.setSessionFile(sessionFile);
    if (sessionManager.getSessionId?.() !== expectedId) {
      throw new SessionResolutionError('session_anchor_failed', 'forum canonical session identity changed during anchoring');
    }
  }
  return true;
}
