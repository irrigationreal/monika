import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { ForumStore } from './store';

describe('post dispatch origins', () => {
  let db: Database.Database;
  let store: ForumStore;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); store = new ForumStore(db); });
  afterEach(() => db.close());

  it('snapshots external origin and claims only a consecutive same-origin group', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('User', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'initial', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    const web1 = store.createPost({ topicId: topic.id, body: 'web one', authorId: author.id });
    const webDispatch1 = store.createPostDispatch({ topicId: topic.id, postId: web1.id, sessionId: session.id });
    const external = store.createPost({ topicId: topic.id, body: 'discord', authorId: author.id });
    store.createExternalRef({
      surfaceId: 'discord:guild', surfaceKind: 'discord', externalId: 'event-1', kind: 'post',
      scope: 'thread-1', scopeKind: 'thread', mappedTopicId: topic.id, mappedPostId: external.id,
    });
    const externalDispatch = store.createPostDispatch({ topicId: topic.id, postId: external.id, sessionId: session.id });
    const web2 = store.createPost({ topicId: topic.id, body: 'web two', authorId: author.id });
    store.createPostDispatch({ topicId: topic.id, postId: web2.id, sessionId: session.id });

    expect(JSON.parse(externalDispatch.origin_json)).toMatchObject({
      originKind: 'external', channelKind: 'discord', surfaceId: 'discord:guild', scope: 'thread-1',
    });
    const claimed = store.claimPostDispatchGroup([webDispatch1]);
    expect(claimed?.contributor_post_ids_json).toBe(JSON.stringify([web1.id]));
    expect(store.getPostDispatch(externalDispatch.id)?.status).toBe('pending');
  });

  it('compacts consecutive web contributors in their original order', () => {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('User', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'initial', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    const posts = ['one', 'two'].map((body) => store.createPost({ topicId: topic.id, body, authorId: author.id }));
    const rows = posts.map((post) => store.createPostDispatch({ topicId: topic.id, postId: post.id, sessionId: session.id }));
    const claimed = store.claimPostDispatchGroup(rows);

    expect(JSON.parse(claimed!.contributor_post_ids_json)).toEqual(posts.map((post) => post.id));
    expect(store.getPostDispatch(rows[0]!.id)?.status).toBe('superseded');
    expect(store.getPostDispatch(rows[1]!.id)?.status).toBe('dispatching');
  });
});
