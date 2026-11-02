import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEncryptedSecretStore } from '../src/secret-store.mjs';

 test('encrypts and round-trips values without storing plaintext', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentd-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const key = Buffer.alloc(32, 7);
  const store = createEncryptedSecretStore({ path: file, key });
  store.put('id', 'top secret', { name: 'token', enabled: true, tags: [], expires_at: null });
  assert.equal(store.getForOperation('id'), 'top secret');
  assert.equal(store.metadata('id').name, 'token');
  assert.equal(readFileSync(file, 'utf8').includes('top secret'), false);
  assert.equal(store.delete('id'), true);
  assert.equal(store.getForOperation('id'), null);
 });

test('does not resolve disabled or expired values for operations', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentd-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const key = Buffer.alloc(32, 8);
  const store = createEncryptedSecretStore({ path: file, key });
  store.put('disabled', 'value', { enabled: false });
  store.put('expired', 'value', { enabled: true, expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal(store.getForOperation('disabled'), null);
  assert.equal(store.getForOperation('expired'), null);
});

test('uses a fresh store to decrypt persisted values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentd-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const key = Buffer.alloc(32, 9);
  createEncryptedSecretStore({ path: file, key }).put('id', 'value', { enabled: true });
  assert.equal(createEncryptedSecretStore({ path: file, key }).getForOperation('id'), 'value');
});
