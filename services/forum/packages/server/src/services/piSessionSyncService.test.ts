import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../migrations';
import { isSubagentPiSession, omitSubagentPiSessions } from './piSessionPolicy';
import { PiSessionSyncService, detectHistoricalTerminalErrors } from './piSessionSyncService';

import type { ExportedSession } from './piSessionSyncService';

function createService(cwd: string | null) {
  const db = new Database(':memory:');
  db.exec(`
    create table forums (
      id text primary key,
      name text not null,
      parent_forum_id text,
      cwd text,
      created_at text not null,
      updated_at text not null
    );
  `);
  db.prepare(
    'insert into forums (id, name, parent_forum_id, cwd, created_at, updated_at) values (?, ?, ?, ?, ?, ?)'
  ).run('forum-1', 'General', null, cwd, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  const service = new PiSessionSyncService(db, { agentdBaseUrl: 'http://agentd.test', intervalMs: 60_000 });
  return {
    db,
    ensureForum: (nextCwd: string | null) =>
      (
        service as unknown as {
          ensureForum(name: string, parentForumId: string | null, cwd: string | null): string;
        }
      ).ensureForum('General', null, nextCwd),
  };
}

function createSyncFixture() {
  const db = new Database(':memory:');
  runMigrations(db);
  const service = new PiSessionSyncService(db, { agentdBaseUrl: 'http://agentd.test', intervalMs: 60_000 });
  const importExported = (exported: ExportedSession) =>
    (
      service as unknown as { importExported(value: ExportedSession, summary: ExportedSession['session']): Promise<number> }
    ).importExported(exported, exported.session);
  return { db, service, importExported };
}

function exported(
  entries: ExportedSession['entries'],
  activeEntryIds: string[],
  provenance: ExportedSession['message_provenance'] = []
): ExportedSession {
  return {
    session: {
      id: 'pi-session-1',
      path: '/tmp/pi-session-1.jsonl',
      cwd: '/workspace',
      timestamp: '2026-07-13T10:00:00.000Z',
      mtime_ms: 100,
      size_bytes: 1000,
    },
    entries,
    active_branch: { leaf_entry_id: activeEntryIds.at(-1) ?? null, active_entry_ids: activeEntryIds },
    message_provenance: provenance,
  };
}

function settleIndex(db: Database.Database): void {
  db.prepare("update pi_entry_index set first_indexed_at = '2026-07-13T00:00:00.000Z'").run();
}

describe('PiSessionSyncService forum cwd reconciliation', async () => {
  it('backfills a taxonomy cwd when the existing forum cwd is null', async () => {
    const { db, ensureForum } = createService(null);

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace' });

    db.close();
  });

  it('preserves an explicit forum cwd', async () => {
    const { db, ensureForum } = createService('/workspace/custom');

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace/custom' });

    db.close();
  });
});

describe('PiSessionSyncService child-session omission', async () => {
  it('recognizes explicit subagent kinds and the dedicated subagent path root', async () => {
    expect(isSubagentPiSession({ kind: 'subagent', path: '/tmp/child.jsonl' })).toBe(true);
    expect(isSubagentPiSession({ kind: null, path: '/app/.pi/agent/sessions/subagent/run/child.jsonl' })).toBe(true);
    expect(isSubagentPiSession({ kind: 'sleep', path: '/app/.pi/agent/sessions/sleep/child.jsonl' })).toBe(false);
    expect(omitSubagentPiSessions([
      { id: 'normal', kind: 'normal', path: '/app/.pi/agent/sessions/normal.jsonl' },
      { id: 'child-by-kind', kind: 'subagent', path: '/tmp/child.jsonl' },
      { id: 'child-by-path', kind: null, path: '/app/.pi/agent/sessions/subagent/run/child.jsonl' },
    ])).toEqual([{ id: 'normal', kind: 'normal', path: '/app/.pi/agent/sessions/normal.jsonl' }]);
  });

  it('skips child summaries before export during normal sync', async () => {
    const { db, service } = createSyncFixture();
    const client = (service as any).client;
    vi.spyOn(client, 'listPiSessions').mockResolvedValue({
      sessions: [{ id: 'child-1', kind: 'subagent', path: '/app/.pi/agent/sessions/subagent/child.jsonl' }],
    });
    const exportSpy = vi.spyOn(client, 'exportPiSession');

    const result = await service.runManualSync();
    expect(result.sessionsChecked).toBe(0);
    expect(exportSpy).not.toHaveBeenCalled();
    expect(db.prepare('select count(*) as count from topics').get()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    { kind: 'subagent', path: '/tmp/child.jsonl', label: 'explicit kind' },
    { kind: null, path: '/app/.pi/agent/sessions/subagent/run/child.jsonl', label: 'dedicated path' },
  ])('does not create a forum, topic, or session when a child export reaches the importer by $label', async ({ kind, path }) => {
    const { db, importExported } = createSyncFixture();
    const child = exported(
      [{ type: 'message', id: 'u1', role: 'user', text: 'private delegated task', hasVisibleText: true }],
      ['u1']
    );
    child.session.kind = kind;
    child.session.path = path;

    expect(await importExported(child)).toBe(0);
    expect(db.prepare('select count(*) as count from topics').get()).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from sessions').get()).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from pi_session_links').get()).toEqual({ count: 0 });
    db.close();
  });
});

describe('PiSessionSyncService provenance-aware reconciliation', async () => {
  it('indexes complete topology but projects conversational text from the active branch only after settlement', async () => {
    const { db, importExported } = createSyncFixture();
    await importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const value = exported(
      [
        { type: 'session', id: 'header', timestamp: '2026-07-13T10:00:00.000Z' },
        {
          type: 'message',
          id: 'u1',
          parentId: 'header',
          role: 'user',
          text: 'CLI prompt',
          hasVisibleText: true,
          timestamp: '2026-07-13T10:00:01.000Z',
        },
        {
          type: 'message',
          id: 'a-inactive',
          parentId: 'u1',
          role: 'assistant',
          text: 'Abandoned answer',
          hasVisibleText: true,
          timestamp: '2026-07-13T10:00:02.000Z',
        },
        {
          type: 'message',
          id: 'u2',
          parentId: 'u1',
          role: 'user',
          text: ',',
          hasVisibleText: true,
          timestamp: '2026-07-13T10:00:03.000Z',
        },
        {
          type: 'message',
          id: 'a2',
          parentId: 'u2',
          role: 'assistant',
          text: 'Continued answer',
          hasVisibleText: true,
          timestamp: '2026-07-13T10:00:04.000Z',
        },
        { type: 'message', id: 'tool', parentId: 'a2', role: 'toolResult', text: 'tool output', hasVisibleText: true },
        { type: 'custom', id: 'custom', parentId: 'tool', customType: 'example', data: { x: 1 } },
      ],
      ['header', 'u1', 'u2', 'a2', 'tool', 'custom']
    );

    expect(await importExported(value)).toBe(0);
    expect(db.prepare('select count(*) as count from pi_entry_index').get()).toEqual({ count: 7 });
    expect(db.prepare('select count(*) as count from posts').get()).toEqual({ count: 0 });
    expect(db.prepare("select reason from pi_sync_anomalies where pi_message_id = 'u2'").get()).toEqual({
      reason: 'external-message-settling',
    });

    settleIndex(db);
    expect(await importExported(value)).toBe(3);
    expect(db.prepare('select source_message_id, body, silent from posts order by created_at').all()).toEqual([
      { source_message_id: 'u1', body: 'CLI prompt', silent: 0 },
      { source_message_id: 'u2', body: ',', silent: 0 },
      { source_message_id: 'a2', body: 'Continued answer', silent: 0 },
    ]);
    expect(
      db
        .prepare(
          "select count(*) as count from pi_message_links where pi_message_id in ('a-inactive', 'tool', 'custom')"
        )
        .get()
    ).toEqual({ count: 0 });
    expect(db.prepare("select status from pi_sync_anomalies where pi_message_id = 'u2'").get()).toEqual({
      status: 'resolved',
    });
    db.close();
  });

  it('uses provenance and causal ancestry to reconcile prompts and project canonical outward assistants', async () => {
    const { db, importExported } = createSyncFixture();
    const first = exported([{ type: 'session', id: 'header' }], ['header']);
    await importExported(first);
    const target = db.prepare("select topic_id from pi_session_links where pi_session_id = 'pi-session-1'").get() as {
      topic_id: string;
    };
    const author = db.prepare("select id from identities where display_name = 'Pi CLI'").get() as { id: string };
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('forum-post-1', target.topic_id, author.id, 'Forum prompt', null, 0, '2026-07-13T10:00:01.000Z');

    const value = exported(
      [
        { type: 'session', id: 'header' },
        { type: 'message', id: 'u1', parentId: 'header', role: 'user', text: 'Forum prompt', hasVisibleText: true },
        {
          type: 'message',
          id: 'a-tool',
          parentId: 'u1',
          role: 'assistant',
          text: 'I will inspect that.',
          hasVisibleText: true,
          stopReason: 'toolUse',
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'a-tool',
          role: 'assistant',
          text: 'Forum answer',
          hasVisibleText: true,
          stopReason: 'stop',
        },
        { type: 'custom', id: 'p1', parentId: 'a1', customType: 'monika.message.provenance' },
      ],
      ['header', 'u1', 'a-tool', 'a1', 'p1'],
      [
        {
          piMessageId: 'u1',
          origin: 'forum',
          topicId: target.topic_id,
          postId: 'forum-post-1',
          messageKind: 'user_prompt',
        },
        {
          piMessageId: 'a1',
          origin: 'forum',
          topicId: target.topic_id,
          postId: 'forum-post-1',
          messageKind: 'assistant_terminal',
        },
      ]
    );
    expect(await importExported(value)).toBe(1);
    expect(db.prepare("select post_id from pi_message_links where pi_message_id = 'u1'").get()).toEqual({
      post_id: 'forum-post-1',
    });
    const assistantLink = db.prepare("select post_id from pi_message_links where pi_message_id = 'a1'").get() as { post_id: string };
    expect(assistantLink.post_id).toBeTruthy();
    expect(db.prepare('select body from posts where id = ?').get(assistantLink.post_id)).toEqual({ body: 'Forum answer' });
    expect(db.prepare("select count(*) as count from pi_sync_anomalies where pi_message_id in ('a-tool', 'a1')").get()).toEqual({
      count: 0,
    });
    expect(await importExported(value)).toBe(0);
    expect(db.prepare("select count(*) as count from posts where body = 'Forum answer'").get()).toEqual({ count: 1 });
    db.close();
  });

  it('durably captures marker-only and mixed v1/v2 attachment handoffs exactly once across restart scans', async () => {
    const { db, importExported } = createSyncFixture();
    const value = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message', id: 'marker-only', parentId: 'header', role: 'assistant',
          text: 'Marker answer\n[forum-attachment id="pending-v1"]', hasVisibleText: true, stopReason: 'stop',
        },
        {
          type: 'message', id: 'mixed', parentId: 'marker-only', role: 'assistant',
          text: 'Mixed answer\n[forum-attachment id="pending-legacy"]', hasVisibleText: true, stopReason: 'stop',
        },
      ],
      ['header', 'marker-only', 'mixed'],
      [{
        piMessageId: 'mixed', version: 2, messageKind: 'assistant_outward', utteranceId: 'mixed',
        attachmentRefs: [{ refEntryId: 'custom-ref-entry', pendingAttachmentId: 'pending-v2' }],
      }]
    );
    expect(await importExported(value)).toBe(2);
    expect(await importExported(value)).toBe(0);
    expect(db.prepare('select pi_message_id, status from assistant_projections order by rowid').all()).toEqual([
      { pi_message_id: 'marker-only', status: 'linking' },
      { pi_message_id: 'mixed', status: 'linking' },
    ]);
    expect(db.prepare('select ref_entry_id from attachment_handoffs order by rowid').all()).toEqual([
      { ref_entry_id: 'legacy-marker:marker-only:pending-v1' },
      { ref_entry_id: 'custom-ref-entry' },
      { ref_entry_id: 'legacy-marker:mixed:pending-legacy' },
    ]);
    expect(db.prepare("select count(*) as count from posts where body in ('Marker answer', 'Mixed answer')").get()).toEqual({ count: 0 });
    db.close();
  });

  it('keeps fenced legacy markers as text and does not stage a handoff', async () => {
    const { db, importExported } = createSyncFixture();
    const value = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message', id: 'fenced-marker', parentId: 'header', role: 'assistant',
          text: 'Example:\n```text\n[forum-attachment id="not-a-handoff"]\n```', hasVisibleText: true, stopReason: 'stop',
        },
      ],
      ['header', 'fenced-marker'],
      [{ piMessageId: 'fenced-marker', version: 2, messageKind: 'assistant_outward', utteranceId: 'fenced-marker' }]
    );
    expect(await importExported(value)).toBe(1);
    expect(db.prepare("select count(*) as count from attachment_handoffs").get()).toEqual({ count: 0 });
    expect(db.prepare("select body from posts where body like '%not-a-handoff%'").get()).toEqual({
      body: 'Example:\n```text\n[forum-attachment id="not-a-handoff"]\n```',
    });
    db.close();
  });

  it('projects a subagent completion once, under its originating post, without a fake user post', async () => {
    const { db, importExported } = createSyncFixture();
    await importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const target = db.prepare("select topic_id from pi_session_links where pi_session_id = 'pi-session-1'").get() as {
      topic_id: string;
    };
    const human = db.prepare("select id from identities where display_name = 'Pi CLI'").get() as { id: string };
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('origin-post', target.topic_id, human.id, 'Start background work', null, 0, '2026-07-13T10:00:00.000Z');
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('newer-post', target.topic_id, human.id, 'A newer active request', null, 0, '2026-07-13T10:00:01.000Z');

    const completed = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message', id: 'completion-a1', parentId: 'header', role: 'assistant', text: 'Background result',
          hasVisibleText: true, stopReason: 'stop', timestamp: '2026-07-13T10:00:02.000Z',
        },
      ],
      ['header', 'completion-a1'],
      [{
        piMessageId: 'completion-a1', origin: 'subagent-completion', sourceKind: 'subagent-completion',
        runId: 'run-1', originTurnId: 'turn-origin', originPostId: 'origin-post', originTopicId: target.topic_id,
      }]
    );

    expect(await importExported(completed)).toBe(1);
    expect(await importExported(completed)).toBe(0);
    expect(db.prepare("select body, parent_post_id from posts where source_message_id = 'completion-a1'").get()).toEqual({
      body: 'Background result', parent_post_id: 'origin-post',
    });
    expect(db.prepare("select count(*) as count from posts where body not in ('Start background work', 'A newer active request', 'Background result')").get()).toEqual({ count: 0 });
    expect(db.prepare("select count(*) as count from posts where source_message_id = 'completion-a1'").get()).toEqual({ count: 1 });
    expect(JSON.parse((db.prepare("select metadata_json from pi_message_links where pi_message_id = 'completion-a1'").get() as any).metadata_json)).toMatchObject({
      sourceKind: 'subagent-completion', runId: 'run-1', originPostId: 'origin-post',
    });
    db.close();
  });

  it('treats a CLI continuation after an older forum turn and compaction as external', async () => {
    const { db, importExported } = createSyncFixture();
    const initial = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message',
          id: 'forum-user',
          parentId: 'header',
          role: 'user',
          text: '[FORUM TURN]\npostId=forum-post-1\n[/FORUM TURN]\n\nOriginal request',
          hasVisibleText: true,
        },
      ],
      ['header', 'forum-user']
    );
    await importExported(initial);
    const target = db.prepare("select topic_id from pi_session_links where pi_session_id = 'pi-session-1'").get() as {
      topic_id: string;
    };
    const author = db.prepare("select id from identities where display_name = 'Pi CLI'").get() as { id: string };
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('forum-post-1', target.topic_id, author.id, 'Original request', null, 0, '2026-07-13T10:00:00.000Z');
    await importExported(initial);

    const continued = exported(
      [
        ...initial.entries,
        { type: 'compaction', id: 'compact', parentId: 'forum-user', timestamp: '2026-07-13T10:01:00.000Z' },
        {
          type: 'message',
          id: 'cli-user',
          parentId: 'compact',
          role: 'user',
          text: 'Continue after recovery',
          hasVisibleText: true,
          timestamp: '2026-07-13T10:01:01.000Z',
        },
        {
          type: 'message',
          id: 'cli-assistant',
          parentId: 'cli-user',
          role: 'assistant',
          text: 'Recovered answer',
          hasVisibleText: true,
          stopReason: 'stop',
          timestamp: '2026-07-13T10:01:02.000Z',
        },
      ],
      ['header', 'forum-user', 'compact', 'cli-user', 'cli-assistant']
    );
    expect(await importExported(continued)).toBe(0);
    settleIndex(db);
    expect(await importExported(continued)).toBe(2);
    expect(
      db
        .prepare(
          "select source_message_id, body from posts where source_message_id in ('cli-user', 'cli-assistant') order by created_at"
        )
        .all()
    ).toEqual([
      { source_message_id: 'cli-user', body: 'Continue after recovery' },
      { source_message_id: 'cli-assistant', body: 'Recovered answer' },
    ]);
    db.close();
  });

  it('preserves posts that leave the active branch and records projection divergence', async () => {
    const { db, importExported } = createSyncFixture();
    const entries = [
      { type: 'session', id: 'header' },
      { type: 'message', id: 'u1', parentId: 'header', role: 'user', text: 'Original branch', hasVisibleText: true },
      { type: 'message', id: 'u2', parentId: 'header', role: 'user', text: 'Replacement branch', hasVisibleText: true },
    ];
    await importExported(exported(entries, ['header', 'u1']));
    settleIndex(db);
    await importExported(exported(entries, ['header', 'u1']));
    const post = db.prepare("select id from posts where source_message_id = 'u1'").get() as { id: string };

    await importExported(exported(entries, ['header', 'u2']));
    expect(db.prepare('select id from posts where id = ?').get(post.id)).toEqual({ id: post.id });
    expect(
      db
        .prepare("select pi_message_id, post_id, status from pi_projection_divergences where pi_message_id = 'u1'")
        .get()
    ).toEqual({ pi_message_id: 'u1', post_id: post.id, status: 'inactive_branch' });
    db.close();
  });

  it('waits for an idle robot before projecting a settled external continuation', async () => {
    const { db, importExported } = createSyncFixture();
    await importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const value = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message',
          id: 'u1',
          parentId: 'header',
          role: 'user',
          text: 'While the forum turn is running',
          hasVisibleText: true,
        },
      ],
      ['header', 'u1']
    );
    await importExported(value);
    settleIndex(db);
    const link = db
      .prepare("select topic_id, session_id from pi_session_links where pi_session_id = 'pi-session-1'")
      .get() as { topic_id: string; session_id: string };
    db.prepare('insert into robot_state (topic_id, session_id, activity, last_updated_at) values (?, ?, ?, ?)').run(
      link.topic_id,
      link.session_id,
      'thinking',
      '2026-07-13T10:00:00.000Z'
    );

    expect(await importExported(value)).toBe(0);
    expect(db.prepare('select count(*) as count from posts').get()).toEqual({ count: 0 });
    db.prepare("update robot_state set activity = 'idle' where topic_id = ?").run(link.topic_id);
    expect(await importExported(value)).toBe(1);
    expect(db.prepare("select body from posts where source_message_id = 'u1'").get()).toEqual({
      body: 'While the forum turn is running',
    });
    db.close();
  });

  it('keeps ignored external messages as projection tombstones across later rescans', async () => {
    const { db, service, importExported } = createSyncFixture();
    await importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const value = exported([
      { type: 'session', id: 'header' },
      { type: 'message', id: 'u1', parentId: 'header', role: 'user', text: 'Do not project this', hasVisibleText: true },
    ], ['header', 'u1']);
    expect(await importExported(value)).toBe(0);
    const anomaly = db.prepare("select id from pi_sync_anomalies where pi_message_id = 'u1'").get() as { id: string };
    expect(service.ignoreAnomaly(anomaly.id, 'admin')).toEqual({ ok: true, message: 'Anomaly ignored.' });
    settleIndex(db);
    expect(await importExported(value)).toBe(0);
    expect(db.prepare("select count(*) as count from posts where source_message_id = 'u1'").get()).toEqual({ count: 0 });
    expect(db.prepare("select status from pi_sync_anomalies where pi_message_id = 'u1'").get()).toEqual({ status: 'ignored' });
    db.close();
  });

  it('silently auto-repairs legacy unresolved null links and supports an explicit audited bump', async () => {
    const { db, service, importExported } = createSyncFixture();
    await importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const value = exported(
      [
        { type: 'session', id: 'header' },
        {
          type: 'message',
          id: 'u1',
          parentId: 'header',
          role: 'user',
          text: 'Historical CLI continuation',
          hasVisibleText: true,
        },
      ],
      ['header', 'u1']
    );
    await importExported(value);
    db.prepare("update pi_message_links set metadata_json = ? where pi_message_id = 'u1'").run(
      JSON.stringify({ deferredLiveForumPost: true })
    );

    expect(await importExported(value)).toBe(1);
    expect(db.prepare("select silent from posts where source_message_id = 'u1'").get()).toEqual({ silent: 1 });
    expect(db.prepare("select post_id from pi_message_links where pi_message_id = 'u1'").get()).toEqual({
      post_id: expect.any(String),
    });
    const topic = db.prepare("select topic_id from pi_session_links where pi_session_id = 'pi-session-1'").get() as {
      topic_id: string;
    };
    const before = (
      db.prepare('select updated_at from topics where id = ?').get(topic.topic_id) as { updated_at: string }
    ).updated_at;
    expect(service.bumpRepairedTopic(topic.topic_id)).toEqual({ ok: true, message: 'Repaired topic bumped.' });
    expect(
      (db.prepare('select updated_at from topics where id = ?').get(topic.topic_id) as { updated_at: string })
        .updated_at
    ).not.toBe(before);
    db.close();
  });
});

describe('detectHistoricalTerminalErrors', async () => {
  const session = { id: 'pi-errors', path: '/tmp/pi-errors.jsonl', cwd: '/tmp' };
  const make = (entries: ExportedSession['entries'], active: string[]): ExportedSession => ({
    session,
    entries,
    active_branch: { leaf_id: active.at(-1) ?? null, active_entry_ids: active },
  });

  it('returns the final unrecovered error in a user turn', async () => {
    const value = make(
      [
        { type: 'message', id: 'u1', role: 'user', text: 'hello' },
        { type: 'message', id: 'a1', role: 'assistant', stopReason: 'error', errorMessage: 'context window exceeded' },
      ],
      ['u1', 'a1']
    );
    expect(detectHistoricalTerminalErrors(value)).toEqual([
      { userEntryId: 'u1', assistantEntryId: 'a1', error: 'context window exceeded' },
    ]);
  });

  it('suppresses failures recovered before the next user turn', async () => {
    const value = make(
      [
        { type: 'message', id: 'u1', role: 'user', text: 'hello' },
        { type: 'message', id: 'a1', role: 'assistant', stopReason: 'error', errorMessage: 'temporary overload' },
        { type: 'compaction', id: 'c1' },
        { type: 'message', id: 'a2', role: 'assistant', stopReason: 'stop', text: 'recovered' },
      ],
      ['u1', 'a1', 'c1', 'a2']
    );
    expect(detectHistoricalTerminalErrors(value)).toEqual([]);
  });

  it('ignores errors outside the active branch', async () => {
    const value = make(
      [
        { type: 'message', id: 'u1', role: 'user', text: 'hello' },
        { type: 'message', id: 'abandoned', role: 'assistant', stopReason: 'error', errorMessage: 'abandoned error' },
        { type: 'message', id: 'a2', role: 'assistant', stopReason: 'stop', text: 'active answer' },
      ],
      ['u1', 'a2']
    );
    expect(detectHistoricalTerminalErrors(value)).toEqual([]);
  });
});
