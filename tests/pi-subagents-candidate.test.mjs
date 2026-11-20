import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, lstat, readlink, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'prepare-pi-subagents-candidate');
const commit = '533033f0e906e85fdb0e909ce27a7c499ffb6485';
const run = (args) => exec(script, args, { cwd: root });
const missing = async (file) => assert.rejects(lstat(file), { code: 'ENOENT' });

async function temporary(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monika-pi-candidate-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function git(cwd, ...args) { return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout; }

function addedFileFromPatch(patch, name) {
  const marker = `diff --git a/${name} b/${name}\n`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `${name} is absent from the candidate patch`);
  const next = patch.indexOf('\ndiff --git ', start + marker.length);
  const section = patch.slice(start, next === -1 ? undefined : next);
  const hunk = section.indexOf('\n@@ ');
  assert.notEqual(hunk, -1, `${name} has no patch hunk`);
  return section.slice(section.indexOf('\n', hunk + 1) + 1)
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('candidate SSH lock digest matches the bundled helper and rejects missing or changed relocation code', async () => temporary(async (dir) => {
  const patch = await readFile(path.join(root, 'config', 'pi-subagents-0.89.1.patch'), 'utf8');
  const candidateModule = path.join(dir, 'execution-target.ts');
  const runner = path.join(dir, 'verify.mjs');
  const fixture = path.join(dir, 'extensions');
  await mkdir(fixture);
  await writeFile(candidateModule, addedFileFromPatch(patch, 'src/runs/shared/execution-target.ts'));
  await writeFile(runner, String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidatePath, bundledRoot, fixture] = process.argv.slice(2);
for (const name of ['ssh.ts', 'ssh-lock.mjs', 'ssh-relocate.mjs']) {
  fs.copyFileSync(path.join(bundledRoot, name), path.join(fixture, name));
}
const { resolveExecutionTarget } = await import(pathToFileURL(candidatePath));
const { lockCodeDigest } = await import(pathToFileURL(path.join(bundledRoot, 'ssh-lock.mjs')));
const extension = path.join(fixture, 'ssh.ts');
const helper = path.join(fixture, 'ssh-lock.mjs');
const relocate = path.join(fixture, 'ssh-relocate.mjs');
const expected = lockCodeDigest(extension, helper, relocate);
const env = {
  MONIKA_SSH_LOCK_DESCRIPTOR: path.join(fixture, 'absent-descriptor.json'),
  PI_SUBAGENT_SSH_LOCK_EXTENSION: extension,
  PI_SUBAGENT_SSH_LOCK_CODE_DIGEST: expected,
};
assert.throws(
  () => resolveExecutionTarget({ kind: 'ssh', name: 'stanza' }, env),
  (error) => error?.code === 'ENOENT' && !String(error.message).includes('startup integrity attestation'),
  'the candidate must accept the exact digest produced by the bundled helper before resolving the descriptor',
);
fs.unlinkSync(relocate);
assert.throws(
  () => resolveExecutionTarget({ kind: 'ssh', name: 'stanza' }, env),
  (error) => error?.code === 'ENOENT' && error.path === relocate,
  'the relocation helper is required',
);
fs.copyFileSync(path.join(bundledRoot, 'ssh-relocate.mjs'), relocate);
fs.appendFileSync(relocate, '\n// changed after startup attestation\n');
assert.throws(
  () => resolveExecutionTarget({ kind: 'ssh', name: 'stanza' }, env),
  /startup integrity attestation/,
  'changed relocation code must invalidate the startup digest',
);
`);
  await exec(process.execPath, [
    '--experimental-strip-types',
    runner,
    candidateModule,
    path.join(root, 'config', 'extensions'),
    fixture,
  ]);
}));

test('invalid invocation is rejected', async () => {
  await assert.rejects(run([]), (error) => error.code === 2);
});

test('wrong Git object and invalid destination leave no output', async () => temporary(async (dir) => {
  const source = path.join(dir, 'source');
  await mkdir(source);
  await git(source, 'init', '-q');
  await writeFile(path.join(source, 'fixture'), 'not the reviewed object\n');
  await git(source, 'add', 'fixture');
  await git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const destination = path.join(dir, 'candidate');
  await assert.rejects(run([source, destination]));
  await missing(destination);
  await assert.rejects(run([source, path.join(source, 'candidate')]));
  await missing(path.join(source, 'candidate'));
  await symlink(path.join(dir, 'absent'), destination);
  await assert.rejects(run([source, destination]));
  assert.equal(await readlink(destination), path.join(dir, 'absent'));
  assert.deepEqual((await readdir(dir)).sort(), ['candidate', 'source']);
}));

test('production installer is pinned to the reviewed 0.89.1 source', async () => {
  const installer = await readFile(path.join(root, 'scripts', 'install-pi-subagents'), 'utf8');
  assert.match(installer, /readonly version='0\.89\.1'/);
  assert.match(installer, /readonly commit='533033f0e906e85fdb0e909ce27a7c499ffb6485'/);
  assert.match(installer, /readonly tree='d6c8cf1dbf40704d3d5f8b0530908e9f6aa6afce'/);
});

// No network in tests. Supply a separately obtained pinned source checkout to
// exercise export correctness, modes and failure atomicity against real Git.
const upstream = process.env.MONIKA_SUBAGENTS_CANDIDATE_SOURCE;
if (process.env.CI && !upstream) throw new Error('CI must supply the pinned offline upstream fixture');
test('pinned object export excludes ignored/tampered bytes and rejects dirty input', { skip: !upstream && 'set MONIKA_SUBAGENTS_CANDIDATE_SOURCE for the offline source fixture' }, async () => temporary(async (dir) => {
  const source = path.join(dir, 'source');
  await exec('git', ['clone', '--quiet', '--shared', '--no-checkout', path.resolve(upstream), source]);
  await git(source, 'checkout', '--quiet', '--detach', commit);
  await mkdir(path.join(source, 'tmp'));
  await writeFile(path.join(source, 'tmp', 'private'), 'must not escape');
  await mkdir(path.join(source, 'nested', 'node_modules'), { recursive: true });
  await writeFile(path.join(source, 'nested', 'node_modules', 'dependency'), 'not source');
  // Ignore the fixture's parent as well as upstream's normal dependency pattern.
  await writeFile(path.join(source, '.git', 'info', 'exclude'), 'nested/\n');
  await git(source, 'update-index', '--assume-unchanged', 'index.ts');
  await writeFile(path.join(source, 'index.ts'), '// hidden worktree mutation\n');
  const destination = path.join(dir, 'candidate');
  await writeFile(path.join(source, '.git', 'info', 'attributes'), 'index.ts export-ignore\n');
  await assert.rejects(run([source, destination]));
  await missing(destination);
  await rm(path.join(source, '.git', 'info', 'attributes'));
  await run([source, destination]);
  const metadata = JSON.parse(await readFile(path.join(destination, 'CANDIDATE_SOURCE.json'), 'utf8'));
  assert.equal(metadata.gitHead, commit);
  assert.equal(metadata.gitTree, 'd6c8cf1dbf40704d3d5f8b0530908e9f6aa6afce');
  assert.equal(metadata.productionInstall, false);
  for (const name of ['.git', 'tmp', 'nested', 'node_modules']) await missing(path.join(destination, name));
  const entries = (await git(source, 'ls-tree', '-rz', '--full-tree', commit)).split('\0').filter(Boolean);
  const expectedNames = new Set(['CANDIDATE_SOURCE.json']);
  for (const entry of entries) {
    const [, mode, oid, name] = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry) ?? [];
    assert.ok(name, `unexpected Git tree entry: ${entry}`);
    expectedNames.add(name);
    const file = path.join(destination, name);
    const stat = await lstat(file);
    const bytes = mode === '120000' ? Buffer.from(await readlink(file)) : await readFile(file);
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(hash, oid, name);
    if (mode !== '120000') assert.equal(Boolean(stat.mode & 0o111), mode === '100755', name);
  }
  async function files(directory, prefix = '') {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), name + '/'));
      else result.push(name);
    }
    return result;
  }
  assert.deepEqual((await files(destination)).sort(), [...expectedNames].sort());
  await git(source, 'update-index', '--no-assume-unchanged', 'index.ts');
  await assert.rejects(run([source, path.join(dir, 'dirty')]));
  await missing(path.join(dir, 'dirty'));
  await git(source, 'checkout', '--', 'index.ts');
  await writeFile(path.join(source, 'untracked'), 'not reviewed');
  await assert.rejects(run([source, path.join(dir, 'untracked')]));
  await missing(path.join(dir, 'untracked'));
  assert.equal((await readdir(dir)).some((name) => name.startsWith('.pi-subagents-candidate.')), false);
}));
