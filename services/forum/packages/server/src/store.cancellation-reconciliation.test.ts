import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { ForumStore } from './store';

describe('durable cancellation reconciliation store', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  function unresolvedFixture(index: number) {
    const forum = store.createForum(`forum-${index}`);
    const author = store.createIdentity(`Author ${index}`, `author-${index}`, 'human');
    const created = store.createTopic({
      forumId: forum.id,
      title: `Topic ${index}`,
      body: 'body',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: created.topic.id });
    store.upsertRobotState({
      topicId: created.topic.id,
      sessionId: session.id,
      activity: 'stopping',
      currentPlanId: null,
    });
    store.upsertPiSessionLink({
      piSessionId: `pi-${index}`,
      piSessionPath: `/tmp/pi-${index}.jsonl`,
      topicId: created.topic.id,
      sessionId: session.id,
    });
    const generation = store.getTopicDispatchGeneration(created.topic.id);
    db.prepare('update robot_state set last_updated_at = ? where topic_id = ?').run(
      new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      created.topic.id
    );
    return { topicId: created.topic.id, generation };
  }

  it.each(['thinking', 'waiting'])('atomically refuses to overwrite newer %s activity', (activity) => {
    const fixture = unresolvedFixture(1);
    const observed = store.listPiSessionLinksWithUnresolvedCancellation()[0];
    expect(observed?.observed_generation).toBe(fixture.generation);

    store.setRobotActivity(fixture.topicId, activity);

    expect(store.applyCancellationReconciliation(fixture.topicId, fixture.generation, 'stopped')).toBe(false);
    expect(store.applyCancellationReconciliation(fixture.topicId, fixture.generation, 'uncertain')).toBe(false);
    expect(store.getRobotState(fixture.topicId)?.activity).toBe(activity);
  });

  it('atomically refuses a stale generation and applies a current unresolved result', () => {
    const fixture = unresolvedFixture(1);

    expect(store.applyCancellationReconciliation(fixture.topicId, fixture.generation + 1, 'stopped')).toBe(false);
    expect(store.getRobotState(fixture.topicId)?.activity).toBe('stopping');
    expect(store.applyCancellationReconciliation(fixture.topicId, fixture.generation, 'stopped')).toBe(true);
    expect(store.getRobotState(fixture.topicId)?.activity).toBe('stopped');
  });

  it('caps oldest-first batches and rotates null results by conditionally touching them', () => {
    const fixtures = Array.from({ length: 25 }, (_, index) => unresolvedFixture(index));

    const first = store.listPiSessionLinksWithUnresolvedCancellation();
    expect(first).toHaveLength(20);
    expect(first.map((link) => link.pi_session_id)).toEqual(Array.from({ length: 20 }, (_, index) => `pi-${index}`));

    for (const link of first) {
      expect(store.touchUnresolvedCancellation(link.topic_id, link.observed_generation)).toBe(true);
    }

    const second = store.listPiSessionLinksWithUnresolvedCancellation();
    expect(second.slice(0, 5).map((link) => link.pi_session_id)).toEqual(
      Array.from({ length: 5 }, (_, index) => `pi-${index + 20}`)
    );
    expect(fixtures.every(({ topicId }) => store.getRobotState(topicId)?.activity === 'stopping')).toBe(true);
  });
});
