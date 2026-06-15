#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { bootstrap, migrate } from '../db';
import { classifyPiSession } from '../services/piSessionClassifier';

import type { ForumTarget, SessionClassification } from '../services/piSessionClassifier';

const DEFAULT_AGENTD = process.env['MONIKA_AGENTD_BASE_URL'] ?? 'http://127.0.0.1:7724';
const DEFAULT_DB = process.env['CODEX_FORUM_DB'] ?? '/home/monika/.pi/forum/data.db';

type PiSessionSummary = {
  id: string;
  path: string;
  cwd?: string | null;
  timestamp?: string | null;
  kind?: string | null;
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
  customType?: string | null;
  data?: unknown;
  [key: string]: unknown;
};
type ExportedSession = {
  session: PiSessionSummary;
  entries: PiEntry[];
  parse_errors?: Array<{ line: number; message: string }>;
};
type Args = { agentdBaseUrl: string; dbPath: string; resetDb: boolean; dryRun: boolean; limit: number | null };

const nowIso = () => new Date().toISOString();

function usage(exitCode = 1): never {
  console.error(
    `Usage: pnpm --filter @irrigationreal/codex-forum-server import:pi-sessions -- [options]\n\nOptions:\n  --agentd <url>       agentd base URL (default: ${DEFAULT_AGENTD})\n  --db <path>          forum SQLite DB path (default: ${DEFAULT_DB})\n  --reset-db           delete the DB/WAL/SHM before importing (destructive)\n  --dry-run            parse and classify without writing rows\n  --limit <n>          import at most n sessions\n  -h, --help           show this help\n`
  );
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { agentdBaseUrl: DEFAULT_AGENTD, dbPath: DEFAULT_DB, resetDb: false, dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--agentd') args.agentdBaseUrl = argv[++i] ?? usage();
    else if (arg === '--db') args.dbPath = argv[++i] ?? usage();
    else if (arg === '--reset-db') args.resetDb = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--limit') {
      const raw = Number(argv[++i] ?? '');
      if (!Number.isFinite(raw) || raw <= 0) usage();
      args.limit = Math.floor(raw);
    } else usage();
  }
  args.agentdBaseUrl = args.agentdBaseUrl.replace(/\/+$/, '');
  args.dbPath = resolve(args.dbPath);
  return args;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function resetDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${path}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function firstUserText(entries: PiEntry[]): string {
  return entries.find((e) => e.type === 'message' && e.role === 'user' && e.text?.trim())?.text?.trim() ?? '';
}
function titleFromText(text: string, fallback: string): string {
  const firstMeaningful = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('==='));
  return (firstMeaningful ?? fallback).replace(/\s+/g, ' ').slice(0, 96).trim() || fallback;
}
function getOrCreateIdentity(
  db: Database.Database,
  displayName: string,
  kind: string,
  avatarUrl: string | null
): string {
  const existing = db.prepare('select id from identities where display_name = ? limit 1').get(displayName) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    'insert into identities (id, tenant_id, display_name, kind, parent_identity_id, avatar_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, null, displayName, kind, null, avatarUrl, now, now);
  return id;
}
function getOrCreateForum(
  db: Database.Database,
  name: string,
  parentForumId: string | null = null,
  cwd: string | null = null
): string {
  const existing = db
    .prepare('select id from forums where name = ? and parent_forum_id is ? order by created_at asc limit 1')
    .get(name, parentForumId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    'insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
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
function getTargetForum(db: Database.Database, target: ForumTarget, cwd: string | null): string {
  if (target.parent) return getOrCreateForum(db, target.name, getOrCreateForum(db, target.parent, null, cwd), cwd);
  return getOrCreateForum(db, target.name, null, cwd);
}

function targetLabel(target: ForumTarget): string {
  return target.parent ? `${target.parent} / ${target.name}` : target.name;
}

function ensureImportedSession(
  db: Database.Database,
  exported: ExportedSession,
  classification: SessionClassification,
  runId: string
): { topicId: string; forumSessionId: string; created: boolean } {
  const existing = db
    .prepare(
      'select topic_id as topicId, session_id as forumSessionId from pi_session_links where pi_session_id = ? limit 1'
    )
    .get(exported.session.id) as { topicId: string; forumSessionId: string } | undefined;
  if (existing) {
    db.prepare(
      'update pi_session_links set last_import_run_id = ?, imported_at = ?, metadata_json = ? where pi_session_id = ?'
    ).run(
      runId,
      nowIso(),
      json({
        parseErrors: exported.parse_errors ?? [],
        classificationReason: classification.reason,
        classificationForumCwd: classification.forumCwd,
      }),
      exported.session.id
    );
    return { ...existing, created: false };
  }
  const neonId = getOrCreateIdentity(db, 'neon', 'human', '/avatars/user.svg');
  const forumId = getTargetForum(db, classification.target, classification.forumCwd);
  const topicId = randomUUID();
  const forumSessionId = randomUUID();
  const createdAt = exported.session.timestamp ?? nowIso();
  const title = titleFromText(firstUserText(exported.entries), `Pi session ${exported.session.id.slice(0, 8)}`);
  db.prepare(
    'insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    topicId,
    forumId,
    null,
    title,
    'open',
    JSON.stringify(['pi-import', classification.kind]),
    'manual',
    neonId,
    createdAt,
    createdAt
  );
  db.prepare(
    'insert into sessions (id, topic_id, codex_thread_id, agent_thread_id, agent_backend, personas_synced_at, last_dispatched_post_id, created_at, updated_at, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(forumSessionId, topicId, null, null, 'monika-pi-import', null, null, createdAt, createdAt, 'imported');
  db.prepare(
    'insert into pi_session_links (id, pi_session_id, pi_session_path, topic_id, session_id, cwd, kind, pi_timestamp, imported_at, last_import_run_id, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    randomUUID(),
    exported.session.id,
    exported.session.path,
    topicId,
    forumSessionId,
    exported.session.cwd ?? null,
    classification.kind,
    exported.session.timestamp ?? null,
    nowIso(),
    runId,
    json({
      parseErrors: exported.parse_errors ?? [],
      classificationReason: classification.reason,
      classificationForumCwd: classification.forumCwd,
    })
  );
  return { topicId, forumSessionId, created: true };
}

function importMessages(
  db: Database.Database,
  exported: ExportedSession,
  topicId: string,
  forumSessionId: string
): number {
  const neonId = getOrCreateIdentity(db, 'neon', 'human', '/avatars/user.svg');
  const robotId = getOrCreateIdentity(db, 'Monika', 'robot', '/avatars/monika.png');
  let imported = 0;
  let lastPostAt = exported.session.timestamp ?? nowIso();
  const insertLink = db.prepare(
    'insert or ignore into pi_message_links (id, pi_session_id, pi_message_id, post_id, session_message_id, role, imported_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const entry of exported.entries) {
    if (entry.type !== 'message' || !entry.id) continue;
    const existing = db
      .prepare('select id from pi_message_links where pi_session_id = ? and pi_message_id = ? limit 1')
      .get(exported.session.id, entry.id) as { id: string } | undefined;
    if (existing) continue;
    const metadata = {
      parentId: entry.parentId ?? null,
      timestamp: entry.timestamp ?? null,
      contentTypes: entry.contentTypes ?? [],
      api: entry.api ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      thinking: entry.thinking ?? null,
      toolName: entry.toolName ?? null,
      toolCallId: entry.toolCallId ?? null,
      isError: entry.isError ?? null,
      stopReason: entry.stopReason ?? null,
      errorMessage: entry.errorMessage ?? null,
      usage: entry.usage ?? null,
      skippedVisiblePost: !entry.hasVisibleText || !['user', 'assistant'].includes(entry.role ?? ''),
    };
    if (entry.hasVisibleText && (entry.role === 'user' || entry.role === 'assistant')) {
      const postId = randomUUID();
      const sessionMessageId = randomUUID();
      const at = entry.timestamp ?? lastPostAt;
      lastPostAt = at;
      const authorId = entry.role === 'user' ? neonId : robotId;
      db.prepare(
        'insert into posts (id, topic_id, tenant_id, parent_post_id, author_id, body, source_message_id, silent, created_at, edited_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(postId, topicId, null, null, authorId, entry.text ?? '', entry.id, 0, at, null, null);
      db.prepare(
        'insert into session_messages (id, session_id, role, content, created_at, visibility) values (?, ?, ?, ?, ?, ?)'
      ).run(sessionMessageId, forumSessionId, entry.role, entry.text ?? '', at, 'public');
      insertLink.run(
        randomUUID(),
        exported.session.id,
        entry.id,
        postId,
        sessionMessageId,
        entry.role,
        nowIso(),
        json(metadata)
      );
      imported += 1;
    } else {
      insertLink.run(
        randomUUID(),
        exported.session.id,
        entry.id,
        null,
        null,
        entry.role ?? null,
        nowIso(),
        json(metadata)
      );
    }
  }
  db.prepare('update topics set updated_at = ? where id = ?').run(lastPostAt, topicId);
  db.prepare('update sessions set updated_at = ? where id = ?').run(lastPostAt, forumSessionId);
  return imported;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[pi-import] agentd=${args.agentdBaseUrl}`);
  console.log(`[pi-import] db=${args.dbPath}${args.dryRun ? ' (dry run)' : ''}${args.resetDb ? ' (reset)' : ''}`);
  const { sessions } = await fetchJson<{ sessions: PiSessionSummary[] }>(`${args.agentdBaseUrl}/v1/pi/sessions`);
  const selected = args.limit ? sessions.slice(0, args.limit) : sessions;
  console.log(`[pi-import] sessions discovered=${sessions.length} selected=${selected.length}`);
  if (args.dryRun) {
    const counts = new Map<string, number>();
    for (const summary of selected) {
      const exported = await fetchJson<ExportedSession>(
        `${args.agentdBaseUrl}/v1/pi/sessions/${encodeURIComponent(summary.id)}/export`
      );
      const classification = classifyPiSession(exported.session, exported.entries);
      const key = `${targetLabel(classification.target)} (${classification.kind})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log('[pi-import] dry-run classification:', Object.fromEntries(counts.entries()));
    return;
  }
  if (args.resetDb) resetDb(args.dbPath);
  mkdirSync(dirname(args.dbPath), { recursive: true });
  const db = new Database(args.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  bootstrap(db);
  getOrCreateIdentity(db, 'neon', 'human', '/avatars/user.svg');
  getOrCreateIdentity(db, 'Pi CLI', 'system', '/avatars/pi-cli.gif');
  const runId = randomUUID();
  db.prepare(
    'insert into pi_import_runs (id, started_at, status, agentd_base_url, sessions_seen, metadata_json) values (?, ?, ?, ?, ?, ?)'
  ).run(runId, nowIso(), 'running', args.agentdBaseUrl, selected.length, json({ resetDb: args.resetDb }));
  let sessionsImported = 0;
  let postsImported = 0;
  try {
    for (const [index, summary] of selected.entries()) {
      const exported = await fetchJson<ExportedSession>(
        `${args.agentdBaseUrl}/v1/pi/sessions/${encodeURIComponent(summary.id)}/export`
      );
      const classification = classifyPiSession(exported.session, exported.entries);
      const result = db.transaction(() => {
        const importedSession = ensureImportedSession(db, exported, classification, runId);
        return {
          created: importedSession.created,
          importedPosts: importMessages(db, exported, importedSession.topicId, importedSession.forumSessionId),
        };
      })();
      if (result.created) sessionsImported += 1;
      postsImported += result.importedPosts;
      if ((index + 1) % 25 === 0 || index === selected.length - 1)
        console.log(
          `[pi-import] ${index + 1}/${selected.length} sessions, created=${sessionsImported}, posts=${postsImported}`
        );
    }
    db.prepare(
      'update pi_import_runs set finished_at = ?, status = ?, sessions_imported = ?, posts_imported = ? where id = ?'
    ).run(nowIso(), 'completed', sessionsImported, postsImported, runId);
  } catch (err) {
    db.prepare(
      'update pi_import_runs set finished_at = ?, status = ?, sessions_imported = ?, posts_imported = ?, metadata_json = ? where id = ?'
    ).run(
      nowIso(),
      'failed',
      sessionsImported,
      postsImported,
      json({ error: err instanceof Error ? err.message : String(err) }),
      runId
    );
    throw err;
  } finally {
    db.close();
  }
  console.log(`[pi-import] complete: sessions_created=${sessionsImported} posts_imported=${postsImported}`);
}

main().catch((err) => {
  console.error('[pi-import] failed:', err);
  process.exit(1);
});
