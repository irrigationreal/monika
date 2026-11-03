import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const monika = readFileSync(new URL('Containerfile', root), 'utf8');
const forum = readFileSync(new URL('services/forum/Containerfile', root), 'utf8');

function stages(source) {
  return [...source.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gim)]
    .map(([, image, name]) => ({ image, name }));
}

test('Monika and Forum use the same explicitly versioned Node/Trixie runtime', () => {
  const monikaRuntime = stages(monika).at(-1).image;
  const forumBase = stages(forum).find(stage => stage.name === 'base').image;
  const forumRuntime = stages(forum).find(stage => stage.name === 'runtime').image;
  assert.match(monikaRuntime, /^node:26\.\d+\.\d+-trixie-slim$/);
  assert.equal(monikaRuntime, forumBase);
  assert.equal(monikaRuntime, forumRuntime);
});

test('CGO memstore builds on the same Debian generation as its runtime', () => {
  const builder = stages(monika).find(stage => stage.name === 'memstore-build').image;
  assert.match(builder, /^golang:\d+\.\d+\.\d+-trixie$/);
  assert.match(monika, /CGO_ENABLED=1 go test -tags fts5 \.\/\.\.\./);
  assert.match(monika, /CGO_ENABLED=1 go build -tags fts5 -o \/memstore \./);
});
