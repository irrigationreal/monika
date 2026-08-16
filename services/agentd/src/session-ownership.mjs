import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const DEFAULT_OWNERSHIP_LEASE_MS = 90_000;

export class SessionOwnershipRegistry {
  constructor({ leaseMs = DEFAULT_OWNERSHIP_LEASE_MS, createToken = randomUUID, now = () => Date.now(), storagePath = null } = {}) {
    this.leaseMs = leaseMs;
    this.createToken = createToken;
    this.now = now;
    this.storagePath = storagePath;
    this.leases = new Map();
    this.load();
  }

  load() {
    if (!this.storagePath) return;
    try {
      const stored = JSON.parse(readFileSync(this.storagePath, 'utf8'));
      for (const lease of stored.leases ?? []) {
        if (lease?.sessionId && lease?.clientId && lease?.token && Number.isFinite(lease.expiresAtMs)) {
          this.leases.set(lease.sessionId, lease);
        }
      }
      this.pruneExpired();
    } catch (err) {
      if (err?.code !== 'ENOENT') console.warn('[agentd] failed to load session ownership leases:', err);
    }
  }

  persist() {
    if (!this.storagePath) return;
    const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, leases: [...this.leases.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporaryPath, this.storagePath);
  }

  pruneExpired() {
    let changed = false;
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAtMs <= this.now()) {
        this.leases.delete(sessionId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  get(sessionId) {
    this.pruneExpired();
    return this.leases.get(sessionId) ?? null;
  }

  claim(sessionId, clientId) {
    const existing = this.get(sessionId);
    if (existing && existing.clientId !== clientId) return { ok: false, lease: existing };
    const lease = existing ?? { sessionId, clientId, token: this.createToken(), claimedAtMs: this.now(), expiresAtMs: 0 };
    lease.expiresAtMs = this.now() + this.leaseMs;
    this.leases.set(sessionId, lease);
    this.persist();
    return { ok: true, lease };
  }

  heartbeat(sessionId, token) {
    const lease = this.get(sessionId);
    if (!lease || lease.token !== token) return null;
    lease.expiresAtMs = this.now() + this.leaseMs;
    this.persist();
    return lease;
  }

  release(sessionId, token) {
    const lease = this.get(sessionId);
    if (!lease || lease.token !== token) return false;
    this.leases.delete(sessionId);
    this.persist();
    return true;
  }

  describe(sessionId) {
    const lease = this.get(sessionId);
    if (!lease) return null;
    return {
      client_id: lease.clientId,
      claimed_at: new Date(lease.claimedAtMs).toISOString(),
      expires_at: new Date(lease.expiresAtMs).toISOString(),
    };
  }

  /**
   * Return the cached lease-map size without checking expiry or persisting.
   * This O(1) value is intentionally approximate: an expired lease remains
   * counted until a normal ownership operation prunes it.
   */
  approximateLeaseCount() {
    return this.leases.size;
  }

  list() {
    this.pruneExpired();
    return [...this.leases.values()].map((lease) => ({
      session_id: lease.sessionId,
      ...this.describe(lease.sessionId),
    }));
  }
}
