import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Resolve through real consumers, not a direct test-only dependency that could
// hide an incompatible override in the deployed workspace graph.
const appRequire = createRequire(new URL('../../services/forum/apps/codex-forum/package.json', import.meta.url));
const vueTestRequire = createRequire(appRequire.resolve('@vue/test-utils'));
const beautifyRequire = createRequire(vueTestRequire.resolve('js-beautify'));
const editorconfig = beautifyRequire('editorconfig');

test('actual consumers resolve patched Glob/Minimatch without replacing legacy Minimatch 3', () => {
  const serverRequire = createRequire(new URL('../../services/forum/packages/server/package.json', import.meta.url));
  const staticRequire = createRequire(serverRequire.resolve('@fastify/static'));
  const fastifyRequire = createRequire(serverRequire.resolve('fastify'));
  const { satisfies } = fastifyRequire('semver');
  const lintRequire = createRequire(new URL('../../services/forum/packages/eslint-config/package.json', import.meta.url));
  const parserRequire = createRequire(lintRequire.resolve('@typescript-eslint/parser'));
  const estreeRequire = createRequire(parserRequire.resolve('@typescript-eslint/typescript-estree'));
  const importXRequire = createRequire(lintRequire.resolve('eslint-plugin-import-x'));
  const editorRequire = createRequire(beautifyRequire.resolve('editorconfig'));
  const eslintRequire = createRequire(appRequire.resolve('eslint'));

  function assertVersion(consumer, name, range) {
    const { version } = consumer(`${name}/package.json`);
    assert.ok(satisfies(version, range), `${name}@${version} must satisfy ${range}`);
  }

  for (const consumer of [staticRequire, beautifyRequire]) {
    assertVersion(consumer, 'glob', '>=14.0.2 <15');
    const globRequire = createRequire(consumer.resolve('glob'));
    assertVersion(globRequire, 'minimatch', '>=11.0.1 <12');
  }
  for (const consumer of [editorRequire, estreeRequire, importXRequire]) {
    assertVersion(consumer, 'minimatch', '>=11.0.1 <12');
  }
  assertVersion(eslintRequire, 'minimatch', '3.x');
});

test('js-beautify CLI discovers nested files with its overridden Glob', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forum-beautify-'));
  try {
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'example.html'), '<div><div>Hello</div></div>');
    const output = execFileSync(process.execPath, [
      vueTestRequire.resolve('js-beautify/js/bin/html-beautify.js'),
      '--file', 'nested/**/*.html', '--indent-size', '2',
    ], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.match(output, /beautified nested\/example\.html/u);
    assert.match(readFileSync(join(directory, 'nested', 'example.html'), 'utf8'), /<div>\n {2}<div>Hello<\/div>\n<\/div>/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('EditorConfig preserves brace and recursive matching with overridden Minimatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forum-editorconfig-'));
  try {
    writeFileSync(join(directory, '.editorconfig'), [
      'root = true', '', '[**/*.{html,vue}]', 'indent_style = space', 'indent_size = 2', '',
    ].join('\n'));
    const settings = await editorconfig.parse(join(directory, 'nested', 'component.vue'));
    assert.equal(settings.indent_style, 'space');
    assert.equal(settings.indent_size, 2);
    assert.deepEqual(await editorconfig.parse(join(directory, 'nested', 'other.txt')), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
