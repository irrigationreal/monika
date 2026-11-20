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

test('production installer remains pinned while candidate tooling is experimental', async () => {
  const installer = await readFile(path.join(root, 'scripts', 'install-pi-subagents'), 'utf8');
  assert.match(installer, /readonly version='0\.37\.2'/);
  assert.match(installer, /readonly commit='8063333661476ca48afbca826dc4aab8707c72d3'/);
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
