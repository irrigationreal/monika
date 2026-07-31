import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForumStore } from './store';
import {
  MIGRATIONS,
  runMigrations,
  SCHEMA_VERSION
} from './migrations';

describe('schema migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('records applied schema versions', () => {
    runMigrations(db);
    const rows = db
      .prepare('select version from schema_migrations order by version asc')
      .all() as Array<{ version: number }>;
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
      visibility: 'internal'
    });
    const activeTopic = store.createTopic({ forumId: forum.id, title: 'Active', body: 'hello', authorId: author.id });
    const activeSession = store.ensureSession({ topicId: activeTopic.topic.id });
    const activePlan = store.createPlan({
      topicId: activeTopic.topic.id,
      sessionId: activeSession.id,
      content: 'active plan',
      summary: 'active plan',
      parentPostId: activeTopic.post.id,
      visibility: 'internal'
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
