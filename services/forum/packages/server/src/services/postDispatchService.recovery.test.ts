import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { EchsBridge } from '../echsBridge';
import { ForumStore } from '../store';
import { PostDispatchService } from './postDispatchService';

describe('durable post dispatch recovery fence', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => db.close());

  async function processOnce(service: PostDispatchService): Promise<void> {
    (service as any).stopped = false;
    await (service as any).processDue();
  }

  function fixture() {
    const forum = store.createForum('Forum');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'initial', authorId: author.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertRobotState({ topicId: topic.id, sessionId: session.id, activity: 'thinking', model: null, reasoningEffort: null, currentPlanId: null });
    const post = store.createPost({ topicId: topic.id, authorId: author.id, body: 'work' });
    return { topic, session, post, author };
  }

  it('retries genuinely current pending human posts', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);

    expect(agent.dispatchPostToAgent).toHaveBeenCalledOnce();
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('dispatched');
  });

  it('dispatches a compaction recovery checkpoint before newer queued surface work', async () => {
    const { topic, session, author } = fixture();
    store.createCompactionOperation({
      id: 'op-priority',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: author.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover first',
    });
    const laterPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'surface work' });
    const laterDispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: laterPost.id });
    const calls: string[] = [];
    const agent = { dispatchPostToAgent: vi.fn(async (_topicId: string, postId: string) => { calls.push(postId); }) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    expect(calls).toEqual([]);
    expect(store.getPostDispatch(laterDispatch.id)?.status).toBe('pending');
    store.claimCompactionOperation('op-priority');
    const completed = store.finishCompactionSuccess('op-priority');
    await processOnce(service);
    expect(calls).toEqual([completed.recoveryPostId]);
    expect(store.getPostDispatch(laterDispatch.id)?.status).toBe('pending');
    await processOnce(service);
    expect(calls).toEqual([completed.recoveryPostId, laterPost.id]);
  });

  it('fenced rows cannot fill the due window and starve another topic', async () => {
    const blocked = fixture();
    store.createCompactionOperation({
      id: 'op-starvation',
      topicId: blocked.topic.id,
      sessionId: blocked.session.id,
      initiatedBy: blocked.author.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    for (let index = 0; index < 25; index += 1) {
      const post = store.createPost({ topicId: blocked.topic.id, authorId: blocked.author.id, body: `blocked ${index}` });
      store.createPostDispatch({ topicId: blocked.topic.id, sessionId: blocked.session.id, postId: post.id });
    }
    const ready = fixture();
    const readyDispatch = store.createPostDispatch({ topicId: ready.topic.id, sessionId: ready.session.id, postId: ready.post.id });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(ready.topic.id, ready.post.id, expect.anything());
    expect(store.getPostDispatch(readyDispatch.id)?.status).toBe('dispatched');
  });

  it('does not bypass recovery-checkpoint retry backoff through a newer due post', async () => {
    const { topic, session, author } = fixture();
    store.createCompactionOperation({
      id: 'op-backoff', topicId: topic.id, sessionId: session.id, initiatedBy: author.id,
      expectedLeafId: 'leaf-1', recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('op-backoff');
    const completed = store.finishCompactionSuccess('op-backoff');
    const checkpoint = store.getPostDispatchByPost(completed.recoveryPostId!);
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?')
      .run(new Date(Date.now() + 60_000).toISOString(), checkpoint!.id);
    const later = store.createPost({ topicId: topic.id, authorId: author.id, body: 'later' });
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: later.id });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    expect(agent.dispatchPostToAgent).not.toHaveBeenCalled();
  });

  it('never runs a stale generation after restart reconciliation', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    store.advanceTopicDispatchGeneration(topic.id, 'interrupt');
    // Simulate a stale pre-reconciliation row surviving a crash.
    db.prepare("update post_dispatches set status = 'pending' where id = ?").run(dispatch.id);
    expect(store.reconcilePostDispatchGenerations()).toBe(1);
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);

    expect(agent.dispatchPostToAgent).not.toHaveBeenCalled();
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('superseded');
  });

  it('interrupt generation advancement cancels pending work and clears robot state', () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });

    expect(store.advanceTopicDispatchGeneration(topic.id)).toMatchObject({ generation: 1, cancelled: 1 });

    expect(store.getPostDispatch(dispatch.id)?.status).toBe('superseded');
    expect(store.getRobotState(topic.id)?.activity).toBe('idle');
    expect(store.listDuePostDispatches(10)).toEqual([]);
  });

  it('uses claim CAS and prevents an old claimant from finalizing after reclamation', () => {
    const { topic, session, post } = fixture();
    const pending = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const first = store.claimPostDispatch(pending.id, pending);
    expect(first?.claim_token).toBeTruthy();
    expect(store.claimPostDispatch(pending.id, pending)).toBeNull();
    const reclaimed = store.claimPostDispatch(pending.id, first!);
    expect(reclaimed?.claim_token).toBeTruthy();
    expect(reclaimed?.claim_token).not.toBe(first?.claim_token);
    store.markPostDispatchDispatched(pending.id, first!.claim_token!);
    expect(store.getPostDispatch(pending.id)?.status).toBe('dispatching');
    store.markPostDispatchDispatched(pending.id, reclaimed!.claim_token!);
    expect(store.getPostDispatch(pending.id)?.status).toBe('dispatched');
  });

  it('lost forum response retries the same durable dispatch identity', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const calls: any[] = [];
    const agent = { dispatchPostToAgent: vi.fn(async (...args: any[]) => { calls.push(args); if (calls.length === 1) throw new Error('lost response'); }) };
    const service = new PostDispatchService(store, agent as any);
    await processOnce(service);
    db.prepare("update post_dispatches set next_attempt_at = ? where id = ?").run(new Date(0).toISOString(), dispatch.id);
    await processOnce(service);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call[2].dispatchId)).toEqual([dispatch.id, dispatch.id]);
    expect(calls.map((call) => call[2].generation)).toEqual([0, 0]);
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('dispatched');
  });

  it('cancel during an awaited bridge call prevents the old claim final transition', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const entered = Promise.withResolvers<void>();
    const agent = { dispatchPostToAgent: vi.fn(async () => { entered.resolve(); await paused; }) };
    const service = new PostDispatchService(store, agent as any);
    (service as any).stopped = false;
    const processing = (service as any).processDue();
    await entered.promise;
    store.advanceTopicDispatchGeneration(topic.id);
    release();
    await processing;
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('superseded');
  });

  it('stop waits for active dispatch and prevents later wake calls from claiming work', async () => {
    const { topic, session, post, author } = fixture();
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const entered = Promise.withResolvers<void>();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const agent = { dispatchPostToAgent: vi.fn(async () => { entered.resolve(); await blocked; }) };
    const service = new PostDispatchService(store, agent as any, { intervalMs: 60_000 });
    service.start();
    await entered.promise;
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;

    const later = store.createPost({ topicId: topic.id, authorId: author.id, body: 'later' });
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: later.id });
    service.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agent.dispatchPostToAgent).toHaveBeenCalledTimes(1);
  });

  it('a deduplicated lost-response retry settles without manufacturing a thinking turn', async () => {
    const { topic, session, post } = fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'forum-deduplicated-dispatch-'));
    try {
      db.prepare('update forums set cwd = ? where id = ?').run(cwd, topic.forum_id);
      store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
      store.setRobotActivity(topic.id, 'idle');
      const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model', workDir: cwd, echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({ conversation_id: 'conversation-1', activity: 'idle' });
      vi.spyOn((bridge as any).client, 'enqueueConversationMessage').mockResolvedValue({
        messageId: post.id,
        threadId: 'conversation-1',
        deduplicated: true,
      });
      vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});

      await bridge.dispatchPostToAgent(topic.id, post.id, { dispatchId: post.id, generation: 0 });

      expect(store.getRobotState(topic.id)?.activity).toBe('idle');
      expect(store.getSession(session.id)?.last_dispatched_post_id).toBe(post.id);
      expect((bridge as any).activeTurnThreads.size).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a delayed accepted dispatch cannot restore thinking after interrupt', async () => {
    const { topic, session } = fixture();
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const accepted = (async () => {
      await paused;
      return (bridge as any).publishAcceptedDispatchState({
        topicId: topic.id,
        sessionId: session.id,
        generation: 0,
        model: 'model',
        reasoningEffort: null,
      });
    })();

    store.advanceTopicDispatchGeneration(topic.id, 'interrupt');
    release();

    await expect(accepted).resolves.toBe(false);
    expect(store.getRobotState(topic.id)?.activity).toBe('idle');
  });
});
