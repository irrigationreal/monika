import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { ForumStore } from './store';

describe('robot state live plan invariant', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTopicSessionAndPlan() {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'hello',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    const plan = store.createPlan({
      topicId: topic.id,
      sessionId: session.id,
      content: 'old live reasoning',
      summary: 'old live reasoning',
      parentPostId: post.id,
      visibility: 'internal',
    });
    return { topic, session, plan };
  }

  it('clears current_plan_id when upserting idle state', () => {
    const { topic, session, plan } = createTopicSessionAndPlan();

    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });

    const idle = store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'idle',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });

    expect(idle.current_plan_id).toBeNull();
  });

  it('clears current_plan_id when setting activity to idle', () => {
    const { topic, session, plan } = createTopicSessionAndPlan();

    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });

    const idle = store.setRobotActivity(topic.id, 'idle');

    expect(idle?.current_plan_id).toBeNull();
  });

  it('clears current_plan_id when recording a turn error', () => {
    const { topic, session, plan } = createTopicSessionAndPlan();

    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });

    const idle = store.setRobotTurnError(topic.id, { message: 'failed' });

    expect(idle?.activity).toBe('idle');
    expect(idle?.current_plan_id).toBeNull();
  });

  it('clears current_plan_id during startup-style activity reset', () => {
    const { topic, session, plan } = createTopicSessionAndPlan();

    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });

    expect(store.resetRobotActivities('idle')).toBe(1);
    expect(store.getRobotState(topic.id)?.current_plan_id).toBeNull();
  });

  it('clears stale idle current_plan_id during startup-style activity reset', () => {
    const { topic, session, plan } = createTopicSessionAndPlan();

    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'model',
      reasoningEffort: 'medium',
      currentPlanId: plan.id,
    });
    store.setRobotActivity(topic.id, 'idle');
    // Simulate stale pre-migration state.
    db.prepare('update robot_state set current_plan_id = ? where topic_id = ?').run(plan.id, topic.id);

    expect(store.resetRobotActivities('idle')).toBe(1);
    expect(store.getRobotState(topic.id)?.current_plan_id).toBeNull();
  });
});
