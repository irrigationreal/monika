import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const VERSION = 1;

function keyFromEnv(value) {
  if (!value) throw new Error('MONIKA_AGENTD_SECRET_KEY is required');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('MONIKA_AGENTD_SECRET_KEY must be base64-encoded 32 bytes');
  return key;
}

export function createEncryptedSecretStore(options = {}) {
  const filePath = options.path ?? process.env.MONIKA_AGENTD_SECRET_STORE_PATH ?? '/var/lib/monika/secrets.json';
  const key = options.key ?? keyFromEnv(process.env.MONIKA_AGENTD_SECRET_KEY);
  let records = new Map();
  if (existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const [id, record] of Object.entries(data.records ?? {})) records.set(id, record);
  }
  const persist = () => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: VERSION, records: Object.fromEntries(records) }), { mode: 0o600 });
    renameSync(temp, filePath);
  };
  const encrypt = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  };
  const decrypt = (record) => {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  };
  return {
    put(id, value, metadata = {}) {
      records.set(id, { ...metadata, ...encrypt(value), updated_at: new Date().toISOString() });
      persist();
      return { id, ...metadata };
    },
    delete(id) { const existed = records.delete(id); if (existed) persist(); return existed; },
    disable(id) {
      const record = records.get(id);
      if (!record) return false;
      record.enabled = false;
      persist();
      return true;
    },
    metadata(id) {
      const record = records.get(id); if (!record) return null;
      const { iv, ciphertext, tag, ...metadata } = record; return { id, ...metadata };
    },
    // Deliberately not exposed as an HTTP handler: operation code must consume this locally.
    getForOperation(id) {
      const record = records.get(id);
      if (!record || record.enabled === false) return null;
      if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) return null;
      return decrypt(record);
    },
    _filePath: filePath,
  };
}
