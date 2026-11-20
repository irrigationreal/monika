import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'prepare-pi-subagents-candidate');

async function run(args) {
  return exec(script, args, { cwd: root, env: { ...process.env, PATH: process.env.PATH } });
}

test('candidate preparation has a local-only contract and rejects invalid invocation', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /expected_commit='533033f0e906e85fdb0e909ce27a7c499ffb6485'/);
  assert.match(source, /expected_tree='d6c8cf1dbf40704d3d5f8b0530908e9f6aa6afce'/);
  assert.match(source, /expected_package_lock_sha256='5fc39baec198a9b58887e7fabefed9dc8a4df7dcbf42839992263b9a1639776b'/);
  assert.doesNotMatch(source, /git clone|git fetch|npm (ci|install| update)|docker/);
  await assert.rejects(run([]), (error) => error.code === 2);
});

test('candidate preparation rejects a wrong or dirty source without creating output', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'monika-pi-candidate-test-'));
  try {
    const source = path.join(temp, 'source');
    const destination = path.join(temp, 'candidate');
    await mkdir(source);
    await writeFile(path.join(source, '.git'), 'not-a-real-checkout\n');
    await assert.rejects(run([source, destination]));
    await assert.rejects(readFile(destination));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('production installer remains pinned while candidate harness is experimental', async () => {
  const installer = await readFile(path.join(root, 'scripts', 'install-pi-subagents'), 'utf8');
  const docs = await readFile(path.join(root, 'docs', 'pi-subagents-migration-0.89.1.md'), 'utf8');
  assert.match(installer, /readonly version='0\.37\.2'/);
  assert.match(installer, /readonly commit='8063333661476ca48afbca826dc4aab8707c72d3'/);
  assert.match(docs, /Status: experimental preparation only/);
  assert.match(docs, /production still installs the[\s\S]*0\.37\.2/);
});
