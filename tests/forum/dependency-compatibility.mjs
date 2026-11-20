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
