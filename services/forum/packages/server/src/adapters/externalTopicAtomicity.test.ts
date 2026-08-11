import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { DiscordBridge } from './discordBridge';
import { MatrixBridge } from './matrixBridge';

describe('external topic first-post atomicity', () => {
  let db: Database.Database;
  let store: ForumStore;
  let forumId: string;
  const bus = { emit: vi.fn(), subscribe: vi.fn(() => () => {}) } as any;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    forumId = store.createForum('External').id;
  });

  afterEach(() => db.close());

  function expectCompleteFirstDispatch(surfaceId: string, surfaceKind: string, externalId: string): void {
    const ref = store.getExternalRefByExternal(surfaceId, surfaceKind, externalId);
    expect(ref?.mapped_topic_id).toBeTruthy();
    const topicId = ref!.mapped_topic_id!;
    expect(db.prepare('select count(*) as count from topics where id = ?').get(topicId)).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from sessions where topic_id = ?').get(topicId)).toEqual({ count: 1 });
    expect(db.prepare(`select count(*) as count from session_messages sm
      join sessions s on s.id = sm.session_id where s.topic_id = ? and sm.role = 'user'`).get(topicId)).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from post_dispatches where topic_id = ?').get(topicId)).toEqual({ count: 1 });
  }

  it('rolls back and safely retries Discord topic publication after dispatch creation crashes', async () => {
    const surfaceId = 'discord:guild-1';
    store.createExternalRef({
      surfaceId, surfaceKind: 'discord', externalId: 'channel-1', kind: 'forum', mappedForumId: forumId,
    });
    const bridge = new DiscordBridge(store, bus, { token: 'token', guildId: 'guild-1' }, {} as any);
    vi.spyOn(store, 'createPostDispatch').mockImplementationOnce(() => { throw new Error('simulated crash'); });
    const event = {
      surfaceId,
      payload: {
        type: 'topic.created', threadId: 'thread-1', channelId: 'channel-1', authorId: 'discord-user',
        title: 'Atomic Discord', body: 'first Discord message',
      },
      metadata: { authorDisplayName: 'Discord Human' },
    } as any;

    await (bridge as any).handleThreadCreate(event);
    expect(store.getExternalRefByExternal(surfaceId, 'discord', 'thread-1')).toBeNull();
    expect(db.prepare("select count(*) as count from topics where title = 'Atomic Discord'").get()).toEqual({ count: 0 });

    await (bridge as any).handleThreadCreate(event);
    expectCompleteFirstDispatch(surfaceId, 'discord', 'thread-1');
  });

  it('rolls back and safely retries Matrix topic publication after dispatch creation crashes', async () => {
    const surfaceId = 'matrix:monika';
    store.createExternalRef({
      surfaceId, surfaceKind: 'matrix', externalId: '!room:example', kind: 'forum', mappedForumId: forumId,
    });
    const bridge = new MatrixBridge(store, bus, {
      homeserverUrl: 'https://matrix.example', accessToken: 'token', userId: '@monika:example',
    }, {} as any);
    vi.spyOn(store, 'createPostDispatch').mockImplementationOnce(() => { throw new Error('simulated crash'); });
    const event = {
      surfaceId,
      payload: {
        type: 'post.created', roomId: '!room:example', eventId: '$event-1', authorId: '@human:example',
        body: 'Atomic Matrix topic',
      },
      metadata: { authorDisplayName: 'Matrix Human' },
    } as any;

    await (bridge as any).handleMessageCreate(event);
    expect(store.getExternalRefByExternal(surfaceId, 'matrix', '$event-1')).toBeNull();
    expect(db.prepare("select count(*) as count from topics where title = 'Atomic Matrix topic'").get()).toEqual({ count: 0 });

    await (bridge as any).handleMessageCreate(event);
    expectCompleteFirstDispatch(surfaceId, 'matrix', '$event-1');
  });
});
