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
    this.pending = new Map();
    this.tokens = new Map();
    this.load();
  }

  index(record, kind) {
    this.tokens.set(record.token, { kind, sessionId: record.sessionId });
  }

  remove(record, kind) {
    const records = kind === 'pending' ? this.pending : this.leases;
    if (records.get(record.sessionId) === record) records.delete(record.sessionId);
    const indexed = this.tokens.get(record.token);
    if (indexed?.kind === kind && indexed.sessionId === record.sessionId) this.tokens.delete(record.token);
  }

  load() {
    if (!this.storagePath) return;
    try {
      const stored = JSON.parse(readFileSync(this.storagePath, 'utf8'));
      for (const lease of stored.leases ?? []) {
        if (lease?.sessionId && lease?.clientId && lease?.token && Number.isFinite(lease.expiresAtMs)) {
          this.leases.set(lease.sessionId, lease);
          this.index(lease, 'lease');
        }
      }
      for (const reservation of stored.pending ?? []) {
        if (reservation?.sessionId && reservation?.sessionPath && reservation?.clientId && reservation?.token
          && reservation.pending === true && Number.isFinite(reservation.expiresAtMs)) {
          this.pending.set(reservation.sessionId, reservation);
          this.index(reservation, 'pending');
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
    writeFileSync(temporaryPath, JSON.stringify({
      version: 2,
      leases: [...this.leases.values()],
      pending: [...this.pending.values()],
    }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporaryPath, this.storagePath);
  }

  pruneRecord(record, kind) {
    if (!record || record.expiresAtMs > this.now()) return false;
    this.remove(record, kind);
    this.persist();
    return true;
  }

  pruneExpired() {
    let changed = false;
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAtMs <= this.now()) {
        this.remove(lease, 'lease');
        changed = true;
      }
    }
    for (const reservation of [...this.pending.values()]) {
      if (reservation.expiresAtMs <= this.now()) {
        this.remove(reservation, 'pending');
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  get(sessionId) {
    const lease = this.leases.get(sessionId);
    if (lease && !this.pruneRecord(lease, 'lease')) return lease;
    const reservation = this.pending.get(sessionId);
    if (reservation && !this.pruneRecord(reservation, 'pending')) return reservation;
    return null;
  }

  claim(sessionId, clientId) {
    const existing = this.get(sessionId);
    if (existing && existing.clientId !== clientId) return { ok: false, lease: existing };
    if (existing?.pending) return { ok: false, lease: existing };
    const lease = existing ?? { sessionId, clientId, token: this.createToken(), claimedAtMs: this.now(), expiresAtMs: 0 };
    lease.expiresAtMs = this.now() + this.leaseMs;
    this.leases.set(sessionId, lease);
    this.index(lease, 'lease');
    this.persist();
    return { ok: true, lease };
  }

  reserve(sessionId, sessionPath, clientId) {
    const existing = this.get(sessionId);
    if (existing && (existing.clientId !== clientId || !existing.pending || existing.sessionPath !== sessionPath)) {
      return { ok: false, lease: existing };
    }
    const reservation = existing ?? {
      sessionId,
      sessionPath,
      clientId,
      token: this.createToken(),
      claimedAtMs: this.now(),
      expiresAtMs: 0,
      pending: true,
    };
    reservation.expiresAtMs = this.now() + this.leaseMs;
    this.pending.set(sessionId, reservation);
    this.index(reservation, 'pending');
    this.persist();
    return { ok: true, lease: reservation };
  }

  promote(sessionId, sessionPath, token) {
    const indexed = this.tokens.get(token);
    if (!indexed || indexed.sessionId !== sessionId) return null;
    if (indexed.kind === 'lease') {
      const lease = this.leases.get(sessionId);
      if (!lease || this.pruneRecord(lease, 'lease') || lease.promotedFromPath !== sessionPath) return null;
      lease.expiresAtMs = this.now() + this.leaseMs;
      this.persist();
      return lease;
    }
    const reservation = this.pending.get(sessionId);
    if (!reservation || this.pruneRecord(reservation, 'pending') || reservation.sessionPath !== sessionPath) return null;
    this.remove(reservation, 'pending');
    const lease = {
      ...reservation,
      pending: undefined,
      sessionPath: undefined,
      promotedFromPath: sessionPath,
      expiresAtMs: this.now() + this.leaseMs,
    };
    this.leases.set(sessionId, lease);
    this.index(lease, 'lease');
    this.persist();
    return lease;
  }

  byToken(sessionId, token) {
    const indexed = this.tokens.get(token);
    if (!indexed || indexed.sessionId !== sessionId) return null;
    const record = indexed.kind === 'pending' ? this.pending.get(indexed.sessionId) : this.leases.get(indexed.sessionId);
    if (!record || record.token !== token || this.pruneRecord(record, indexed.kind)) return null;
    return { record, kind: indexed.kind };
  }

  heartbeat(sessionId, token) {
    const found = this.byToken(sessionId, token);
    if (!found) return null;
    found.record.expiresAtMs = this.now() + this.leaseMs;
    this.persist();
    return found.record;
  }

  release(sessionId, token) {
    const found = this.byToken(sessionId, token);
    if (!found) return false;
    this.remove(found.record, found.kind);
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
      ...(lease.pending ? { pending: true } : {}),
    };
  }

  /** Cached durable ownership-record count; expiry is intentionally approximate. */
  approximateLeaseCount() {
    return this.leases.size + this.pending.size;
  }

  /** Durable ownership records exposed by the ownership list contract. */
  list() {
    this.pruneExpired();
    return [...this.leases.values(), ...this.pending.values()].map((record) => ({
      session_id: record.sessionId,
      ...this.describe(record.sessionId),
    }));
  }

  /** Fresh durable blockers for authoritative quiescence. */
  quiescenceList() {
    this.pruneExpired();
    return [...this.leases.values(), ...this.pending.values()].map((record) => ({
      session_id: record.sessionId,
      ...this.describe(record.sessionId),
    }));
  }
}
