import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso, type OneTimeLinkRow } from '../db';

export interface OneTimeLink {
  token: string;
  url: string;
  expiresAt: string;
}

export interface OneTimeLinkIssuer {
  issue(userId: string, ttlSeconds?: number): Promise<OneTimeLink>;
  verify(token: string): Promise<{ ok: boolean; userId?: string }>;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export class SqliteOneTimeLinkIssuer implements OneTimeLinkIssuer {
  constructor(
    private readonly db: Database.Database,
    private readonly baseUrl: string
  ) {}

  async issue(userId: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<OneTimeLink> {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const createdAt = now.toISOString();

    this.db
      .prepare(
        'INSERT INTO one_time_links (token, identity_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(token, userId, expiresAt, null, createdAt);

    return {
      token,
      url: `${this.baseUrl}/auth/verify/${token}`,
      expiresAt
    };
  }

  async verify(token: string): Promise<{ ok: boolean; userId?: string }> {
    const row = this.db
      .prepare('SELECT * FROM one_time_links WHERE token = ?')
      .get(token) as OneTimeLinkRow | undefined;

    if (!row) {
      return { ok: false };
    }

    // Check if already used
    if (row.used_at) {
      return { ok: false };
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(row.expires_at);
    if (now > expiresAt) {
      return { ok: false };
    }

    // Mark as used
    const usedAt = nowIso();
    this.db
      .prepare('UPDATE one_time_links SET used_at = ? WHERE token = ?')
      .run(usedAt, token);

    return { ok: true, userId: row.identity_id ?? undefined } as { ok: boolean; userId?: string };
  }

  getLink(token: string): OneTimeLinkRow | null {
    const row = this.db
      .prepare('SELECT * FROM one_time_links WHERE token = ?')
      .get(token) as OneTimeLinkRow | undefined;
    return row ?? null;
  }

  listByUser(userId: string): OneTimeLinkRow[] {
    return this.db
      .prepare('SELECT * FROM one_time_links WHERE identity_id = ? ORDER BY created_at DESC')
      .all(userId) as OneTimeLinkRow[];
  }

  cleanupExpired(): number {
    const now = nowIso();
    const result = this.db
      .prepare('DELETE FROM one_time_links WHERE expires_at < ?')
      .run(now);
    return result.changes;
  }
}
