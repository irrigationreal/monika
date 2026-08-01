import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { EchsClient } from '../echsClient';
import { ForumStore } from '../store';
import { classifyPiSession } from './piSessionClassifier';
import { isSubagentPiSession, omitSubagentPiSessions } from './piSessionPolicy';

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

export type PiEntry = {
  type: string;
  id?: string | null;
  parentId?: string | null;
  timestamp?: string | null;
  role?: string | null;
  text?: string;
  hasVisibleText?: boolean;
  contentTypes?: string[];
  customType?: string | null;
  data?: unknown;
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

export type PiMessageProvenance = {
  entryId?: string | null;
  parentId?: string | null;
  timestamp?: string | null;
  piMessageId: string;
  origin: string;
  topicId?: string | null;
  postId?: string | null;
  messageKind?: string | null;
  source_kind?: string | null;
  sourceKind?: string | null;
  run_id?: string | null;
  runId?: string | null;
  run_ids?: string[] | null;
  runIds?: string[] | null;
  origin_turn_id?: string | null;
  originTurnId?: string | null;
  origin_post_id?: string | null;
  originPostId?: string | null;
  origin_topic_id?: string | null;
  originTopicId?: string | null;
};

export type ExportedSession = {
  session: PiSessionSummary;
  entries: PiEntry[];
  active_branch?: { leaf_entry_id: string | null; active_entry_ids: string[] };
  message_provenance?: PiMessageProvenance[];
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

export type PiSyncRunResult = {
  ok: boolean;
  message: string;
  sessionsChecked: number;
  postsImported: number;
  anomaliesProcessed: number;
};
export type PiSyncBackfillResult = { ok: boolean; postId?: string; message: string };
export type PiSyncRepairCandidate = {
  piSessionId: string;
  piMessageId: string;
  topicId: string;
  postId: string | null;
  action: 'link_existing_post' | 'project_silently' | 'defer_to_bridge' | 'await_settlement' | 'no_post';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};
export type PiSyncRepairInventory = { generatedAt: string; candidates: PiSyncRepairCandidate[] };

const nowIso = () => new Date().toISOString();
const json = (value: unknown): string => JSON.stringify(value ?? null);
const LIVE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const LIVE_ANOMALY_RETRY_LIMIT_MS = 10 * 60 * 1000;
const LIVE_ANOMALY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
const EXTERNAL_SETTLEMENT_MS = 60_000;

function provenanceSourceKind(value: PiMessageProvenance | undefined): string | null {
  return value?.sourceKind ?? value?.source_kind ?? (value?.origin === 'subagent-completion' ? value.origin : null);
}

function provenanceRunIds(value: PiMessageProvenance | undefined): string[] {
  const primary = value?.runId ?? value?.run_id ?? null;
  const list = value?.runIds ?? value?.run_ids ?? [];
  return [...new Set([...(Array.isArray(list) ? list : []), ...(primary ? [primary] : [])]
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map((id) => id.trim()))].slice(0, 100);
}

function provenanceOriginPostId(value: PiMessageProvenance | undefined): string | null {
  return value?.originPostId ?? value?.origin_post_id ?? value?.postId ?? null;
}

function provenanceOriginTopicId(value: PiMessageProvenance | undefined): string | null {
  return value?.originTopicId ?? value?.origin_topic_id ?? value?.topicId ?? null;
}

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

type HistoricalTerminalError = {
  userEntryId: string;
  assistantEntryId: string;
  error: string;
};

/**
 * Finds only the final unrecovered provider failure in each active-branch user
 * turn. Pi can emit an error, compact/retry, and then emit a successful
 * assistant message in the same turn; those recovered attempts must stay
 * invisible in the historical forum projection.
 */
export function detectHistoricalTerminalErrors(exported: ExportedSession): HistoricalTerminalError[] {
  const activeIds = new Set(
    exported.active_branch?.active_entry_ids ?? exported.entries.flatMap((entry) => (entry.id ? [entry.id] : []))
  );
  const found: HistoricalTerminalError[] = [];
  let userEntryId: string | null = null;
  let terminalError: PiEntry | null = null;

  const flush = () => {
    if (userEntryId && terminalError?.id && terminalError.errorMessage) {
      found.push({ userEntryId, assistantEntryId: terminalError.id, error: terminalError.errorMessage });
    }
    terminalError = null;
  };

  for (const entry of exported.entries) {
    if (!entry.id || !activeIds.has(entry.id) || entry.type !== 'message') continue;
    if (entry.role === 'user') {
      flush();
      userEntryId = entry.id;
      continue;
    }
    if (entry.role !== 'assistant' || !userEntryId) continue;
    if (entry.stopReason === 'error' && entry.errorMessage) {
      terminalError = entry;
    } else if (terminalError && entry.stopReason && entry.stopReason !== 'error') {
      // Match Pi's settled-turn semantics: any later non-error assistant end
      // means the failed attempt recovered, including compact-and-retry flows.
      terminalError = null;
    }
  }
  flush();
  return found;
}

function classifyHistoricalProviderError(error: string): string | null {
  const text = error.toLowerCase();
  if (
    /context (?:length|window)|maximum context|context limit|too many tokens|prompt (?:is )?too long|token limit/.test(
      text
    )
  ) {
    return 'context_overflow';
  }
  if (/\brate[ -]?limit|\btoo many requests\b|\b429\b|quota exceeded/.test(text)) return 'rate_limit';
  if (
    /\bauthentication\b|\bunauthorized\b|\bforbidden\b|invalid (?:api )?key|api key.*(?:invalid|missing)|\b40[13]\b/.test(
      text
    )
  ) {
    return 'authentication';
  }
  if (
    /\bprovider\b|\bupstream\b|service unavailable|temporarily unavailable|overloaded|internal server error|\b50[0234]\b/.test(
      text
    )
  ) {
    return 'provider';
  }
  return null;
}

export class PiSessionSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunStartedAt: string | null = null;
  private lastRunFinishedAt: string | null = null;
  private lastRunError: string | null = null;
  private lastRunStats: PiSyncHealth['lastRunStats'] = null;
  private readonly client: EchsClient;
  private readonly store: ForumStore;

  constructor(
    private readonly db: Database.Database,
    options: { agentdBaseUrl: string; apiToken?: string | null; intervalMs: number }
  ) {
    this.client = new EchsClient({ baseUrl: options.agentdBaseUrl, apiToken: options.apiToken ?? null });
    this.store = new ForumStore(db);
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
    if (this.running)
      return {
        ok: false,
        message: 'Pi sync is already running.',
        sessionsChecked: 0,
        postsImported: 0,
        anomaliesProcessed: 0,
      };
    this.running = true;
    this.lastRunStartedAt = nowIso();
    this.lastRunError = null;
    try {
      this.seedLegacySkippedAnomalies();
      const listed = await this.client.listPiSessions();
      const sessions = omitSubagentPiSessions((listed?.sessions ?? []) as PiSessionSummary[]).filter((summary) =>
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
      return {
        ok: true,
        message: 'Pi sync completed.',
        sessionsChecked: checked,
        postsImported: importedPosts,
        anomaliesProcessed,
      };
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
      .all() as Array<{
      pi_session_id: string;
      pi_message_id: string;
      role: string | null;
      metadata_json: string | null;
      topic_id: string;
      session_id: string;
    }>;
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

  getRepairInventory(): PiSyncRepairInventory {
    const rows = this.db
      .prepare(
        `select a.pi_session_id, a.pi_message_id, a.topic_id, a.reason, a.post_id,
              l.metadata_json
       from pi_sync_anomalies a
       left join pi_message_links l on l.pi_session_id = a.pi_session_id and l.pi_message_id = a.pi_message_id
       where a.status in ('deferred', 'needs_manual_review')
       order by a.first_seen_at asc`
      )
      .all() as Array<{
      pi_session_id: string;
      pi_message_id: string;
      topic_id: string;
      reason: string;
      post_id: string | null;
      metadata_json: string | null;
    }>;
    const candidates = rows.map((row): PiSyncRepairCandidate => {
      const meta = parseJsonObject(row.metadata_json);
      if (row.reason === 'forum-origin-awaiting-bridge')
        return {
          piSessionId: row.pi_session_id,
          piMessageId: row.pi_message_id,
          topicId: row.topic_id,
          postId: row.post_id,
          action: 'defer_to_bridge',
          confidence: 'high',
          reason: row.reason,
        };
      if (row.reason === 'external-message-settling')
        return {
          piSessionId: row.pi_session_id,
          piMessageId: row.pi_message_id,
          topicId: row.topic_id,
          postId: row.post_id,
          action: 'await_settlement',
          confidence: 'high',
          reason: row.reason,
        };
      const legacy = Boolean(meta['skippedLiveForumPost'] || meta['deferredLiveForumPost']);
      return {
        piSessionId: row.pi_session_id,
        piMessageId: row.pi_message_id,
        topicId: row.topic_id,
        postId: row.post_id,
        action: legacy ? 'project_silently' : 'no_post',
        confidence: legacy ? 'high' : 'low',
        reason: row.reason,
      };
    });
    return { generatedAt: nowIso(), candidates };
  }

  bumpRepairedTopic(topicId: string): PiSyncBackfillResult {
    const topic = this.db.prepare('select id from topics where id = ? limit 1').get(topicId) as { id: string } | undefined;
    if (!topic) return { ok: false, message: 'Topic not found.' };
    const repaired = this.db.prepare(
      `select count(*) as count from pi_sync_anomalies
       where topic_id = ? and status = 'resolved' and resolution in ('legacy_auto_repair', 'projected_external_message')`
    ).get(topicId) as { count: number };
    if (repaired.count === 0) return { ok: false, message: 'Topic has no reconciled external messages to bump.' };
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('update topics set updated_at = ? where id = ?').run(now, topicId);
      this.db.prepare('update sessions set updated_at = ? where topic_id = ?').run(now, topicId);
    })();
    return { ok: true, message: 'Repaired topic bumped.' };
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
    return result.changes > 0
      ? { ok: true, message: 'Anomaly ignored.' }
      : { ok: false, message: 'Active anomaly not found.' };
  }

  async backfillAnomaly(
    anomalyId: string,
    opts?: { bumpTopic?: boolean; resolvedBy?: string | null }
  ): Promise<PiSyncBackfillResult> {
    const anomaly = this.db.prepare('select * from pi_sync_anomalies where id = ? limit 1').get(anomalyId) as
      PiSyncAnomalyRow | undefined;
    if (!anomaly) return { ok: false, message: 'Anomaly not found.' };
    if (!['deferred', 'needs_manual_review'].includes(anomaly.status))
      return { ok: false, message: `Anomaly is ${anomaly.status}.` };
    const exported = (await this.client.exportPiSession(anomaly.pi_session_id)) as ExportedSession | null;
    if (!exported) return { ok: false, message: 'Pi session could not be exported.' };
    const activeIds = new Set(
      exported.active_branch?.active_entry_ids ??
        exported.entries.flatMap((candidate) => (candidate.id ? [candidate.id] : []))
    );
    const entry = exported.entries.find((candidate) => candidate.id === anomaly.pi_message_id);
    if (
      !entry ||
      !entry.id ||
      !activeIds.has(entry.id) ||
      entry.type !== 'message' ||
      !entry.hasVisibleText ||
      !entry.role
    ) {
      return { ok: false, message: 'Active-branch visible Pi message not found.' };
    }
    const text = entry.role === 'assistant' ? stripArtifactMarkers(entry.text ?? '') : (entry.text ?? '');
    if (!text.trim()) return { ok: false, message: 'Pi message has no visible text to backfill.' };
    const authorId = this.ensureIdentity(
      entry.role === 'user' ? 'Pi CLI' : 'Monika',
      entry.role === 'user' ? 'system' : 'robot',
      entry.role === 'user' ? '/avatars/pi-cli.gif' : '/avatars/monika.png'
    );
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
          .prepare(
            'insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)'
          )
          .run(sessionMessageId, anomaly.session_id, entry.role, text, at, 'public');
      }
      this.db
        .prepare(
          'update pi_message_links set post_id = coalesce(post_id, ?), session_message_id = coalesce(session_message_id, ?), metadata_json = ? where pi_session_id = ? and pi_message_id = ?'
        )
        .run(
          postId,
          sessionMessageId,
          json({ backfilledFromAnomaly: true }),
          anomaly.pi_session_id,
          anomaly.pi_message_id
        );
      this.db
        .prepare(
          `update pi_sync_anomalies
           set status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, post_id = ?, last_checked_at = ?
           where id = ?`
        )
        .run(now, opts?.resolvedBy ?? null, existing ? 'matched_existing_post' : 'backfilled', postId, now, anomaly.id);
      if (opts?.bumpTopic) this.db.prepare('update topics set updated_at = ? where id = ?').run(now, anomaly.topic_id);
    })();
    return {
      ok: true,
      postId,
      message: existing ? 'Anomaly linked to an existing post.' : 'Anomaly backfilled as a forum post.',
    };
  }

  private needsSync(summary: PiSessionSummary): boolean {
    const link = this.db.prepare('select * from pi_session_links where pi_session_id = ? limit 1').get(summary.id) as
      { imported_at: string; metadata_json: string | null } | undefined;
    if (!link) return true;
    const meta = parseJsonObject(link.metadata_json);
    if (meta['mtimeMs'] === summary.mtime_ms && meta['sizeBytes'] === summary.size_bytes) return false;
    const importedAt = Date.parse(link.imported_at);
    const mtime = typeof summary.mtime_ms === 'number' ? summary.mtime_ms : 0;
    return !Number.isFinite(importedAt) || mtime > importedAt;
  }

  private importExported(exported: ExportedSession, summary: PiSessionSummary): number {
    // Defense in depth: manual sync/export callers must not create topics for
    // pi-subagents child sessions even if a listing omitted kind metadata.
    if (isSubagentPiSession(summary) || isSubagentPiSession(exported.session)) return 0;
    return this.db.transaction(() => {
      const classification = classifyPiSession(exported.session, exported.entries);
      const target = this.ensureSession(exported, summary, classification);
      return this.importMessages(exported, target, summary);
    })();
  }

  private ensureIdentity(displayName: string, kind: string, avatarUrl: string | null): string {
    const existing = this.db.prepare('select id from identities where display_name = ? limit 1').get(displayName) as
      { id: string } | undefined;
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
      { topicId: string; sessionId: string; metadataJson: string | null; tagsJson: string | null } | undefined;
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

  private nextRetryAt(retryCount: number, now = Date.now()): string | null {
    const delay = LIVE_ANOMALY_BACKOFF_MS[Math.min(retryCount, LIVE_ANOMALY_BACKOFF_MS.length - 1)];
    return delay ? new Date(now + delay).toISOString() : null;
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
    const sessionIds = [...new Set(rows.map((row) => row.pi_session_id))];
    let processed = 0;
    for (const piSessionId of sessionIds) {
      const related = rows.filter((row) => row.pi_session_id === piSessionId);
      try {
        const exported = (await this.client.exportPiSession(piSessionId)) as ExportedSession | null;
        if (!exported) {
          for (const anomaly of related) this.bumpAnomalyRetry(anomaly, 'Pi session could not be exported.');
          processed += related.length;
          continue;
        }
        const summary = exported.session;
        this.importExported(exported, summary);
        processed += related.length;
      } catch (err) {
        for (const anomaly of related) this.bumpAnomalyRetry(anomaly, err instanceof Error ? err.message : String(err));
        processed += related.length;
      }
    }
    return processed;
  }

  private bumpAnomalyRetry(anomaly: PiSyncAnomalyRow, error: string | null): void {
    const checkedAt = nowIso();
    const retryCount = anomaly.retry_count + 1;
    const firstSeen = Date.parse(anomaly.first_seen_at);
    const status =
      Number.isFinite(firstSeen) && Date.now() - firstSeen > LIVE_ANOMALY_RETRY_LIMIT_MS
        ? 'needs_manual_review'
        : 'deferred';
    const nextRetry = status === 'deferred' ? this.nextRetryAt(retryCount) : null;
    const meta = { ...parseJsonObject(anomaly.metadata_json), lastRetryError: error };
    this.db
      .prepare(
        'update pi_sync_anomalies set status = ?, retry_count = ?, last_checked_at = ?, next_retry_at = ?, metadata_json = ? where id = ?'
      )
      .run(status, retryCount, checkedAt, nextRetry, json(meta), anomaly.id);
  }

  private indexExport(exported: ExportedSession): Set<string> {
    const indexedAt = nowIso();
    const activeIds = new Set(
      exported.active_branch?.active_entry_ids ?? exported.entries.flatMap((entry) => (entry.id ? [entry.id] : []))
    );
    const insert = this.db.prepare(
      `insert or ignore into pi_entry_index
       (pi_session_id, entry_id, parent_entry_id, entry_type, role, custom_type, entry_timestamp, has_visible_text, first_indexed_at, metadata_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of exported.entries) {
      if (!entry.id) continue;
      insert.run(
        exported.session.id,
        entry.id,
        entry.parentId ?? null,
        entry.type,
        entry.role ?? null,
        entry.customType ?? null,
        entry.timestamp ?? null,
        entry.hasVisibleText ? 1 : 0,
        indexedAt,
        json({ contentTypes: entry.contentTypes ?? [] })
      );
    }
    this.db
      .prepare(
        `insert into pi_session_heads (pi_session_id, leaf_entry_id, active_entry_ids_json, observed_at, metadata_json)
       values (?, ?, ?, ?, ?)
       on conflict(pi_session_id) do update set leaf_entry_id = excluded.leaf_entry_id,
         active_entry_ids_json = excluded.active_entry_ids_json, observed_at = excluded.observed_at,
         metadata_json = excluded.metadata_json`
      )
      .run(
        exported.session.id,
        exported.active_branch?.leaf_entry_id ?? null,
        json([...activeIds]),
        indexedAt,
        json({ entryCount: exported.entries.length })
      );
    return activeIds;
  }

  private recordDivergences(piSessionId: string, activeIds: Set<string>): void {
    const now = nowIso();
    const rows = this.db
      .prepare('select pi_message_id, post_id from pi_message_links where pi_session_id = ? and post_id is not null')
      .all(piSessionId) as Array<{ pi_message_id: string; post_id: string }>;
    const upsert = this.db.prepare(
      `insert into pi_projection_divergences
       (id, pi_session_id, pi_message_id, post_id, first_observed_at, last_observed_at, status, metadata_json)
       values (?, ?, ?, ?, ?, ?, 'inactive_branch', ?)
       on conflict(pi_session_id, pi_message_id, post_id) do update set
         last_observed_at = excluded.last_observed_at, status = 'inactive_branch'`
    );
    for (const row of rows) {
      if (!activeIds.has(row.pi_message_id))
        upsert.run(randomUUID(), piSessionId, row.pi_message_id, row.post_id, now, now, json({ preservedPost: true }));
    }
    if (activeIds.size > 0) {
      this.db
        .prepare(
          `update pi_projection_divergences set status = 'active_again', last_observed_at = ?
         where pi_session_id = ? and pi_message_id in (select value from json_each(?)) and status = 'inactive_branch'`
        )
        .run(now, piSessionId, json([...activeIds]));
    }
  }

  private isRobotIdle(topicId: string): boolean {
    const row = this.db.prepare('select activity from robot_state where topic_id = ? limit 1').get(topicId) as
      { activity: string } | undefined;
    return !row || row.activity === 'idle' || row.activity === 'stopped';
  }

  private upsertAnomaly(
    piSessionId: string,
    target: SyncTarget,
    entry: PiEntry,
    reason: string,
    text: string,
    metadata: unknown,
    retryAt: string | null
  ): void {
    const now = nowIso();
    const sameReason = this.db
      .prepare(
        `select id, first_seen_at, retry_count, status from pi_sync_anomalies
         where pi_session_id = ? and pi_message_id = ? and reason = ? limit 1`
      )
      .get(piSessionId, entry.id, reason) as
      | Pick<PiSyncAnomalyRow, 'id' | 'first_seen_at' | 'retry_count' | 'status'>
      | undefined;
    if (sameReason?.status === 'resolved' || sameReason?.status === 'ignored') return;
    const existing = sameReason ?? (this.db
      .prepare(
        `select id, first_seen_at, retry_count, status from pi_sync_anomalies
         where pi_session_id = ? and pi_message_id = ? and status in ('deferred', 'needs_manual_review')
         order by first_seen_at asc limit 1`
      )
      .get(piSessionId, entry.id) as
      | Pick<PiSyncAnomalyRow, 'id' | 'first_seen_at' | 'retry_count' | 'status'>
      | undefined);
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 240);
    if (existing) {
      if (existing.status === 'resolved' || existing.status === 'ignored') return;
      const retryCount = existing.retry_count + 1;
      const age = Date.now() - Date.parse(existing.first_seen_at);
      const status =
        reason === 'forum-origin-awaiting-bridge' && age > LIVE_ANOMALY_RETRY_LIMIT_MS
          ? 'needs_manual_review'
          : 'deferred';
      this.db
        .prepare(
          `update pi_sync_anomalies set topic_id = ?, session_id = ?, role = ?, status = ?, reason = ?, preview = ?,
         last_seen_at = ?, last_checked_at = ?, next_retry_at = ?, retry_count = ?, metadata_json = ? where id = ?`
        )
        .run(
          target.topicId,
          target.sessionId,
          entry.role ?? null,
          status,
          reason,
          preview,
          now,
          now,
          status === 'deferred' ? retryAt : null,
          retryCount,
          json(metadata),
          existing.id
        );
      return;
    }
    this.db
      .prepare(
        `insert into pi_sync_anomalies
       (id, pi_session_id, pi_message_id, topic_id, session_id, role, status, reason, preview, first_seen_at, last_seen_at, last_checked_at, next_retry_at, retry_count, metadata_json)
       values (?, ?, ?, ?, ?, ?, 'deferred', ?, ?, ?, ?, null, ?, 0, ?)`
      )
      .run(
        randomUUID(),
        piSessionId,
        entry.id,
        target.topicId,
        target.sessionId,
        entry.role ?? null,
        reason,
        preview,
        now,
        now,
        retryAt,
        json(metadata)
      );
  }

  private resolveAnomalies(piSessionId: string, piMessageId: string, resolution: string, postId: string | null): void {
    const now = nowIso();
    this.db
      .prepare(
        `update pi_sync_anomalies set status = 'resolved', resolved_at = ?, resolution = ?, post_id = ?, last_checked_at = ?, next_retry_at = null
       where pi_session_id = ? and pi_message_id = ? and status in ('deferred', 'needs_manual_review')`
      )
      .run(now, resolution, postId, now, piSessionId, piMessageId);
  }

  private reconcileHistoricalTerminalErrors(exported: ExportedSession, target: SyncTarget): void {
    const provenance = new Map((exported.message_provenance ?? []).map((item) => [item.piMessageId, item]));
    for (const failure of detectHistoricalTerminalErrors(exported)) {
      const postIds = new Set<string>();
      const linkRows = this.db
        .prepare(
          `select post_id from pi_message_links
           where pi_session_id = ? and pi_message_id = ? and post_id is not null`
        )
        .all(exported.session.id, failure.userEntryId) as Array<{ post_id: string }>;
      for (const row of linkRows) postIds.add(row.post_id);

      const direct = provenance.get(failure.userEntryId);
      if (direct?.postId && (!direct.topicId || direct.topicId === target.topicId)) postIds.add(direct.postId);
      if (postIds.size !== 1) continue;

      const anchorPostId = [...postIds][0];
      const anchor = this.db
        .prepare('select id from posts where id = ? and topic_id = ? and deleted_at is null limit 1')
        .get(anchorPostId, target.topicId) as { id: string } | undefined;
      if (!anchor) continue;

      const category = classifyHistoricalProviderError(failure.error);
      this.store.createTopicOperationalEvent({
        topicId: target.topicId,
        anchorPostId: anchor.id,
        type: 'turn_error',
        category: 'assistant',
        status: 'failed',
        summary: 'Assistant response failed.',
        detail: {
          error: failure.error,
          ...(category ? { category } : {}),
          historical: true,
          piSessionId: exported.session.id,
          userPiMessageId: failure.userEntryId,
          assistantPiMessageId: failure.assistantEntryId,
        },
        sourceKind: 'echs_turn',
        sourceId: `pi_message:${failure.assistantEntryId}`,
      });
    }
  }

  private importMessages(exported: ExportedSession, target: SyncTarget, summary: PiSessionSummary): number {
    const { topicId, sessionId } = target;
    const hadIndexedHead = Boolean(this.db.prepare('select 1 from pi_session_heads where pi_session_id = ?').get(exported.session.id));
    const hadMessageLinks = Boolean(this.db.prepare('select 1 from pi_message_links where pi_session_id = ? limit 1').get(exported.session.id));
    const freshImportedSession = !target.liveForumSession && !hadIndexedHead && !hadMessageLinks;
    const activeIds = this.indexExport(exported);
    this.recordDivergences(exported.session.id, activeIds);
    if (activeIds.size > 0) {
      const now = nowIso();
      this.db.prepare(
        `update pi_sync_anomalies
         set status = 'resolved', resolved_at = ?, resolution = 'inactive_branch', last_checked_at = ?, next_retry_at = null
         where pi_session_id = ? and status in ('deferred', 'needs_manual_review')
           and pi_message_id not in (select value from json_each(?))`
      ).run(now, now, exported.session.id, json([...activeIds]));
    }
    const byId = new Map(exported.entries.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []));
    const provenance = new Map((exported.message_provenance ?? []).map((item) => [item.piMessageId, item]));
    const neonId = this.ensureIdentity('Pi CLI', 'system', '/avatars/pi-cli.gif');
    const robotId = this.ensureIdentity('Monika', 'robot', '/avatars/monika.png');
    let count = 0;
    let bumpedAt: string | null = null;

    const hasForumTrigger = (entry: PiEntry): boolean => {
      let cursor: PiEntry | undefined = entry;
      const seen = new Set<string>();
      while (cursor?.parentId && !seen.has(cursor.parentId)) {
        seen.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
        if (cursor?.type === 'message' && cursor.role === 'user') {
          // The nearest user ancestor owns the assistant/tool cycle. Do not walk
          // through an external CLI continuation to an older forum prompt.
          return provenance.get(cursor.id ?? '')?.origin === 'forum' || (cursor.text ?? '').includes('[FORUM TURN]');
        }
      }
      return false;
    };

    for (const entry of exported.entries) {
      if (!entry.id || !activeIds.has(entry.id)) continue;
      const ignored = this.db.prepare(
        "select 1 from pi_sync_anomalies where pi_session_id = ? and pi_message_id = ? and status = 'ignored' limit 1"
      ).get(exported.session.id, entry.id);
      if (ignored) continue;
      const link = this.db.prepare(
        'select id, post_id, metadata_json, imported_at from pi_message_links where pi_session_id = ? and pi_message_id = ? limit 1'
      ).get(exported.session.id, entry.id) as { id: string; post_id: string | null; metadata_json: string | null; imported_at: string } | undefined;
      if (link?.post_id) {
        this.resolveAnomalies(exported.session.id, entry.id, 'linked_by_bridge', link.post_id);
        continue;
      }

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
      const isPostMessage = entry.type === 'message' && entry.hasVisibleText && (entry.role === 'user' || entry.role === 'assistant');
      if (!isPostMessage) continue;

      const rawText = entry.text ?? '';
      const text = entry.role === 'assistant' ? stripArtifactMarkers(rawText) : rawText;
      if (!text.trim()) continue;
      const directProvenance = provenance.get(entry.id);
      const sourceKind = provenanceSourceKind(directProvenance);
      const subagentCompletion = entry.role === 'assistant' && sourceKind === 'subagent-completion';
      const forumOrigin = directProvenance?.origin === 'forum'
        || subagentCompletion
        || rawText.includes('[FORUM TURN]')
        || (entry.role === 'assistant' && hasForumTrigger(entry));
      const authorId = entry.role === 'user' ? neonId : robotId;
      const legacyMeta = parseJsonObject(link?.metadata_json ?? null);
      const legacyRepair = Boolean(link && (
        legacyMeta['skippedLiveForumPost']
        || legacyMeta['deferredLiveForumPost']
        || legacyMeta['seededFromLegacySkippedLiveForumPost']
      ));
      const provenanceTopicId = provenanceOriginTopicId(directProvenance);
      const explicitPostId = subagentCompletion
        ? provenanceOriginPostId(directProvenance)
        : entry.role === 'user' ? (directProvenance?.postId ?? extractForumPostId(rawText)) : null;
      const explicitPost = explicitPostId && (!provenanceTopicId || provenanceTopicId === topicId)
        ? this.db.prepare('select id from posts where id = ? and topic_id = ? limit 1').get(explicitPostId, topicId) as { id: string } | undefined
        : undefined;
      const completionRunIds = subagentCompletion ? provenanceRunIds(directProvenance) : [];
      const completionSourceMetadata = subagentCompletion ? {
        sourceKind,
        runId: directProvenance?.runId ?? directProvenance?.run_id ?? null,
        runIds: completionRunIds,
        originTurnId: directProvenance?.originTurnId ?? directProvenance?.origin_turn_id ?? null,
        originPostId: explicitPost?.id ?? explicitPostId,
        originTopicId: provenanceTopicId ?? topicId,
      } : {};
      const existingRunLink = subagentCompletion && completionRunIds.length > 0
        ? this.db.prepare(
          `select post_id from pi_message_links
           where pi_session_id = ? and post_id is not null
             and (json_extract(metadata_json, '$.runId') in (select value from json_each(?))
               or exists (select 1 from json_each(metadata_json, '$.runIds') where value in (select value from json_each(?))))
           order by imported_at asc limit 1`
        ).get(exported.session.id, json(completionRunIds), json(completionRunIds)) as { post_id: string } | undefined
        : undefined;
      const existingPost = existingRunLink
        ? this.db.prepare('select id from posts where id = ? and topic_id = ? limit 1').get(existingRunLink.post_id, topicId) as { id: string } | undefined
        : (!subagentCompletion ? explicitPost : undefined) ?? ((forumOrigin || legacyRepair)
          ? this.findUnlinkedMatchingPost(topicId, authorId, text, entry.timestamp ?? null)
          : null);
      if (existingPost) {
        if (link) {
          this.db.prepare('update pi_message_links set post_id = ?, metadata_json = ? where id = ?')
            .run(existingPost.id, json({ ...metadata, reconciledExistingPost: true, forumOrigin, ...completionSourceMetadata }), link.id);
        } else {
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: existingPost.id,
            sessionMessageId: null,
            role: entry.role,
            metadata: { ...metadata, reconciledExistingPost: true, forumOrigin, ...completionSourceMetadata },
          });
        }
        this.resolveAnomalies(exported.session.id, entry.id, 'matched_existing_post', existingPost.id);
        continue;
      }

      if (subagentCompletion) {
        const postId = randomUUID();
        const sessionMessageId = randomUUID();
        const at = entry.timestamp ?? nowIso();
        this.db.prepare(
          'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(postId, topicId, null, explicitPost?.id ?? null, robotId, text, entry.id, 0, at, null, null);
        this.db.prepare('insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)')
          .run(sessionMessageId, sessionId, 'assistant', text, at, 'public');
        const completionMetadata = {
          ...metadata,
          forumOrigin: true,
          ...completionSourceMetadata,
          linkedBy: 'historical-subagent-completion',
        };
        if (link) {
          this.db.prepare('update pi_message_links set post_id = ?, session_message_id = ?, metadata_json = ? where id = ?')
            .run(postId, sessionMessageId, json(completionMetadata), link.id);
        } else {
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId,
            sessionMessageId,
            role: 'assistant',
            metadata: completionMetadata,
          });
        }
        this.resolveAnomalies(exported.session.id, entry.id, 'projected_subagent_completion', postId);
        bumpedAt = nowIso();
        count += 1;
        continue;
      }

      if (forumOrigin && entry.role === 'assistant' && entry.stopReason === 'toolUse') {
        this.resolveAnomalies(exported.session.id, entry.id, 'forum_intermediate_assistant', null);
        continue;
      }

      if (forumOrigin) {
        const anomalyMetadata = {
          ...metadata,
          piSessionId: exported.session.id,
          forumOrigin: true,
          deferredToBridge: true,
        };
        this.upsertAnomaly(
          exported.session.id,
          target,
          entry,
          'forum-origin-awaiting-bridge',
          text,
          anomalyMetadata,
          this.nextRetryAt(0)
        );
        if (!link) {
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: null,
            sessionMessageId: null,
            role: entry.role,
            metadata: anomalyMetadata,
          });
        }
        continue;
      }

      const index = this.db
        .prepare('select first_indexed_at from pi_entry_index where pi_session_id = ? and entry_id = ?')
        .get(exported.session.id, entry.id) as { first_indexed_at: string };
      const settledAt = Date.parse(index.first_indexed_at) + EXTERNAL_SETTLEMENT_MS;
      if (!legacyRepair && !freshImportedSession && (Date.now() < settledAt || !this.isRobotIdle(topicId))) {
        const retryAt = new Date(
          Math.max(settledAt, Date.now() + (!this.isRobotIdle(topicId) ? 30_000 : 0))
        ).toISOString();
        const anomalyMetadata = { ...metadata, piSessionId: exported.session.id, externalContinuation: true };
        this.upsertAnomaly(
          exported.session.id,
          target,
          entry,
          'external-message-settling',
          text,
          anomalyMetadata,
          retryAt
        );
        if (!link) {
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: null,
            sessionMessageId: null,
            role: entry.role,
            metadata: anomalyMetadata,
          });
        }
        continue;
      }

      const postId = randomUUID();
      const sessionMessageId = randomUUID();
      const at = entry.timestamp ?? nowIso();
      this.db.prepare(
        'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(postId, topicId, null, null, authorId, text, entry.id, legacyRepair ? 1 : 0, at, null, null);
      this.db.prepare('insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)')
        .run(sessionMessageId, sessionId, entry.role, text, at, 'public');
      if (link) {
        this.db.prepare('update pi_message_links set post_id = ?, session_message_id = ?, metadata_json = ? where id = ?')
          .run(postId, sessionMessageId, json({ ...metadata, externalContinuation: !legacyRepair, legacyAutoRepair: legacyRepair }), link.id);
      } else {
        this.insertMessageLink({
          piSessionId: exported.session.id,
          piMessageId: entry.id,
          postId,
          sessionMessageId,
          role: entry.role,
          metadata: { ...metadata, externalContinuation: true },
        });
      }
      this.resolveAnomalies(
        exported.session.id,
        entry.id,
        legacyRepair ? 'legacy_auto_repair' : 'projected_external_message',
        postId
      );
      if (!legacyRepair) bumpedAt = freshImportedSession ? at : nowIso();
      count += 1;
    }
    this.reconcileHistoricalTerminalErrors(exported, target);
    if (bumpedAt) {
      this.db.prepare('update topics set updated_at = ? where id = ?').run(bumpedAt, topicId);
      this.db.prepare('update sessions set updated_at = ? where id = ?').run(bumpedAt, sessionId);
    }
    return count;
  }
}
