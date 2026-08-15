import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { AutoRunDirector } from './autoRunDirector';

import type { StreamBusInterface } from '../streamBus';

describe('AutoRunDirector attachment context', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  it('excludes detached attachment tombstones from the director prompt', () => {
    const author = store.createIdentityWithPassword('Author', 'auto-run-author', 'hash', 'human');
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'body',
      authorId: author.id,
    });
    const attachment = store.createAttachment({
      postId: post.id,
      filename: 'deleted-secret.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storagePath: '/tmp/deleted-secret.txt',
      ownerIdentityId: author.id,
      sha256: 'deleted-secret',
    });
    store.deleteAttachment(attachment.id, 'removed_by_owner');
    store.upsertTopicAutoRun({ topicId: topic.id, enabled: true, context: 'Continue' });
    const autoRun = store.getTopicAutoRun(topic.id)!;
    const director = new AutoRunDirector(store, { emit: vi.fn() } as unknown as StreamBusInterface, {
      workDir: '/tmp',
      defaultWorker: 'echs',
    });
    const prompt = (
      director as unknown as {
        buildPrompt: (input: { topicId: string; autoRun: typeof autoRun }) => string;
      }
    ).buildPrompt({ topicId: topic.id, autoRun });

    expect(prompt).not.toContain('deleted-secret.txt');
    expect(prompt).not.toContain(attachment.id);
  });
});
