import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  ensureDurableForumSession,
  initialCanonicalSessionFilePending,
  loadedConversationForCanonicalSession,
  readKnownSession,
  SessionResolutionError,
  uniqueSessionById,
  withVerifiedSessionReopen,
} from '../src/session-resolution.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-session-resolution-'));
  const sessions = path.join(root, 'sessions');
  await mkdir(sessions);
  return { root, sessions };
}

function header(id, extra = {}) {
  return `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00Z', cwd: '/workspace', ...extra })}\n`;
}

test('only a newly created exact manager may await its first canonical file', () => {
  const manager = {
    getSessionId: () => 'session-1',
    getSessionFile: () => '/sessions/new.jsonl',
  };
  const conversation = {
    piSessionId: 'session-1',
    sessionPath: '/sessions/new.jsonl',
    sessionFileObserved: false,
    session: { sessionManager: manager },
  };

  assert.equal(initialCanonicalSessionFilePending(conversation, () => false), true);
  assert.equal(initialCanonicalSessionFilePending({ ...conversation, sessionFileObserved: true }, () => false), false);
  assert.equal(initialCanonicalSessionFilePending({ ...conversation, piSessionId: 'other' }, () => false), false);
  assert.equal(initialCanonicalSessionFilePending(conversation, () => true), false);
});

test('ID-only discovery selects one path and fails closed on duplicate IDs', () => {
  const first = { id: 'session-1', path: '/sessions/first.jsonl' };
  const second = { id: 'session-2', path: '/sessions/second.jsonl' };
  assert.equal(uniqueSessionById([first, second], 'session-1'), first);
  assert.equal(uniqueSessionById([first], 'missing'), null);
  assert.throws(
    () => uniqueSessionById([first, { id: 'session-1', path: '/sessions/copy.jsonl' }], 'session-1'),
    (error) => error instanceof SessionResolutionError && error.code === 'session_identity_ambiguous',
  );
});

test('loaded conversation reuse requires both canonical id and path', () => {
  const exact = { piSessionId: 'session-1', sessionPath: '/sessions/original.jsonl' };
  const unrelated = { piSessionId: 'session-2', sessionPath: '/sessions/other.jsonl' };
  const session = { id: 'session-1', path: '/sessions/original.jsonl' };

  assert.equal(loadedConversationForCanonicalSession([unrelated, exact], session), exact);
  assert.equal(loadedConversationForCanonicalSession([unrelated], session), null);
});

test('copied or moved duplicate session ids fail closed instead of reusing a loaded JSONL', () => {
  const loaded = { piSessionId: 'duplicate-id', sessionPath: '/sessions/original.jsonl' };

  for (const session of [
    { id: 'duplicate-id', path: '/sessions/copied.jsonl' },
    { id: 'duplicate-id', path: '/sessions/moved.jsonl' },
    { id: 'different-id', path: '/sessions/original.jsonl' },
  ]) {
    assert.throws(
      () => loadedConversationForCanonicalSession([loaded], session),
      (error) => error instanceof SessionResolutionError && error.code === 'session_loaded_identity_collision',
    );
  }
});

test('an exact loaded session still fails closed when another partial identity collides', () => {
  const session = { id: 'duplicate-id', path: '/sessions/canonical.jsonl' };
  assert.throws(
    () => loadedConversationForCanonicalSession([
      { piSessionId: session.id, sessionPath: session.path },
      { piSessionId: session.id, sessionPath: '/sessions/copy.jsonl' },
    ], session),
    (error) => error instanceof SessionResolutionError && error.code === 'session_loaded_identity_collision',
  );
});

test('known-path resolution reads only the canonical target amid many decoys', async () => {
  const { root, sessions } = await fixture();
  try {
    const target = path.join(sessions, 'target.jsonl');
    await writeFile(target, `${header('target')}not-json\n`);
    const decoys = path.join(sessions, 'decoys');
    await mkdir(decoys);
    await Promise.all(Array.from({ length: 1800 }, (_, index) => writeFile(path.join(decoys, `${index}.jsonl`), 'malformed')));

    const accesses = [];
    const resolved = await readKnownSession({
      sessionsRoot: sessions,
      sessionPath: target,
      expectedId: 'target',
      fsOps: {
        realpath: async (candidate) => { accesses.push(['realpath', candidate]); return realpath(candidate); },
        open: async (candidate, flags) => { accesses.push(['open', candidate]); return open(candidate, flags); },
        stat: async (candidate) => { accesses.push(['stat', candidate]); return stat(candidate); },
      },
    });
    assert.equal(resolved.id, 'target');
    assert.equal(resolved.path, target);
    assert.equal(typeof resolved.device, 'number');
    assert.equal(typeof resolved.inode, 'number');
    assert.match(resolved.raw, /"id":"target"/);
    assert.deepEqual(accesses.slice(0, 4), [
      ['realpath', sessions],
      ['realpath', target],
      ['open', target],
      ['stat', target],
    ]);
    assert.equal(accesses.length, 5);
    assert.match(accesses[4][1], /^\/proc\/self\/fd\/\d+$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('known-path resolution rejects an ancestor-directory swap after descriptor open', { skip: process.platform !== 'linux' }, async () => {
  const { root, sessions } = await fixture();
  const outside = path.join(root, 'outside');
  const ancestor = path.join(sessions, 'day');
  const displaced = path.join(sessions, 'day-displaced');
  try {
    await mkdir(ancestor);
    await mkdir(outside);
    const target = path.join(ancestor, 'target.jsonl');
    await writeFile(target, header('target'));
    await writeFile(path.join(outside, 'target.jsonl'), header('attacker'));

    await assert.rejects(
      readKnownSession({
        sessionsRoot: sessions,
        sessionPath: target,
        expectedId: 'target',
        fsOps: {
          open: async (candidate, flags) => {
            const handle = await open(candidate, flags);
            await rename(ancestor, displaced);
            await symlink(outside, ancestor, 'dir');
            return handle;
          },
        },
      }),
      (error) => error instanceof SessionResolutionError && error.code === 'session_path_changed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified pathname reopen fails closed when an ancestor is swapped during SessionManager.open', { skip: process.platform !== 'linux' }, async () => {
  const { root, sessions } = await fixture();
  const ancestor = path.join(sessions, 'day');
  const displaced = path.join(sessions, 'day-displaced');
  const outside = path.join(root, 'outside');
  try {
    await mkdir(ancestor);
    await mkdir(outside);
    const target = path.join(ancestor, 'target.jsonl');
    await writeFile(target, header('target'));
    await writeFile(path.join(outside, 'target.jsonl'), header('attacker'));
    const resolved = await readKnownSession({ sessionsRoot: sessions, sessionPath: target, expectedId: 'target' });

    assert.throws(
      () => withVerifiedSessionReopen(resolved, () => {
        // Model the unavoidable third-party pathname reopen racing with an
        // attacker replacing a parent directory.
        renameSync(ancestor, displaced);
        symlinkSync(outside, ancestor, 'dir');
        return SessionManager.open(target);
      }),
      (error) => error instanceof SessionResolutionError && error.code === 'session_path_changed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('known-path resolution accepts the explicit subagent root without archive scanning', async () => {
  const { root, sessions } = await fixture();
  const subagents = path.join(root, 'subagent-sessions');
  try {
    await mkdir(subagents);
    const target = path.join(subagents, 'child.jsonl');
    await writeFile(target, header('child'));
    const resolved = await readKnownSession({
      sessionsRoot: sessions,
      subagentRoot: subagents,
      sessionPath: target,
      expectedId: 'child',
    });
    assert.equal(resolved.kind, 'subagent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('known-path resolution rejects escape, symlink, malformed header, and identity mismatch', async () => {
  const { root, sessions } = await fixture();
  try {
    const outside = path.join(root, 'outside.jsonl');
    await writeFile(outside, header('outside'));
    await assert.rejects(
      readKnownSession({ sessionsRoot: sessions, sessionPath: outside }),
      (error) => error instanceof SessionResolutionError && error.code === 'session_path_outside_root',
    );

    const linked = path.join(sessions, 'linked.jsonl');
    await symlink(outside, linked);
    await assert.rejects(
      readKnownSession({ sessionsRoot: sessions, sessionPath: linked }),
      (error) => error instanceof SessionResolutionError && ['session_path_outside_root', 'session_path_symlink'].includes(error.code),
    );

    const malformed = path.join(sessions, 'malformed.jsonl');
    await writeFile(malformed, '{bad\n');
    await assert.rejects(
      readKnownSession({ sessionsRoot: sessions, sessionPath: malformed }),
      (error) => error instanceof SessionResolutionError && error.code === 'invalid_session_header',
    );

    const mismatch = path.join(sessions, 'mismatch.jsonl');
    await writeFile(mismatch, header('actual'));
    await assert.rejects(
      readKnownSession({ sessionsRoot: sessions, sessionPath: mismatch, expectedId: 'expected' }),
      (error) => error instanceof SessionResolutionError && error.code === 'session_identity_mismatch',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('forum session anchoring persists before an assistant message and remains appendable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-session-anchor-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, '.pi');
    const manager = SessionManager.create(root);
    assert.equal(ensureDurableForumSession(manager, false), false);
    const sessionFile = manager.getSessionFile();
    await assert.rejects(stat(sessionFile), (error) => error?.code === 'ENOENT');
    assert.equal(ensureDurableForumSession(manager, true), true);

    assert.ok(sessionFile);
    assert.ok((await stat(sessionFile)).isFile());
    let lines = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].type, 'session');
    assert.equal(lines[0].id, manager.getSessionId());
    assert.equal(lines[1].customType, 'monika.forum.session');

    manager.appendCustomEntry('monika.test.after-anchor', { ok: true });
    lines = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines.filter((entry) => entry.type === 'session').length, 1);
    assert.equal(lines.at(-1).customType, 'monika.test.after-anchor');
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

