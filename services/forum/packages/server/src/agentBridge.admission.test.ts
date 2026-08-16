import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBridge } from './agentBridge';
import { migrate } from './db';
import { ForumStore } from './store';

interface TrackedBackend {
  generateHandoffDraft: ReturnType<typeof vi.fn>;
  createLinkedHandoffConversation: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  steerUserMessage: ReturnType<typeof vi.fn>;
  dispatchPostToAgent: ReturnType<typeof vi.fn>;
  forkTopicConversation: ReturnType<typeof vi.fn>;
  acknowledgeFork: ReturnType<typeof vi.fn>;
  compactTopicConversation: ReturnType<typeof vi.fn>;
}

describe('AgentBridge deployment admission tracking', () => {
  let db: Database.Database;
  let store: ForumStore;
  let bridge: AgentBridge;
  let backend: TrackedBackend;
  let topicId: string;
  let postId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'author', 'human');
    const created = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'Opening', authorId: author.id });
    topicId = created.topic.id;
    postId = created.post.id;
    bridge = new AgentBridge(store, { emit: vi.fn() } as never, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://127.0.0.1:1' },
    });
    backend = (bridge as unknown as { echs: TrackedBackend }).echs;
    backend.generateHandoffDraft = vi.fn(async () => ({ goal: 'goal', draft: 'draft' }));
    backend.createLinkedHandoffConversation = vi.fn(async () => ({}));
    backend.sendUserMessage = vi.fn(async () => undefined);
    backend.steerUserMessage = vi.fn(async () => undefined);
    backend.dispatchPostToAgent = vi.fn(async () => undefined);
    backend.forkTopicConversation = vi.fn(async () => ({
      child_session_id: 'child',
      child_session_path: '/tmp/child.jsonl',
      inherited_generation: 1,
      active_entry_ids: [],
    }));
    backend.acknowledgeFork = vi.fn(async () => undefined);
    backend.compactTopicConversation = vi.fn(async () => ({}));
  });

  afterEach(() => db.close());

  it('holds admission around every direct async robot mutation/work path', async () => {
    const release = vi.fn();
    const begin = vi.spyOn(store, 'beginRobotWork').mockImplementation(() => release);

    await bridge.generateHandoffDraft(topicId, { goal: 'goal' });
    await bridge.createLinkedHandoffConversation(topicId, { cwd: '/tmp' });
    await bridge.sendUserMessage(topicId, 'send', postId);
    await bridge.steerUserMessage(topicId, 'steer', postId);
    await bridge.dispatchPostToAgent(topicId, postId);
    await bridge.forkTopicConversation(topicId, {
      operationId: 'fork',
      expectedLeafId: 'leaf',
      boundaryEntryId: 'entry',
    });
    await bridge.acknowledgeFork('fork', 'child');
    await bridge.compactTopicConversation(topicId, { operationId: 'compact', expectedLeafId: 'leaf' });

    expect(begin).toHaveBeenCalledTimes(8);
    expect(release).toHaveBeenCalledTimes(8);
  });

  it('does not release a delayed operation until its await settles', async () => {
    let resolveLinked!: () => void;
    backend.createLinkedHandoffConversation = vi.fn(() => new Promise<void>((resolve) => (resolveLinked = resolve)));
    const release = vi.fn();
    vi.spyOn(store, 'beginRobotWork').mockImplementation(() => release);

    const operation = bridge.createLinkedHandoffConversation(topicId, { cwd: '/tmp' });
    expect(release).not.toHaveBeenCalled();
    resolveLinked();
    await operation;
    expect(release).toHaveBeenCalledOnce();
  });
});
