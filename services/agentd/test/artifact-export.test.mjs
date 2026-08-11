import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveLegacyArtifact } from '../src/artifact-export.mjs';

const options = (root, extra = {}) => ({
  allowedRoots: [root],
  maxBytes: 1024,
  guessMimeType: () => 'application/octet-stream',
  ...extra,
});

test('legacy artifact export reads regular files through the validated descriptor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-artifact-'));
  try {
    const file = path.join(root, 'result.txt');
    await writeFile(file, 'trusted bytes');
    const artifact = await resolveLegacyArtifact({ path: file }, options(root));
    assert.equal(Buffer.from(artifact.dataBase64, 'base64').toString(), 'trusted bytes');
    assert.equal(artifact.path, file);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy artifact export rejects final symlinks even when their target is allowed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-artifact-'));
  try {
    const target = path.join(root, 'target.txt');
    const link = path.join(root, 'result.txt');
    await writeFile(target, 'trusted bytes');
    await symlink(target, link);
    await assert.rejects(resolveLegacyArtifact({ path: link }, options(root)), /symlink|ELOOP/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy artifact export rejects a pathname swapped after descriptor open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-artifact-'));
  try {
    const file = path.join(root, 'result.txt');
    const moved = path.join(root, 'opened.txt');
    await writeFile(file, 'first inode');
    await assert.rejects(resolveLegacyArtifact({ path: file }, options(root, {
      afterOpen: async () => {
        await rename(file, moved);
        await writeFile(file, 'replacement inode');
      },
    })), /changed during validation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy artifact export rejects an ancestor replaced by a symlink after descriptor open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentd-artifact-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agentd-artifact-outside-'));
  try {
    const directory = path.join(root, 'nested');
    const moved = path.join(root, 'opened-nested');
    await mkdir(directory);
    await writeFile(path.join(directory, 'result.txt'), 'trusted bytes');
    await writeFile(path.join(outside, 'result.txt'), 'outside bytes');
    await assert.rejects(resolveLegacyArtifact({ path: path.join(directory, 'result.txt') }, options(root, {
      afterOpen: async () => {
        await rename(directory, moved);
        await symlink(outside, directory);
      },
    })), /changed during validation/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
