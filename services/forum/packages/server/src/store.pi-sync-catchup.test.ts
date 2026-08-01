import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { ForumStore } from './store';

describe('Pi-linked catch-up filtering', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  it('does not send posts already present in the canonical Pi session back as catch-up context', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('User', 'human');
    const created = store.createTopic({
      forumId: forum.id,
      title: 'Hybrid session',
      body: 'Initial forum post',
      authorId: author.id,
    });
    const session = store.ensureSession({ topicId: created.topic.id });
    const imported = store.createPost({
      topicId: created.topic.id,
      body: 'Entered through Pi CLI',
      authorId: author.id,
    });
    const trigger = store.createPost({ topicId: created.topic.id, body: 'Next forum reply', authorId: author.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-session-1',
      piSessionPath: '/tmp/pi-session-1.jsonl',
      topicId: created.topic.id,
      sessionId: session.id,
    });
    store.createPiMessageLink({
      piSessionId: 'pi-session-1',
      piMessageId: 'pi-user-1',
      postId: imported.id,
      role: 'user',
      metadata: { externalContinuation: true },
    });

    expect(
      store
        .listPostsBetween(created.topic.id, {
          afterPostId: created.post.id,
          beforePostId: trigger.id,
        })
        .map((post) => post.id)
    ).toEqual([imported.id]);
    expect(
      store.listPostsBetween(created.topic.id, {
        afterPostId: created.post.id,
        beforePostId: trigger.id,
        excludePiSessionId: 'pi-session-1',
      })
    ).toEqual([]);
  });

  it('can exclude independently queued posts from a recovery checkpoint catch-up', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('User', 'human');
    const created = store.createTopic({ forumId: forum.id, title: 'Recovery', body: 'Initial', authorId: author.id });
    const session = store.ensureSession({ topicId: created.topic.id });
    const queued = store.createPost({ topicId: created.topic.id, body: 'External while compacting', authorId: author.id });
    store.createPostDispatch({ topicId: created.topic.id, sessionId: session.id, postId: queued.id });
    const checkpoint = store.createPost({ topicId: created.topic.id, body: 'Recovery checkpoint', authorId: author.id });

    expect(
      store.listPostsBetween(created.topic.id, {
        afterPostId: created.post.id,
        beforePostId: checkpoint.id,
        excludePendingDispatches: true,
      })
    ).toEqual([]);
  });
});
