import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { router } from './index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

describe('router route names', () => {
  it('registers the canonical forum routes', () => {
    const routeNames = new Set(router.getRoutes().map((route) => route.name).filter(Boolean));
    expect(routeNames.has('forum.home')).toBe(true);
    expect(routeNames.has('forum.view')).toBe(true);
  });

  it('does not reference the removed forum index route name anywhere in the app', async () => {
    // Construct the removed route name without embedding it verbatim in this test
    // (otherwise the scan would always fail on this file).
    const removedRouteName = ['forum', 'index'].join('.');
    const srcRoot = path.resolve(__dirname, '..'); // apps/codex-forum/src
    const files = (await walkFiles(srcRoot)).filter((file) => /\.(ts|vue)$/.test(file));
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (contents.includes(removedRouteName)) offenders.push(path.relative(srcRoot, file));
    }

    expect(offenders).toEqual([]);
  });
});
