import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { EchsClient } from '../echsClient';

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

const nowIso = () => new Date().toISOString();
const json = (value: unknown): string => JSON.stringify(value ?? null);
const LIVE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

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

function isDelegate(entries: PiEntry[]): boolean {
  return firstUserText(entries).includes('=== FOCUSED TASK MODE ===');
}

function isSleep(entries: PiEntry[]): boolean {
  const sample = firstUserText(entries).slice(0, 5000).toLowerCase();
  return (
    sample.includes('/sleep') ||
    (sample.includes('sleep cycle') && (sample.includes('wake.md') || sample.includes('facts.md')))
  );
}

function classify(session: PiSessionSummary, entries: PiEntry[]): string {
  if (isSleep(entries)) return 'sleep';
  if (isDelegate(entries)) return 'delegate';
  if (session.kind === 'fork' || session.path.includes('/forks/')) return 'fork';
  return 'normal';
}

const cwdMappings = [
  { name: 'The Zeta Directive', paths: ['/home/monika/repos/TheZetaDirective'] },
  { name: 'Monika Runtime', paths: ['/home/monika/repos/monika', '/home/monika/.pi'] },
  { name: 'Shadowsea', paths: ['/persist/shadowsea'] },
  { name: 'Vesper', paths: ['/home/monika/repos/vesper'] },
  { name: 'OpenStarbound', paths: ['/home/monika/repos/OpenStarbound'] },
  { name: 'neosynth-arise', paths: ['/home/monika/repos/neosynth-arise'] },
];

function forumNameFor(kind: string, cwd?: string | null): { parent?: string; name: string } {
  if (kind === 'sleep') return { parent: 'System', name: 'Sleep' };
  if (kind === 'delegate') return { parent: 'System', name: 'Delegates' };
  if (kind === 'fork') return { parent: 'System', name: 'Forks' };
  const normalized = cwd ?? '';
  let best: { name: string; prefix: string } | null = null;
  for (const mapping of cwdMappings) {
    for (const prefix of mapping.paths) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.prefix.length) best = { name: mapping.name, prefix };
      }
    }
  }
  return { name: best?.name ?? 'General' };
}

function extractForumPostId(text: string): string | null {
  const match = text.match(/\[FORUM TURN\][\s\S]*?\bpostId=([^\n\r]+)[\s\S]*?\[\/FORUM TURN\]/);
  return match?.[1]?.trim() || null;
}

export class PiSessionSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
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

  async syncChanged(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const listed = await this.client.listPiSessions();
      const sessions = (listed?.sessions ?? []) as PiSessionSummary[];
      let checked = 0;
      let importedPosts = 0;
      for (const summary of sessions) {
        if (!this.needsSync(summary)) continue;
        try {
          const exported = (await this.client.exportPiSession(summary.id)) as ExportedSession | null;
          if (!exported) continue;
          importedPosts += this.importExported(exported, summary);
          checked += 1;
        } catch (err) {
          console.warn('[pi-sync] session failed:', summary.id, err instanceof Error ? err.message : err);
        }
      }
      if (checked > 0 || importedPosts > 0) console.log(`[pi-sync] synced=${checked} posts=${importedPosts}`);
    } finally {
      this.running = false;
    }
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
      const kind = classify(exported.session, exported.entries);
      const target = this.ensureSession(exported, summary, kind);
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

  private ensureForum(name: string, parentForumId: string | null = null): string {
    const existing = this.db
      .prepare('select id from forums where name = ? and parent_forum_id is ? order by created_at asc limit 1')
      .get(name, parentForumId) as { id: string } | undefined;
    if (existing) return existing.id;
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
        `Imported Pi sessions: ${name}`,
        null,
        null,
        'active',
        'public',
        null,
        now,
        now
      );
    return id;
  }

  private targetForum(kind: string, cwd?: string | null): string {
    const target = forumNameFor(kind, cwd);
    if (target.parent) return this.ensureForum(target.name, this.ensureForum(target.parent, null));
    return this.ensureForum(target.name, null);
  }

  private ensureSession(exported: ExportedSession, summary: PiSessionSummary, kind: string): SyncTarget {
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
    const forumId = this.targetForum(kind, exported.session.cwd);
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
        JSON.stringify(['pi-sync', kind]),
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
        kind,
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
          this.insertMessageLink({
            piSessionId: exported.session.id,
            piMessageId: entry.id,
            postId: null,
            sessionMessageId: null,
            role: entry.role,
            metadata: { ...metadata, skippedLiveForumPost: true },
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
