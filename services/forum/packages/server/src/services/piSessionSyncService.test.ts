import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../migrations';
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
      service as unknown as { importExported(value: ExportedSession, summary: ExportedSession['session']): number }
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

describe('PiSessionSyncService forum cwd reconciliation', () => {
  it('backfills a taxonomy cwd when the existing forum cwd is null', () => {
    const { db, ensureForum } = createService(null);

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace' });

    db.close();
  });

  it('preserves an explicit forum cwd', () => {
    const { db, ensureForum } = createService('/workspace/custom');

    expect(ensureForum('/workspace')).toBe('forum-1');
    expect(db.prepare('select cwd from forums where id = ?').get('forum-1')).toEqual({ cwd: '/workspace/custom' });

    db.close();
  });
});

describe('PiSessionSyncService provenance-aware reconciliation', () => {
  it('indexes complete topology but projects conversational text from the active branch only after settlement', () => {
    const { db, importExported } = createSyncFixture();
    importExported(exported([{ type: 'session', id: 'header' }], ['header']));
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

    expect(importExported(value)).toBe(0);
    expect(db.prepare('select count(*) as count from pi_entry_index').get()).toEqual({ count: 7 });
    expect(db.prepare('select count(*) as count from posts').get()).toEqual({ count: 0 });
    expect(db.prepare("select reason from pi_sync_anomalies where pi_message_id = 'u2'").get()).toEqual({
      reason: 'external-message-settling',
    });

    settleIndex(db);
    expect(importExported(value)).toBe(3);
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

  it('uses provenance and causal ancestry to reconcile forum prompts and defer assistant posts to the bridge', () => {
    const { db, service, importExported } = createSyncFixture();
    const first = exported([{ type: 'session', id: 'header' }], ['header']);
    importExported(first);
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
    expect(importExported(value)).toBe(0);
    expect(db.prepare("select post_id from pi_message_links where pi_message_id = 'u1'").get()).toEqual({
      post_id: 'forum-post-1',
    });
    expect(db.prepare("select post_id from pi_message_links where pi_message_id = 'a1'").get()).toEqual({
      post_id: null,
    });
    expect(db.prepare("select count(*) as count from pi_sync_anomalies where pi_message_id = 'a-tool'").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("select reason from pi_sync_anomalies where pi_message_id = 'a1'").get()).toEqual({
      reason: 'forum-origin-awaiting-bridge',
    });
    expect(service.getRepairInventory().candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ piMessageId: 'a1', action: 'defer_to_bridge', confidence: 'high' }),
      ])
    );

    const robot = db.prepare("select id from identities where display_name = 'Monika'").get() as { id: string };
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('bridge-answer', target.topic_id, robot.id, 'Forum answer', null, 0, '2026-07-13T10:00:02.000Z');
    db.prepare("update pi_message_links set post_id = 'bridge-answer' where pi_message_id = 'a1'").run();
    expect(importExported(value)).toBe(0);
    expect(db.prepare("select status, resolution from pi_sync_anomalies where pi_message_id = 'a1'").get()).toEqual({
      status: 'resolved',
      resolution: 'linked_by_bridge',
    });
    db.close();
  });

  it('treats a CLI continuation after an older forum turn and compaction as external', () => {
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
    importExported(initial);
    const target = db.prepare("select topic_id from pi_session_links where pi_session_id = 'pi-session-1'").get() as {
      topic_id: string;
    };
    const author = db.prepare("select id from identities where display_name = 'Pi CLI'").get() as { id: string };
    db.prepare(
      'insert into posts (id, topic_id, author_id, body, source_message_id, silent, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    ).run('forum-post-1', target.topic_id, author.id, 'Original request', null, 0, '2026-07-13T10:00:00.000Z');
    importExported(initial);

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
    expect(importExported(continued)).toBe(0);
    settleIndex(db);
    expect(importExported(continued)).toBe(2);
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

  it('preserves posts that leave the active branch and records projection divergence', () => {
    const { db, importExported } = createSyncFixture();
    const entries = [
      { type: 'session', id: 'header' },
      { type: 'message', id: 'u1', parentId: 'header', role: 'user', text: 'Original branch', hasVisibleText: true },
      { type: 'message', id: 'u2', parentId: 'header', role: 'user', text: 'Replacement branch', hasVisibleText: true },
    ];
    importExported(exported(entries, ['header', 'u1']));
    settleIndex(db);
    importExported(exported(entries, ['header', 'u1']));
    const post = db.prepare("select id from posts where source_message_id = 'u1'").get() as { id: string };

    importExported(exported(entries, ['header', 'u2']));
    expect(db.prepare('select id from posts where id = ?').get(post.id)).toEqual({ id: post.id });
    expect(
      db
        .prepare("select pi_message_id, post_id, status from pi_projection_divergences where pi_message_id = 'u1'")
        .get()
    ).toEqual({ pi_message_id: 'u1', post_id: post.id, status: 'inactive_branch' });
    db.close();
  });

  it('waits for an idle robot before projecting a settled external continuation', () => {
    const { db, importExported } = createSyncFixture();
    importExported(exported([{ type: 'session', id: 'header' }], ['header']));
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
    importExported(value);
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

    expect(importExported(value)).toBe(0);
    expect(db.prepare('select count(*) as count from posts').get()).toEqual({ count: 0 });
    db.prepare("update robot_state set activity = 'idle' where topic_id = ?").run(link.topic_id);
    expect(importExported(value)).toBe(1);
    expect(db.prepare("select body from posts where source_message_id = 'u1'").get()).toEqual({
      body: 'While the forum turn is running',
    });
    db.close();
  });

  it('keeps ignored external messages as projection tombstones across later rescans', () => {
    const { db, service, importExported } = createSyncFixture();
    importExported(exported([{ type: 'session', id: 'header' }], ['header']));
    const value = exported([
      { type: 'session', id: 'header' },
      { type: 'message', id: 'u1', parentId: 'header', role: 'user', text: 'Do not project this', hasVisibleText: true },
    ], ['header', 'u1']);
    expect(importExported(value)).toBe(0);
    const anomaly = db.prepare("select id from pi_sync_anomalies where pi_message_id = 'u1'").get() as { id: string };
    expect(service.ignoreAnomaly(anomaly.id, 'admin')).toEqual({ ok: true, message: 'Anomaly ignored.' });
    settleIndex(db);
    expect(importExported(value)).toBe(0);
    expect(db.prepare("select count(*) as count from posts where source_message_id = 'u1'").get()).toEqual({ count: 0 });
    expect(db.prepare("select status from pi_sync_anomalies where pi_message_id = 'u1'").get()).toEqual({ status: 'ignored' });
    db.close();
  });

  it('silently auto-repairs legacy unresolved null links and supports an explicit audited bump', () => {
    const { db, service, importExported } = createSyncFixture();
    importExported(exported([{ type: 'session', id: 'header' }], ['header']));
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
    importExported(value);
    db.prepare("update pi_message_links set metadata_json = ? where pi_message_id = 'u1'").run(
      JSON.stringify({ deferredLiveForumPost: true })
    );

    expect(importExported(value)).toBe(1);
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

describe('detectHistoricalTerminalErrors', () => {
  const session = { id: 'pi-errors', path: '/tmp/pi-errors.jsonl', cwd: '/tmp' };
  const make = (entries: ExportedSession['entries'], active: string[]): ExportedSession => ({
    session,
    entries,
    active_branch: { leaf_id: active.at(-1) ?? null, active_entry_ids: active },
  });

  it('returns the final unrecovered error in a user turn', () => {
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

  it('suppresses failures recovered before the next user turn', () => {
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

  it('ignores errors outside the active branch', () => {
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
