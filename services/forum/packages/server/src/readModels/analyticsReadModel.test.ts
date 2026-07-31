import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../migrations';
import { SqliteForumAnalyticsReadModel, analyticsTokenizeForTest } from './analyticsReadModel';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  const now = '2026-07-15T12:00:00.000Z';
  db.prepare(
    `insert into forums (id,name,status,visibility,created_at,updated_at) values ('f1','Writing','active','public',?,?),('f2','Runtime','active','admin',?,?)`
  ).run(now, now, now, now);
  db.prepare(
    `insert into topics (id,forum_id,title,status,tags_json,robot_mode,created_by,created_at,updated_at) values ('t1','f1','Novel','open','[]','auto','u1',?,?),('t2','f2','Tools','open','[]','auto','u1',?,?)`
  ).run(now, now, now, now);
  db.prepare(
    `insert into identities (id,display_name,kind,created_at,updated_at) values ('u1','Neon','admin',?,?),('r1','Monika','robot',?,?)`
  ).run(now, now, now, now);
  db.prepare(
    `insert into sessions (id,topic_id,created_at,updated_at,status) values ('s1','t1',?,?,'active'),('s2','t2',?,?,'active')`
  ).run(now, now, now, now);
  db.prepare(
    `insert into pi_session_links (id,pi_session_id,pi_session_path,topic_id,session_id,kind,imported_at) values ('l1','pi-1','/pi/1','t1','s1','forum',?),('l2','pi-2','/pi/2','t2','s2','forum',?)`
  ).run(now, now);
  const insert = db.prepare(`insert into posts (id,topic_id,author_id,body,silent,created_at) values (?,?,?,?,?,?)`);
  insert.run('p1', 't1', 'u1', 'The starlight archive remembers starlight and archive.', 0, now);
  insert.run('p2', 't1', 'r1', 'Archive custody makes starlight tangible.', 0, now);
  insert.run('p3', 't2', 'u1', 'Tool failure testing testing reliability.', 0, now);
  insert.run('p4', 't2', 'r1', 'Reliability traces expose tool failure.', 0, now);
  insert.run('p5', 't1', 'u1', '```starlight hidden hidden``` https://example.test hidden', 0, now);
  insert.run('p6', 't1', 'u1', 'starlight deleted', 0, now);
  insert.run('p7', 't1', 'u1', 'Starlight cadence continues. unique-secret unique-secret', 0, now);
  db.prepare(`update posts set deleted_at=? where id='p6'`).run(now);
  return { db, readModel: new SqliteForumAnalyticsReadModel(db) };
}

describe('SqliteForumAnalyticsReadModel', () => {
  it('scopes canonical sessions and returns deterministic human/assistant vocabulary without raw code or URLs', async () => {
    const { readModel } = fixture();
    const result = await readModel.getAnalyticsScope({
      window: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', bucket: 'day' },
      forumId: 'f1',
    });
    expect(result.piSessionIds).toEqual(['pi-1']);
    expect(result.forums.map((forum) => forum.id)).toEqual(['f2', 'f1']);
    expect(result.vocabulary.every((group) => group.forumId === 'f1')).toBe(true);
    expect(result.vocabulary.find((group) => group.audience === 'human')?.terms.map((term) => term.term)).toContain(
      'starlight'
    );
    const terms = result.vocabulary.flatMap((group) => group.terms).map((term) => term.term);
    expect(terms).not.toContain('hidden');
    expect(terms).not.toContain('unique-secret');
  });

  it('strips forum envelopes, markdown code, URLs and stop words', () => {
    const terms = analyticsTokenizeForTest(
      '[FORUM TURN] secret [/FORUM TURN] The useful cadence `ignored` https://example.test'
    );
    expect(terms).toEqual(['useful', 'cadence']);
  });
});
