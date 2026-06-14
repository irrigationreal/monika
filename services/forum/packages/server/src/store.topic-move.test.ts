import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { ForumStore } from './store';

describe('Topic move', () => {
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

  it('moves a topic, creates a marker post, and preserves references', () => {
    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const admin = store.createIdentity('Admin', 'admin');
    const { topic } = store.createTopic({
      forumId: forumA.id,
      title: 'Test topic',
      body: 'Initial body',
      authorId: admin.id
    });

    const session = store.ensureSession({ topicId: topic.id });
    store.setSessionPersonasSyncedAt(session.id, new Date().toISOString());

    const external = store.createExternalRef({
      surfaceId: 'discord',
      surfaceKind: 'guild',
      externalId: '123',
      kind: 'topic',
      mappedForumId: forumA.id,
      mappedTopicId: topic.id
    });

    const result = store.moveTopic({
      topicId: topic.id,
      toForumId: forumB.id,
      movedBy: admin.id,
      markerBody: 'Automatic post: moved.'
    });

    const updatedTopic = store.getTopic(topic.id);
    expect(updatedTopic?.forum_id).toBe(forumB.id);

    const markerPost = store.getPost(result.markerPost.id);
    expect(markerPost?.body).toContain('Automatic post:');

    const move = store.getTopicMove(result.move.id);
    expect(move?.fromForumId).toBe(forumA.id);
    expect(move?.toForumId).toBe(forumB.id);
    expect(move?.needsReprompt).toBe(true);

    const updatedSession = store.getSession(session.id);
    expect(updatedSession?.personas_synced_at).toBeNull();

    const updatedExternal = store.getExternalRef(external.id);
    expect(updatedExternal?.mapped_forum_id).toBe(forumB.id);
  });

  it('clears pending move prompts', () => {
    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const admin = store.createIdentity('Admin', 'admin');
    const { topic } = store.createTopic({
      forumId: forumA.id,
      title: 'Test topic',
      body: 'Initial body',
      authorId: admin.id
    });

    const result = store.moveTopic({
      topicId: topic.id,
      toForumId: forumB.id,
      movedBy: admin.id,
      markerBody: 'Automatic post: moved.'
    });

    const pending = store.getPendingTopicMove(topic.id);
    expect(pending?.id).toBe(result.move.id);

    store.clearTopicMovePrompt(result.move.id);
    const cleared = store.getPendingTopicMove(topic.id);
    expect(cleared).toBeNull();
  });

  it('keeps only the latest move pending when moved multiple times', () => {
    const forumA = store.createForum('Forum A');
    const forumB = store.createForum('Forum B');
    const forumC = store.createForum('Forum C');
    const admin = store.createIdentity('Admin', 'admin');
    const { topic } = store.createTopic({
      forumId: forumA.id,
      title: 'Test topic',
      body: 'Initial body',
      authorId: admin.id
    });

    const move1 = store.moveTopic({
      topicId: topic.id,
      toForumId: forumB.id,
      movedBy: admin.id,
      markerBody: 'Automatic post: moved 1.'
    });
    const pending1 = store.getPendingTopicMove(topic.id);
    expect(pending1?.id).toBe(move1.move.id);

    const move2 = store.moveTopic({
      topicId: topic.id,
      toForumId: forumC.id,
      movedBy: admin.id,
      markerBody: 'Automatic post: moved 2.'
    });

    const moves = store.listTopicMoves(topic.id);
    expect(moves).toHaveLength(2);
    expect(moves[0]?.id).toBe(move2.move.id);

    const pending2 = store.getPendingTopicMove(topic.id);
    expect(pending2?.id).toBe(move2.move.id);

    const oldMove = store.getTopicMove(move1.move.id);
    expect(oldMove?.needsReprompt).toBe(false);
  });
});
