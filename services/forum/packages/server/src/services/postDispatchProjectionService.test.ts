import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { PostDispatchProjectionService } from './postDispatchProjectionService';

describe('PostDispatchProjectionService', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  function fixture() {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'initial', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    const post = store.createPost({ topicId: topic.id, authorId: author.id, body: 'work' });
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    return { topic, dispatch };
  }

  it('polls for newly pending work but renders only delayed pending work as a warning', () => {
    const { topic, dispatch } = fixture();
    const service = new PostDispatchProjectionService(store);

    expect(service.getTopicProjection(topic.id)).toMatchObject({
      topicId: topic.id,
      polling: true,
      current: [],
    });

    const claimed = store.claimPostDispatch(dispatch.id, dispatch)!;
    store.markPostDispatchFailed(dispatch.id, claimed.claim_token!, 'transport outage', {
      retryAt: '2030-01-01T00:00:00.000Z',
      classification: 'transport',
    });
    expect(service.getTopicProjection(topic.id)).toMatchObject({
      polling: true,
      current: [{ dispatchId: dispatch.id, status: 'pending', attemptCount: 1 }],
    });
  });

  it('keeps terminal failures visible without continuing to poll', () => {
    const { topic, dispatch } = fixture();
    const claimed = store.claimPostDispatch(dispatch.id, dispatch)!;
    store.markPostDispatchFailed(dispatch.id, claimed.claim_token!, 'definite failure', {
      classification: 'application',
    });

    expect(new PostDispatchProjectionService(store).getTopicProjection(topic.id)).toMatchObject({
      topicId: topic.id,
      polling: false,
      current: [{ dispatchId: dispatch.id, status: 'failed' }],
    });
  });
});
