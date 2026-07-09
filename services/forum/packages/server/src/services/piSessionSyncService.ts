import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { EchsClient } from '../echsClient';
import { classifyPiSession } from './piSessionClassifier';

import type { ForumTarget, SessionClassification } from './piSessionClassifier';

export interface PiSessionSyncOptions {
  enabled: boolean;
  intervalMs: number;
  agentdBaseUrl: string;
}

type PiSessionSummary = {
  id: string;
  path: string;
  cwd?: string | null;
  timestamp?: string | null;
  kind?: string | null;
  mtime_ms?: number | null;
  size_bytes?: number | null;
  parent_session_id?: string | null;
  parent_session_path?: string | null;
};

type PiEntry = {
  type: string;
  id?: string | null;
  parentId?: string | null;
  timestamp?: string | null;
  role?: string | null;
  text?: string;
  hasVisibleText?: boolean;
  contentTypes?: string[];
  api?: string | null;
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  isError?: boolean | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  usage?: unknown;
};

type ExportedSession = {
  session: PiSessionSummary;
  entries: PiEntry[];
  parse_errors?: Array<{ line: number; message: string }>;
};

type SyncTarget = {
  topicId: string;
  sessionId: string;
  liveForumSession: boolean;
};

type ExistingPost = { id: string; body: string; created_at: string };

type PiSyncAnomalyRow = {
  id: string;
  pi_session_id: string;
  pi_message_id: string;
  topic_id: string;
  session_id: string;
  role: string | null;
  status: string;
  reason: string;
  preview: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  next_retry_at: string | null;
  retry_count: number;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  resolution_note: string | null;
  post_id: string | null;
  metadata_json: string | null;
};

export type PiSyncHealth = {
  enabled: boolean;
  running: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunError: string | null;
  lastRunStats: { sessionsChecked: number; postsImported: number; anomaliesProcessed: number } | null;
  counts: Record<string, number>;
  anomalies: Array<{
    id: string;
    piSessionId: string;
    piMessageId: string;
    topicId: string;
    sessionId: string;
    topicTitle: string | null;
    role: string | null;
    status: string;
    reason: string;
    preview: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    lastCheckedAt: string | null;
    nextRetryAt: string | null;
    retryCount: number;
    resolvedAt: string | null;
    resolvedBy: string | null;
    resolution: string | null;
    resolutionNote: string | null;
    postId: string | null;
  }>;
};

export type PiSyncRunResult = { ok: boolean; message: string; sessionsChecked: number; postsImported: number; anomaliesProcessed: number };
export type PiSyncBackfillResult = { ok: boolean; postId?: string; message: string };

const nowIso = () => new Date().toISOString();
const json = (value: unknown): string => JSON.stringify(value ?? null);
const LIVE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const LIVE_ANOMALY_RETRY_LIMIT_MS = 10 * 60 * 1000;
const LIVE_ANOMALY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

function stripArtifactMarkers(text: string): string {
  return text
    .replace(/^\s*\[artifact\s+[^\]]+\]\s*$/gim, '')
    .replace(/^\s*\[forum-attachment\s+[^\]]+\]\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJsonObject(input: string | null): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseTags(input: string | null): string[] {
  try {
    const parsed = input ? (JSON.parse(input) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function normalizePostBodyForDuplicateCheck(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstUserText(entries: PiEntry[]): string {
  return (
    entries.find((entry) => entry.type === 'message' && entry.role === 'user' && entry.text?.trim())?.text?.trim() ?? ''
  );
}

function titleFromText(text: string, fallback: string): string {
  const firstMeaningful = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('==='));
  return (firstMeaningful ?? fallback).replace(/\s+/g, ' ').slice(0, 96).trim() || fallback;
}

function extractForumPostId(text: string): string | null {
  const match = text.match(/\[FORUM TURN\][\s\S]*?\bpostId=([^\n\r]+)[\s\S]*?\[\/FORUM TURN\]/);
  return match?.[1]?.trim() || null;
}

export class PiSessionSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunStartedAt: string | null = null;
  private lastRunFinishedAt: string | null = null;
  private lastRunError: string | null = null;
  private lastRunStats: PiSyncHealth['lastRunStats'] = null;
  private readonly client: EchsClient;

  constructor(
    private readonly db: Database.Database,
    options: { agentdBaseUrl: string; apiToken?: string | null; intervalMs: number }
  ) {
    this.client = new EchsClient({ baseUrl: options.agentdBaseUrl, apiToken: options.apiToken ?? null });
    this.intervalMs = options.intervalMs;
  }

  private readonly intervalMs: number;

  start(): void {
    if (this.timer) return;
    const tick = () =>
      void this.syncChanged().catch((err) =>
        console.warn('[pi-sync] failed:', err instanceof Error ? err.message : err)
      );
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): { running: boolean; intervalMs: number; enabled: boolean } {
    return { running: this.running, intervalMs: this.intervalMs, enabled: Boolean(this.timer) };
  }

  async waitForIdle(timeoutMs = 0): Promise<boolean> {
    const started = Date.now();
    while (this.running) {
      if (timeoutMs > 0 && Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return true;
  }

  async syncChanged(): Promise<void> {
    await this.runSync({ changedOnly: true });
  }

  async runManualSync(piSessionId?: string | null): Promise<PiSyncRunResult> {
    return this.runSync({ changedOnly: false, piSessionId: piSessionId ?? null });
  }

  private async runSync(opts: { changedOnly: boolean; piSessionId?: string | null }): Promise<PiSyncRunResult> {
    if (this.running) return { ok: false, message: 'Pi sync is already running.', sessionsChecked: 0, postsImported: 0, anomaliesProcessed: 0 };
    this.running = true;
    this.lastRunStartedAt = nowIso();
    this.lastRunError = null;
    try {
      this.seedLegacySkippedAnomalies();
      const listed = await this.client.listPiSessions();
      const sessions = ((listed?.sessions ?? []) as PiSessionSummary[]).filter((summary) =>
        opts.piSessionId ? summary.id === opts.piSessionId : true
      );
      let checked = 0;
      let importedPosts = 0;
      for (const summary of sessions) {
        if (opts.changedOnly && !this.needsSync(summary)) continue;
        try {
          const exported = (await this.client.exportPiSession(summary.id)) as ExportedSession | null;
          if (!exported) continue;
          importedPosts += this.importExported(exported, summary);
          checked += 1;
        } catch (err) {
          console.warn('[pi-sync] session failed:', summary.id, err instanceof Error ? err.message : err);
        }
      }
      const anomaliesProcessed = await this.processDueAnomalies();
      this.lastRunFinishedAt = nowIso();
      this.lastRunStats = { sessionsChecked: checked, postsImported: importedPosts, anomaliesProcessed };
      if (checked > 0 || importedPosts > 0 || anomaliesProcessed > 0) {
        console.log(`[pi-sync] synced=${checked} posts=${importedPosts} anomalies=${anomaliesProcessed}`);
      }
      return { ok: true, message: 'Pi sync completed.', sessionsChecked: checked, postsImported: importedPosts, anomaliesProcessed };
    } catch (err) {
      this.lastRunError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.running = false;
    }
  }

  private seedLegacySkippedAnomalies(): void {
    const now = nowIso();
    const rows = this.db
      .prepare(
        `select l.pi_session_id, l.pi_message_id, l.role, l.metadata_json, s.topic_id, s.session_id
         from pi_message_links l
         join pi_session_links s on s.pi_session_id = l.pi_session_id
         left join pi_sync_anomalies a on a.pi_session_id = l.pi_session_id
          and a.pi_message_id = l.pi_message_id
          and a.reason = 'live-topic-unmatched-visible-message'
         where l.post_id is null
           and json_extract(l.metadata_json, '$.skippedLiveForumPost') = 1
           and a.id is null
         limit 500`
      )
      .all() as Array<{ pi_session_id: string; pi_message_id: string; role: string | null; metadata_json: string | null; topic_id: string; session_id: string }>;
    const insert = this.db.prepare(
      `insert or ignore into pi_sync_anomalies
       (id, pi_session_id, pi_message_id, topic_id, session_id, role, status, reason, preview, first_seen_at, last_seen_at, last_checked_at, next_retry_at, retry_count, metadata_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const meta = parseJsonObject(row.metadata_json);
        const timestamp = typeof meta['timestamp'] === 'string' ? meta['timestamp'] : now;
        insert.run(
          randomUUID(),
          row.pi_session_id,
          row.pi_message_id,
          row.topic_id,
          row.session_id,
          row.role,
          'needs_manual_review',
          'live-topic-unmatched-visible-message',
          null,
          timestamp,
          now,
          now,
          null,
          0,
          json({ ...meta, seededFromLegacySkippedLiveForumPost: true })
        );
      }
    });
    if (rows.length > 0) tx();
  }

  getHealth(): PiSyncHealth {
    this.seedLegacySkippedAnomalies();
    const counts: Record<string, number> = {};
    const countRows = this.db
      .prepare('select status, count(*) as count from pi_sync_anomalies group by status')
      .all() as Array<{ status: string; count: number }>;
    for (const row of countRows) counts[row.status] = row.count;

    const rows = this.db
      .prepare(
        `select a.*, t.title as topic_title
         from pi_sync_anomalies a
         left join topics t on t.id = a.topic_id
         where a.status in ('deferred', 'needs_manual_review')
         order by case a.status when 'needs_manual_review' then 0 else 1 end, a.first_seen_at asc
         limit 100`
      )
      .all() as Array<PiSyncAnomalyRow & { topic_title: string | null }>;

    return {
      enabled: true,
      running: this.running,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastRunError: this.lastRunError,
      lastRunStats: this.lastRunStats,
      counts,
      anomalies: rows.map((row) => ({
        id: row.id,
        piSessionId: row.pi_session_id,
        piMessageId: row.pi_message_id,
        topicId: row.topic_id,
        sessionId: row.session_id,
        topicTitle: row.topic_title,
        role: row.role,
        status: row.status,
        reason: row.reason,
        preview: row.preview,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastCheckedAt: row.last_checked_at,
        nextRetryAt: row.next_retry_at,
        retryCount: row.retry_count,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        resolution: row.resolution,
        resolutionNote: row.resolution_note,
        postId: row.post_id,
      })),
    };
  }

  ignoreAnomaly(anomalyId: string, resolvedBy: string, note?: string | null): PiSyncBackfillResult {
    const now = nowIso();
    const result = this.db
      .prepare(
        `update pi_sync_anomalies
         set status = 'ignored', resolved_at = ?, resolved_by = ?, resolution = 'ignored', resolution_note = ?
         where id = ? and status in ('deferred', 'needs_manual_review')`
      )
      .run(now, resolvedBy, note ?? null, anomalyId);
    return result.changes > 0 ? { ok: true, message: 'Anomaly ignored.' } : { ok: false, message: 'Active anomaly not found.' };
  }

  async backfillAnomaly(anomalyId: string, opts?: { bumpTopic?: boolean; resolvedBy?: string | null }): Promise<PiSyncBackfillResult> {
    const anomaly = this.db.prepare('select * from pi_sync_anomalies where id = ? limit 1').get(anomalyId) as PiSyncAnomalyRow | undefined;
    if (!anomaly) return { ok: false, message: 'Anomaly not found.' };
    if (!['deferred', 'needs_manual_review'].includes(anomaly.status)) return { ok: false, message: `Anomaly is ${anomaly.status}.` };
    const exported = (await this.client.exportPiSession(anomaly.pi_session_id)) as ExportedSession | null;
    if (!exported) return { ok: false, message: 'Pi session could not be exported.' };
    const entry = exported.entries.find((candidate) => candidate.id === anomaly.pi_message_id);
    if (!entry || entry.type !== 'message' || !entry.hasVisibleText || !entry.role) return { ok: false, message: 'Visible Pi message not found.' };
    const text = entry.role === 'assistant' ? stripArtifactMarkers(entry.text ?? '') : entry.text ?? '';
    if (!text.trim()) return { ok: false, message: 'Pi message has no visible text to backfill.' };
    const authorId = this.ensureIdentity(entry.role === 'user' ? 'Pi CLI' : 'Monika', entry.role === 'user' ? 'system' : 'robot', entry.role === 'user' ? '/avatars/pi-cli.gif' : '/avatars/monika.png');
    const existing = this.findUnlinkedMatchingPost(anomaly.topic_id, authorId, text, entry.timestamp ?? null);
    const now = nowIso();
    const postId = existing?.id ?? randomUUID();
    const sessionMessageId = existing ? null : randomUUID();
    const at = entry.timestamp ?? now;
    this.db.transaction(() => {
      if (!existing) {
        this.db
          .prepare(
            'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(postId, anomaly.topic_id, null, null, authorId, text, entry.id, opts?.bumpTopic ? 0 : 1, at, null, null);
        this.db
          .prepare('insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)')
          .run(sessionMessageId, anomaly.session_id, entry.role, text, at, 'public');
      }
      this.db
        .prepare('update pi_message_links set post_id = coalesce(post_id, ?), session_message_id = coalesce(session_message_id, ?), metadata_json = ? where pi_session_id = ? and pi_message_id = ?')
        .run(postId, sessionMessageId, json({ backfilledFromAnomaly: true }), anomaly.pi_session_id, anomaly.pi_message_id);
      this.db
        .prepare(
          `update pi_sync_anomalies
           set status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, post_id = ?, last_checked_at = ?
           where id = ?`
        )
        .run(now, opts?.resolvedBy ?? null, existing ? 'matched_existing_post' : 'backfilled', postId, now, anomaly.id);
      if (opts?.bumpTopic) this.db.prepare('update topics set updated_at = ? where id = ?').run(now, anomaly.topic_id);
    })();
    return { ok: true, postId, message: existing ? 'Anomaly linked to an existing post.' : 'Anomaly backfilled as a forum post.' };
  }

  private needsSync(summary: PiSessionSummary): boolean {
    const link = this.db.prepare('select * from pi_session_links where pi_session_id = ? limit 1').get(summary.id) as
      | { imported_at: string; metadata_json: string | null }
      | undefined;
    if (!link) return true;
    const meta = parseJsonObject(link.metadata_json);
    if (meta['mtimeMs'] === summary.mtime_ms && meta['sizeBytes'] === summary.size_bytes) return false;
    const importedAt = Date.parse(link.imported_at);
    const mtime = typeof summary.mtime_ms === 'number' ? summary.mtime_ms : 0;
    return !Number.isFinite(importedAt) || mtime > importedAt;
  }

  private importExported(exported: ExportedSession, summary: PiSessionSummary): number {
    return this.db.transaction(() => {
      const classification = classifyPiSession(exported.session, exported.entries);
      const target = this.ensureSession(exported, summary, classification);
      return this.importMessages(exported, target, summary);
    })();
  }

  private ensureIdentity(displayName: string, kind: string, avatarUrl: string | null): string {
    const existing = this.db.prepare('select id from identities where display_name = ? limit 1').get(displayName) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, null, displayName, kind, null, avatarUrl, now, now);
    return id;
  }

  private ensureForum(name: string, parentForumId: string | null = null, cwd: string | null = null): string {
    const existing = this.db
      .prepare('select id, cwd from forums where name = ? and parent_forum_id is ? order by created_at asc limit 1')
      .get(name, parentForumId) as { id: string; cwd: string | null } | undefined;
    if (existing) {
      if (existing.cwd === null && cwd !== null) {
        this.db.prepare('update forums set cwd = ?, updated_at = ? where id = ?').run(cwd, nowIso(), existing.id);
      }
      return existing.id;
    }
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        null,
        parentForumId,
        null,
        name,
        name === 'System' ? 'System/imported Pi sessions' : `Imported Pi sessions: ${name}`,
        cwd,
        null,
        'active',
        'public',
        null,
        now,
        now
      );
    return id;
  }

  private targetForum(target: ForumTarget, cwd: string | null): string {
    if (target.parent) return this.ensureForum(target.name, this.ensureForum(target.parent, null, cwd), cwd);
    return this.ensureForum(target.name, null, cwd);
  }

  private ensureSession(
    exported: ExportedSession,
    summary: PiSessionSummary,
    classification: SessionClassification
  ): SyncTarget {
    const existing = this.db
      .prepare(
        `select l.topic_id as topicId,
                l.session_id as sessionId,
                l.metadata_json as metadataJson,
                t.tags_json as tagsJson
         from pi_session_links l
         left join topics t on t.id = l.topic_id
         where l.pi_session_id = ?
         limit 1`
      )
      .get(exported.session.id) as
      | { topicId: string; sessionId: string; metadataJson: string | null; tagsJson: string | null }
      | undefined;
    const previousMeta = existing ? parseJsonObject(existing.metadataJson) : {};
    const meta = {
      ...previousMeta,
      mtimeMs: summary.mtime_ms ?? null,
      sizeBytes: summary.size_bytes ?? null,
      parseErrors: exported.parse_errors ?? [],
      classificationReason: classification.reason,
      classificationForumCwd: classification.forumCwd,
    };
    if (existing) {
      const tags = parseTags(existing.tagsJson);
      const liveForumSession = !tags.includes('pi-sync');
      this.db
        .prepare(
          `update pi_session_links
           set imported_at = ?,
               metadata_json = ?,
               parent_pi_session_id = coalesce(parent_pi_session_id, ?),
               parent_pi_session_path = coalesce(parent_pi_session_path, ?),
               lineage_kind = case when lineage_kind is null and (? is not null or ? is not null) then 'parent' else lineage_kind end,
               lineage_source = case when lineage_source is null and (? is not null or ? is not null) then 'pi-jsonl-header' else lineage_source end
           where pi_session_id = ?`
        )
        .run(
          nowIso(),
          json(meta),
          summary.parent_session_id ?? null,
          summary.parent_session_path ?? null,
          summary.parent_session_id ?? null,
          summary.parent_session_path ?? null,
          summary.parent_session_id ?? null,
          summary.parent_session_path ?? null,
          exported.session.id
        );
      return { topicId: existing.topicId, sessionId: existing.sessionId, liveForumSession };
    }
    const neonId = this.ensureIdentity('Pi CLI', 'system', '/avatars/pi-cli.gif');
    const forumId = this.targetForum(classification.target, classification.forumCwd);
    const topicId = randomUUID();
    const sessionId = randomUUID();
    const createdAt = exported.session.timestamp ?? nowIso();
    const title = titleFromText(firstUserText(exported.entries), `Pi session ${exported.session.id.slice(0, 8)}`);
    this.db
      .prepare(
        'insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        topicId,
        forumId,
        null,
        title,
        'open',
        JSON.stringify(['pi-sync', classification.kind]),
        'manual',
        neonId,
        createdAt,
        createdAt
      );
    this.db
      .prepare(
        'insert into sessions (id, topic_id, codex_thread_id, agent_thread_id, agent_backend, personas_synced_at, last_dispatched_post_id, created_at, updated_at, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(sessionId, topicId, null, null, 'echs', null, null, createdAt, createdAt, 'active');
    this.db
      .prepare(
        'insert into pi_session_links (id, pi_session_id, pi_session_path, topic_id, session_id, cwd, kind, pi_timestamp, imported_at, last_import_run_id, metadata_json, parent_pi_session_id, parent_pi_session_path, lineage_kind, lineage_source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        randomUUID(),
        exported.session.id,
        exported.session.path,
        topicId,
        sessionId,
        exported.session.cwd ?? null,
        classification.kind,
        exported.session.timestamp ?? null,
        nowIso(),
        null,
        json(meta),
        summary.parent_session_id ?? null,
        summary.parent_session_path ?? null,
        summary.parent_session_id || summary.parent_session_path ? 'parent' : null,
        summary.parent_session_id || summary.parent_session_path ? 'pi-jsonl-header' : null
      );
    return { topicId, sessionId, liveForumSession: false };
  }

  private findUnlinkedMatchingPost(
    topicId: string,
    authorId: string,
    text: string,
    createdNear: string | null | undefined
  ): ExistingPost | null {
    const exact = this.db
      .prepare(
        'select p.id, p.body, p.created_at from posts p left join pi_message_links l on l.post_id = p.id where p.topic_id = ? and p.author_id = ? and p.body = ? and p.deleted_at is null and l.id is null order by p.created_at desc limit 1'
      )
      .get(topicId, authorId, text) as ExistingPost | undefined;
    if (exact) return exact;

    const center = createdNear ? Date.parse(createdNear) : Date.now();
    const effectiveCenter = Number.isFinite(center) ? center : Date.now();
    const start = new Date(effectiveCenter - LIVE_DUPLICATE_WINDOW_MS).toISOString();
    const end = new Date(effectiveCenter + LIVE_DUPLICATE_WINDOW_MS).toISOString();
    const normalized = normalizePostBodyForDuplicateCheck(text);
    const candidates = this.db
      .prepare(
        `select p.id, p.body, p.created_at
         from posts p
         left join pi_message_links l on l.post_id = p.id
         where p.topic_id = ?
           and p.author_id = ?
           and p.deleted_at is null
           and l.id is null
           and p.created_at between ? and ?
         order by p.created_at desc
         limit 20`
      )
      .all(topicId, authorId, start, end) as ExistingPost[];
    return candidates.find((post) => normalizePostBodyForDuplicateCheck(post.body) === normalized) ?? null;
  }

  private anomalyStatus(firstSeenAt: string, now = Date.now()): 'deferred' | 'needs_manual_review' {
    const firstSeen = Date.parse(firstSeenAt);
    return Number.isFinite(firstSeen) && now - firstSeen > LIVE_ANOMALY_RETRY_LIMIT_MS ? 'needs_manual_review' : 'deferred';
  }

  private nextRetryAt(retryCount: number, now = Date.now()): string | null {
    const delay = LIVE_ANOMALY_BACKOFF_MS[Math.min(retryCount, LIVE_ANOMALY_BACKOFF_MS.length - 1)];
    return delay ? new Date(now + delay).toISOString() : null;
  }

  private recordLiveForumAnomaly(target: SyncTarget, entry: PiEntry, text: string, summary: PiSessionSummary, metadata: unknown): void {
    const now = nowIso();
    const existing = this.db
      .prepare('select * from pi_sync_anomalies where pi_session_id = ? and pi_message_id = ? and reason = ? limit 1')
      .get(summary.id, entry.id, 'live-topic-unmatched-visible-message') as PiSyncAnomalyRow | undefined;
    const firstSeenAt = existing?.first_seen_at ?? now;
    const retryCount = existing?.retry_count ?? 0;
    const status = this.anomalyStatus(firstSeenAt);
    const nextRetry = status === 'deferred' ? existing?.next_retry_at ?? this.nextRetryAt(retryCount) : null;
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 240);
    if (existing) {
      if (['resolved', 'ignored'].includes(existing.status)) return;
      this.db
        .prepare(
          `update pi_sync_anomalies
           set topic_id = ?, session_id = ?, role = ?, status = ?, preview = ?, last_seen_at = ?, next_retry_at = ?, metadata_json = ?
           where id = ?`
        )
        .run(target.topicId, target.sessionId, entry.role ?? null, status, preview, now, nextRetry, json(metadata), existing.id);
      return;
    }
    this.db
      .prepare(
        `insert into pi_sync_anomalies
         (id, pi_session_id, pi_message_id, topic_id, session_id, role, status, reason, preview, first_seen_at, last_seen_at, last_checked_at, next_retry_at, retry_count, metadata_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        summary.id,
        entry.id,
        target.topicId,
        target.sessionId,
        entry.role ?? null,
        status,
        'live-topic-unmatched-visible-message',
        preview,
        firstSeenAt,
        now,
        null,
        nextRetry,
        retryCount,
        json(metadata)
      );
  }

  private insertMessageLink(opts: {
    piSessionId: string;
    piMessageId: string;
    postId: string | null;
    sessionMessageId: string | null;
    role: string | null | undefined;
    metadata: unknown;
  }): void {
    this.db
      .prepare(
        'insert or ignore into pi_message_links (id, pi_session_id, pi_message_id, post_id, session_message_id, role, imported_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        randomUUID(),
        opts.piSessionId,
        opts.piMessageId,
        opts.postId,
        opts.sessionMessageId,
        opts.role ?? null,
        nowIso(),
        json(opts.metadata)
      );
  }

  private async processDueAnomalies(): Promise<number> {
    const now = nowIso();
    const rows = this.db
      .prepare(
        `select * from pi_sync_anomalies
         where status = 'deferred' and (next_retry_at is null or next_retry_at <= ?)
         order by first_seen_at asc
         limit 25`
      )
      .all(now) as PiSyncAnomalyRow[];
    let processed = 0;
    for (const anomaly of rows) {
      processed += 1;
      try {
        const exported = (await this.client.exportPiSession(anomaly.pi_session_id)) as ExportedSession | null;
        const entry = exported?.entries.find((candidate) => candidate.id === anomaly.pi_message_id);
        if (!entry) {
          this.bumpAnomalyRetry(anomaly, 'Pi message not present in exported session.');
          continue;
        }
        const text = entry.role === 'assistant' ? stripArtifactMarkers(entry.text ?? '') : entry.text ?? '';
        const authorId = this.ensureIdentity(entry.role === 'user' ? 'Pi CLI' : 'Monika', entry.role === 'user' ? 'system' : 'robot', entry.role === 'user' ? '/avatars/pi-cli.gif' : '/avatars/monika.png');
        const existing = this.findUnlinkedMatchingPost(anomaly.topic_id, authorId, text, entry.timestamp ?? null);
        if (existing) {
          const resolvedAt = nowIso();
          this.db.transaction(() => {
            this.db
              .prepare('update pi_message_links set post_id = coalesce(post_id, ?), metadata_json = ? where pi_session_id = ? and pi_message_id = ?')
              .run(existing.id, json({ reconciledExistingPost: true, resolvedAnomaly: true }), anomaly.pi_session_id, anomaly.pi_message_id);
            this.db
              .prepare("update pi_sync_anomalies set status = 'resolved', resolved_at = ?, resolution = 'matched_existing_post', post_id = ?, last_checked_at = ? where id = ?")
              .run(resolvedAt, existing.id, resolvedAt, anomaly.id);
          })();
          continue;
        }
        this.bumpAnomalyRetry(anomaly, null);
      } catch (err) {
        this.bumpAnomalyRetry(anomaly, err instanceof Error ? err.message : String(err));
      }
    }
    return processed;
  }

  private bumpAnomalyRetry(anomaly: PiSyncAnomalyRow, error: string | null): void {
    const checkedAt = nowIso();
    const retryCount = anomaly.retry_count + 1;
    const firstSeen = Date.parse(anomaly.first_seen_at);
    const status = Number.isFinite(firstSeen) && Date.now() - firstSeen > LIVE_ANOMALY_RETRY_LIMIT_MS ? 'needs_manual_review' : 'deferred';
    const nextRetry = status === 'deferred' ? this.nextRetryAt(retryCount) : null;
    const meta = { ...parseJsonObject(anomaly.metadata_json), lastRetryError: error };
    this.db
      .prepare('update pi_sync_anomalies set status = ?, retry_count = ?, last_checked_at = ?, next_retry_at = ?, metadata_json = ? where id = ?')
      .run(status, retryCount, checkedAt, nextRetry, json(meta), anomaly.id);
  }

  private importMessages(exported: ExportedSession, target: SyncTarget, summary: PiSessionSummary): number {
    const { topicId, sessionId, liveForumSession } = target;
    const neonId = this.ensureIdentity('Pi CLI', 'system', '/avatars/pi-cli.gif');
    const robotId = this.ensureIdentity('Monika', 'robot', '/avatars/monika.png');
    let count = 0;
    let lastPostAt = exported.session.timestamp ?? nowIso();
    for (const entry of exported.entries) {
      if (entry.type !== 'message' || !entry.id) continue;
      const exists = this.db
        .prepare('select id from pi_message_links where pi_session_id = ? and pi_message_id = ? limit 1')
        .get(exported.session.id, entry.id);
      if (exists) continue;
      const metadata = {
        parentId: entry.parentId ?? null,
        timestamp: entry.timestamp ?? null,
        contentTypes: entry.contentTypes ?? [],
        stopReason: entry.stopReason ?? null,
        errorMessage: entry.errorMessage ?? null,
        usage: entry.usage ?? null,
        mtimeMs: summary.mtime_ms ?? null,
        sizeBytes: summary.size_bytes ?? null,
      };
      const rawText = entry.text ?? '';
      const text = entry.role === 'assistant' ? stripArtifactMarkers(rawText) : rawText;
      const forumPostId = extractForumPostId(rawText);
      if (forumPostId) {
        const postExists = this.db.prepare('select id from posts where id = ? limit 1').get(forumPostId) as
          | { id: string }
          | undefined;
        if (postExists) {
          this.db
            .prepare(
              'insert or ignore into pi_message_links (id, pi_session_id, pi_message_id, post_id, session_message_id, role, imported_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              randomUUID(),
              exported.session.id,
              entry.id,
              forumPostId,
              null,
              entry.role ?? null,
              nowIso(),
              json({ ...metadata, forumOrigin: true })
            );
          continue;
        }
      }
      if (entry.hasVisibleText && (entry.role === 'user' || entry.role === 'assistant')) {
        const authorId = entry.role === 'user' ? neonId : robotId;
        const existingPost = this.findUnlinkedMatchingPost(topicId, authorId, text, entry.timestamp ?? null);
        if (existingPost) {
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: existingPost.id,
            sessionMessageId: null,
            role: entry.role,
            metadata: { ...metadata, reconciledExistingPost: true },
          });
          continue;
        }

        if (liveForumSession) {
          const anomalyMetadata = { ...metadata, deferredLiveForumPost: true };
          this.recordLiveForumAnomaly(target, entry, text, summary, anomalyMetadata);
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: null,
            sessionMessageId: null,
            role: entry.role,
            metadata: anomalyMetadata,
          });
          continue;
        }

        const postId = randomUUID();
        const sessionMessageId = randomUUID();
        const at = entry.timestamp ?? lastPostAt;
        lastPostAt = at;
        this.db
          .prepare(
            'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(postId, topicId, null, null, authorId, text, entry.id, 0, at, null, null);
        this.db
          .prepare(
            'insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)'
          )
          .run(sessionMessageId, sessionId, entry.role, text, at, 'public');
        this.insertMessageLink({
          piSessionId: exported.session.id,
          piMessageId: entry.id,
          postId,
          sessionMessageId,
          role: entry.role,
          metadata,
        });
        count += 1;
      } else {
        this.insertMessageLink({
          piSessionId: exported.session.id,
          piMessageId: entry.id,
          postId: null,
          sessionMessageId: null,
          role: entry.role,
          metadata: { ...metadata, skippedVisiblePost: true },
        });
      }
    }
    this.db.prepare('update topics set updated_at = ? where id = ?').run(lastPostAt, topicId);
    this.db.prepare('update sessions set updated_at = ? where id = ?').run(lastPostAt, sessionId);
    return count;
  }
}
