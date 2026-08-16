import path from 'node:path';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';

function requireAbsolute(file) {
  if (!path.isAbsolute(file)) throw new TypeError('agentd drain state file must be an absolute path');
  return file;
}

export class DurableDrainState {
  constructor(file) {
    this.file = requireAbsolute(file);
  }

  async restore(nowMs = Date.now()) {
    let value;
    try {
      value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const leaseExpiresAtMs = Number(value?.lease_expires_at_ms);
    if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= nowMs) {
      await this.clear();
      return null;
    }
    return {
      reason: typeof value.reason === 'string' && value.reason ? value.reason : 'deploy-api',
      leaseExpiresAtMs,
    };
  }

  async publish({ reason, leaseExpiresAtMs }) {
    if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
      throw new TypeError('drain lease expiry must be in the future');
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify({ reason, lease_expires_at_ms: leaseExpiresAtMs })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async clear() {
    await rm(this.file, { force: true });
  }
}
