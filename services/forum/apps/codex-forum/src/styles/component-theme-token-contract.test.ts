import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const stylesDir = path.dirname(__filename);
const srcDir = path.dirname(stylesDir);
const componentsDir = path.join(srcDir, 'components');

function captureTokens(source: string, pattern: RegExp): Set<string> {
  return new Set(
    [...source.matchAll(pattern)].map((match) => match[1]).filter((token): token is string => Boolean(token))
  );
}

function declaredTokens(source: string): Set<string> {
  return captureTokens(source, /(--[\w-]+)\s*:/g);
}

function referencedTokens(source: string): Set<string> {
  return captureTokens(source, /var\((--[\w-]+)/g);
}

describe('component theme token contract', () => {
  it('does not let component styles silently fall back from undefined theme tokens', async () => {
    const styleFiles = (await readdir(stylesDir)).filter((name) => name.endsWith('.css'));
    const componentFiles = (await readdir(componentsDir, { recursive: true })).filter((name) => name.endsWith('.vue'));
    const styleSources = await Promise.all(styleFiles.map((name) => readFile(path.join(stylesDir, name), 'utf8')));
    const componentSources = await Promise.all(
      componentFiles.map(async (name) => ({ name, source: await readFile(path.join(componentsDir, name), 'utf8') }))
    );
    const globalDeclarations = declaredTokens(styleSources.join('\n'));
    const missing = componentSources.flatMap(({ name, source }) => {
      const available = new Set([...globalDeclarations, ...declaredTokens(source)]);
      return [...referencedTokens(source)]
        .filter((token) => !available.has(token))
        .map((token) => `${name}: ${token}`);
    });

    expect(missing).toEqual([]);
  });
});
