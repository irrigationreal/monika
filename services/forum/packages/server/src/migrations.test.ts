import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from './migrations';
import { ForumStore } from './store';

describe('schema migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('backfills the default-off topic auto-compaction policy', () => {
    runMigrations(db, { targetVersion: 36 });
    db.prepare(
      `insert into forums (id, tenant_id, parent_forum_id, category, name, description, cwd, pre_prompt, status, visibility, archived_at, created_at, updated_at)
       values ('forum-1', null, null, null, 'Forum', null, null, null, 'active', 'public', null, 'now', 'now')`
    ).run();
    db.prepare(
      `insert into identities (id, display_name, kind, created_at, updated_at)
       values ('author-1', 'Author', 'human', 'now', 'now')`
    ).run();
    db.prepare(
      `insert into topics (id, forum_id, tenant_id, title, status, tags_json, robot_mode, created_by, created_at, updated_at)
       values ('topic-1', 'forum-1', null, 'Topic', 'open', '[]', 'auto', 'author-1', 'now', 'now')`
    ).run();

    runMigrations(db);

    expect(
      db.prepare('select auto_compact_enabled, auto_compact_revision from topics where id = ?').get('topic-1')
    ).toEqual({
      auto_compact_enabled: 0,
      auto_compact_revision: 0,
    });
  });

  it('adds durable utterance origin and projection state', () => {
    runMigrations(db);
    const dispatchColumns = db.prepare('pragma table_info(post_dispatches)').all() as Array<{ name: string }>;
    expect(dispatchColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'origin_key', 'origin_json', 'contributor_post_ids_json',
    ]));
    expect(db.prepare("select name from sqlite_master where type = 'table' and name = 'assistant_projections'").get()).toBeTruthy();
    expect(db.prepare("select name from sqlite_master where type = 'table' and name = 'attachment_handoffs'").get()).toBeTruthy();
    expect(db.prepare("select name from sqlite_master where type = 'table' and name = 'active_turn_origins'").get()).toBeTruthy();
    expect(db.prepare("select name from sqlite_master where type = 'table' and name = 'pending_attachment_reservations'").get()).toBeTruthy();
  });

  it('preserves and assigns custody to an existing linked v42 handoff on upgrade', () => {
    runMigrations(db, { targetVersion: 42 });
    const legacyStore = new ForumStore(db);
    const forum = legacyStore.createForum('Forum');
    const human = legacyStore.createIdentity('Human', 'human');
    const robot = legacyStore.createIdentity('Monika', 'robot');
    const { topic } = legacyStore.createTopic({ forumId: forum.id, title: 'Topic', body: 'Initial', authorId: human.id });
    const session = legacyStore.ensureSession({ topicId: topic.id });
    const pending = legacyStore.createPendingAttachment({
      topicId: topic.id, filename: 'existing.txt', mimeType: 'text/plain', sizeBytes: 4,
      storagePath: '/tmp/existing.txt', sha256: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const projection = legacyStore.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-existing-handoff', utteranceId: 'pi-existing-handoff',
      topicId: topic.id, sessionId: session.id, body: 'Existing', authorId: robot.id,
      handoffs: [{
        refEntryId: 'existing-ref', sourceKind: 'structured-pending',
        sourceRef: { pendingAttachmentId: pending.id },
      }],
    });
    db.prepare("update attachment_handoffs set status = 'linked' where projection_id = ?").run(projection.id);

    runMigrations(db);

    expect(db.prepare('select status from attachment_handoffs where projection_id = ?').get(projection.id))
      .toEqual({ status: 'linked' });
    expect(db.prepare('select projection_id from pending_attachment_reservations where pending_attachment_id = ?').get(pending.id))
      .toEqual({ projection_id: projection.id });
  });

  it('adopts an existing v41 canonical assistant link when the live event replays after upgrade', () => {
    runMigrations(db, { targetVersion: 41 });
    const legacyStore = new ForumStore(db);
    const forum = legacyStore.createForum('Forum');
    const human = legacyStore.createIdentity('Human', 'human');
    const robot = legacyStore.createIdentity('Monika', 'robot');
    const { topic } = legacyStore.createTopic({ forumId: forum.id, title: 'Topic', body: 'Initial', authorId: human.id });
    const session = legacyStore.ensureSession({ topicId: topic.id });
    const message = legacyStore.createSessionMessage(session.id, 'assistant', 'Canonical answer', 'public');
    const post = legacyStore.createPost({ topicId: topic.id, authorId: robot.id, body: 'Canonical answer', sourceMessageId: message.id });
    legacyStore.createPiMessageLink({
      piSessionId: 'pi-session', piMessageId: 'pi-assistant', postId: post.id,
      sessionMessageId: message.id, role: 'assistant', metadata: { imported: true },
    });

    runMigrations(db);
    const store = new ForumStore(db);
    const projection = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-assistant', utteranceId: 'pi-assistant',
      topicId: topic.id, sessionId: session.id, body: 'Canonical answer', authorId: robot.id,
    });
    expect(projection.post_id).toBe(post.id);
    expect(db.prepare("select count(*) as count from posts where body = 'Canonical answer'").get()).toEqual({ count: 1 });
    expect(store.getPiMessageLink('pi-session', 'pi-assistant')?.post_id).toBe(post.id);
  });

  it('records applied schema versions', () => {
    runMigrations(db);
    const rows = db.prepare('select version from schema_migrations order by version asc').all() as Array<{
      version: number;
    }>;
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows.at(-1)?.version).toBe(SCHEMA_VERSION);
  });

  it('indexes undeleted posts for bounded recent-post lookups', () => {
    runMigrations(db);

    expect(
      db.prepare("select sql from sqlite_master where type = 'index' and name = 'idx_posts_recent_created_at'").get()
    ).toEqual({
      sql: 'CREATE INDEX idx_posts_recent_created_at\n          on posts(created_at desc)\n          where deleted_at is null',
    });

    const plan = db
      .prepare(
        `explain query plan
         select p.id
         from posts p
         where p.deleted_at is null
         order by p.created_at desc
         limit 15`
      )
      .all() as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes('idx_posts_recent_created_at'))).toBe(true);
  });

  it('deduplicates and uniquely constrains external event references', () => {
    runMigrations(db, { targetVersion: 38 });
    const insert = db.prepare(
      `insert into external_refs (id, surface_id, surface_kind, external_id, kind)
       values (?, 'surface-1', 'matrix', 'event-1', 'post')`
    );
    insert.run('ref-1');
    insert.run('ref-2');

    runMigrations(db);

    expect(db.prepare('select id from external_refs').all()).toEqual([{ id: 'ref-1' }]);
    expect(() => insert.run('ref-3')).toThrow();
  });

  it('fails visibly instead of dropping linked external identities', () => {
    runMigrations(db, { targetVersion: 39 });
    db.prepare(
      `insert into identities (id, display_name, kind, created_at, updated_at) values ('user-1', 'User', 'human', 'now', 'now')`
    ).run();
    db.prepare(
      `insert into external_identities (id, identity_id, provider_key, issuer, subject, created_at)
       values ('external-1', 'user-1', 'legacy', 'https://issuer.example', 'subject', 'now')`
    ).run();

    expect(() => runMigrations(db)).toThrow(/contains 1 row/);
    expect(
      db.prepare("select name from sqlite_master where type = 'table' and name = 'external_identities'").get()
    ).toBeTruthy();
    expect(db.prepare('select version from schema_migrations where version = 40').get()).toBeUndefined();
  });

  it('invalidates legacy sessions, removes refresh sessions, and atomically consumes bound challenges', () => {
    runMigrations(db, { targetVersion: 39 });
    db.prepare(
      `insert into identities (id, display_name, kind, created_at, updated_at) values ('user-1', 'User', 'human', 'now', 'now')`
    ).run();
    db.prepare(
      `insert into identities (id, display_name, kind, created_at, updated_at) values ('user-2', 'Other', 'human', 'now', 'now')`
    ).run();
    db.prepare(
      `insert into auth_sessions (token, identity_id, created_at, expires_at) values ('secret-token', 'user-1', 'now', '2999')`
    ).run();
    runMigrations(db);

    expect(db.prepare('select token_hash from auth_sessions').all()).toEqual([]);
    expect(
      db.prepare("select name from sqlite_master where type = 'table' and name = 'refresh_sessions'").get()
    ).toBeUndefined();

    const store = new ForumStore(db);
    const challenge = store.createWebAuthnChallenge({
      challenge: 'challenge',
      ceremony: 'registration',
      identityId: 'user-1',
    });
    expect(store.consumeWebAuthnChallenge(challenge.id, 'registration', 'user-2')).toBeNull();
    expect(store.consumeWebAuthnChallenge(challenge.id, 'registration', 'user-1')).toBeNull();

    const valid = store.createWebAuthnChallenge({ challenge: 'valid', ceremony: 'authentication', identityId: null });
    expect(store.consumeWebAuthnChallenge(valid.id, 'authentication', null)?.challenge).toBe('valid');
    expect(store.consumeWebAuthnChallenge(valid.id, 'authentication', null)).toBeNull();

    const expired = store.createWebAuthnChallenge({
      challenge: 'expired',
      ceremony: 'authentication',
      identityId: null,
      ttlMs: -1,
    });
    expect(store.consumeWebAuthnChallenge(expired.id, 'authentication', null)).toBeNull();
  });

  it('caps outstanding WebAuthn challenges when creating new ceremonies', () => {
    runMigrations(db);
    const insert = db.prepare(
      `insert into webauthn_challenges (id, challenge, ceremony, identity_id, expires_at, created_at)
       values (?, ?, 'authentication', null, '2999-01-01T00:00:00.000Z', ?)`
    );
    db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const value = String(index).padStart(5, '0');
        insert.run(`id-${value}`, `challenge-${value}`, `2026-01-01T00:00:${value.slice(-2)}.000Z`);
      }
    })();

    const store = new ForumStore(db);
    store.createWebAuthnChallenge({ challenge: 'new', ceremony: 'authentication', identityId: null });
    expect((db.prepare('select count(*) as count from webauthn_challenges').get() as { count: number }).count).toBe(
      10_000
    );
  });

  it('clears stale current plans from idle robot states', () => {
    runMigrations(db, { targetVersion: 30 });
    const store = new ForumStore(db);
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const idleTopic = store.createTopic({ forumId: forum.id, title: 'Idle', body: 'hello', authorId: author.id });
    const idleSession = store.ensureSession({ topicId: idleTopic.topic.id });
    const idlePlan = store.createPlan({
      topicId: idleTopic.topic.id,
      sessionId: idleSession.id,
      content: 'idle stale plan',
      summary: 'idle stale plan',
      parentPostId: idleTopic.post.id,
      visibility: 'internal',
    });
    const activeTopic = store.createTopic({ forumId: forum.id, title: 'Active', body: 'hello', authorId: author.id });
    const activeSession = store.ensureSession({ topicId: activeTopic.topic.id });
    const activePlan = store.createPlan({
      topicId: activeTopic.topic.id,
      sessionId: activeSession.id,
      content: 'active plan',
      summary: 'active plan',
      parentPostId: activeTopic.post.id,
      visibility: 'internal',
    });
    db.prepare(
      `insert into robot_state
        (topic_id, session_id, activity, model, reasoning_effort, last_updated_at, current_plan_id)
       values (?, ?, 'idle', null, null, '2026-06-20T00:00:00.000Z', ?)`
    ).run(idleTopic.topic.id, idleSession.id, idlePlan.id);
    db.prepare(
      `insert into robot_state
        (topic_id, session_id, activity, model, reasoning_effort, last_updated_at, current_plan_id)
       values (?, ?, 'thinking', null, null, '2026-06-20T00:00:00.000Z', ?)`
    ).run(activeTopic.topic.id, activeSession.id, activePlan.id);

    runMigrations(db);

    expect(db.prepare('select current_plan_id from robot_state where topic_id = ?').get(idleTopic.topic.id)).toEqual({
      current_plan_id: null,
    });
    expect(db.prepare('select current_plan_id from robot_state where topic_id = ?').get(activeTopic.topic.id)).toEqual({
      current_plan_id: activePlan.id,
    });
  });
});
