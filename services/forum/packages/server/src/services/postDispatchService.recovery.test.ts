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

  it.each([
    { activity: 'thinking', expectedMode: 'queue' },
    { activity: 'idle', expectedMode: 'queue' },
  ])(
    'dispatches an auto reply with no active causal origin as $expectedMode while robot activity is $activity',
    async ({ activity, expectedMode }) => {
      const { topic, session, post } = fixture();
      store.setRobotActivity(topic.id, activity);
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
      const service = new PostDispatchService(store, agent as any);

      await processOnce(service);

      expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(
        topic.id,
        post.id,
        expect.objectContaining({ mode: expectedMode })
      );
    }
  );

  it('queues a web dispatch behind an active Discord causal turn through PostDispatchService and EchsBridge', async () => {
    const { topic, session, post, author } = fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'forum-origin-isolation-'));
    try {
      db.prepare('update forums set cwd = ? where id = ?').run(cwd, topic.forum_id);
      store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
      store.createExternalRef({
        surfaceId: 'discord:guild-1', surfaceKind: 'discord', externalId: 'discord-event-1', kind: 'post',
        scope: 'discord-thread-1', scopeKind: 'thread', mappedTopicId: topic.id, mappedPostId: post.id,
      });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model', workDir: cwd, echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((bridge as any).client, 'getConversation')
        .mockResolvedValueOnce({ conversation_id: 'conversation-1', activity: 'idle' })
        .mockResolvedValue({ conversation_id: 'conversation-1', activity: 'active' });
      vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage')
        .mockImplementation(async (_thread: string, _body: string, opts: any) => ({
          messageId: opts.dispatchId, threadId: 'conversation-1', deduplicated: false,
        }));
      const service = new PostDispatchService(store, bridge as any);

      await processOnce(service);
      const web = store.createPost({ topicId: topic.id, authorId: author.id, body: 'web follow-up' });
      const webDispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: web.id });
      await processOnce(service);

      expect(enqueue.mock.calls.map((call) => call[2]?.mode)).toEqual(['queue', 'queue']);
      expect(store.getActiveTurnOrigin(topic.id)?.origin_key).toContain('external:discord');

      // The queued web turn actually starts after the Discord turn. A restart
      // first drops the unproven old origin, then replayed turn_started binds
      // the durable web dispatch ID atomically.
      const restartedBridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model', workDir: cwd, echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((restartedBridge as any).client, 'getConversation')
        .mockResolvedValue({ conversation_id: 'conversation-1', activity: 'active' });
      vi.spyOn(restartedBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      await restartedBridge.reconcileLoadedThreads();
      expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
      (restartedBridge as any).handleEvent('conversation-1', {
        event: 'turn_started', data: { turn_id: webDispatch.id, message_id: webDispatch.id },
      });
      expect(store.getActiveTurnOrigin(topic.id)?.origin_key).toContain(`forum:web:${topic.id}`);

      const restartedEnqueue = vi.spyOn((restartedBridge as any).client, 'enqueueConversationMessage')
        .mockImplementation(async (_thread: string, _body: string, opts: any) => ({
          messageId: opts.dispatchId, threadId: 'conversation-1', deduplicated: false,
        }));
      const restartedService = new PostDispatchService(store, restartedBridge as any);
      const discord = store.createPost({ topicId: topic.id, authorId: author.id, body: 'discord follow-up' });
      store.createExternalRef({
        surfaceId: 'discord:guild-1', surfaceKind: 'discord', externalId: 'discord-event-2', kind: 'post',
        scope: 'discord-thread-1', scopeKind: 'thread', mappedTopicId: topic.id, mappedPostId: discord.id,
      });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: discord.id });
      await processOnce(restartedService);
      const sameWeb = store.createPost({ topicId: topic.id, authorId: author.id, body: 'same web origin' });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: sameWeb.id });
      await processOnce(restartedService);

      expect(restartedEnqueue.mock.calls.map((call) => call[2]?.mode)).toEqual(['queue', 'steer']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed on restart when no turn_started dispatch proof is replayed', async () => {
    const { topic, session, post, author } = fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'forum-origin-restart-'));
    try {
      db.prepare('update forums set cwd = ? where id = ?').run(cwd, topic.forum_id);
      store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      const firstBridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model', workDir: cwd, echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((firstBridge as any).client, 'getConversation').mockResolvedValue({ conversation_id: 'conversation-1', activity: 'idle' });
      vi.spyOn(firstBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      vi.spyOn((firstBridge as any).client, 'enqueueConversationMessage').mockImplementation(
        async (_thread: string, _body: string, opts: any) => ({ messageId: opts.dispatchId, threadId: 'conversation-1' })
      );
      await processOnce(new PostDispatchService(store, firstBridge as any));

      const secondPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'same web turn' });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: secondPost.id });
      const restartedBridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model', workDir: cwd, echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((restartedBridge as any).client, 'getConversation').mockResolvedValue({ conversation_id: 'conversation-1', activity: 'active' });
      vi.spyOn(restartedBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      await restartedBridge.reconcileLoadedThreads();
      const enqueue = vi.spyOn((restartedBridge as any).client, 'enqueueConversationMessage').mockResolvedValue({
        messageId: 'second-dispatch', threadId: 'conversation-1', deduplicated: false,
      });

      await processOnce(new PostDispatchService(store, restartedBridge as any));

      expect(enqueue).toHaveBeenCalledWith('conversation-1', expect.any(String), expect.objectContaining({ mode: 'queue' }));
      expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
      (restartedBridge as any).handleEvent('conversation-1', { event: 'turn_completed', data: {} });
      await vi.waitFor(() => expect(store.getActiveTurnOrigin(topic.id)).toBeNull());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the last same-origin contributor consistently as trigger and options source', async () => {
    const { topic, session, post, author } = fixture();
    const first = store.createPostDispatch({
      topicId: topic.id, sessionId: session.id, postId: post.id,
      mode: 'queue', model: 'model-first', reasoningEffort: 'low',
    });
    const secondPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'second contributor' });
    const second = store.createPostDispatch({
      topicId: topic.id, sessionId: session.id, postId: secondPost.id,
      mode: 'steer', model: 'model-trigger', reasoningEffort: 'high',
    });
    store.recordActiveTurnOrigin({
      topicId: topic.id,
      dispatchId: first.id,
      generation: first.generation,
      origin: JSON.parse(first.origin_json),
    });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    await processOnce(new PostDispatchService(store, agent as any));

    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(topic.id, secondPost.id, expect.objectContaining({
      mode: 'steer', model: 'model-trigger', reasoningEffort: 'high', dispatchId: second.id,
      contributorPostIds: [post.id, secondPost.id],
    }));
    expect(store.getPostDispatch(first.id)?.status).toBe('superseded');
    expect(store.getPostDispatch(second.id)?.status).toBe('dispatched');
  });

  it('retains the original durable contributor order when a grouped dispatch retries', async () => {
    const { topic, session, post, author } = fixture();
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const triggerPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'group trigger' });
    const trigger = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: triggerPost.id });
    const calls: unknown[][] = [];
    const agent = {
      dispatchPostToAgent: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw new Error('temporary transport failure');
      }),
    };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(new Date(0).toISOString(), trigger.id);
    await processOnce(service);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => (call[2] as { contributorPostIds: string[] }).contributorPostIds)).toEqual([
      [post.id, triggerPost.id],
      [post.id, triggerPost.id],
    ]);
    expect(store.getPostDispatch(trigger.id)?.status).toBe('dispatched');
  });

  it('does not let an earlier steer mode override a later same-origin queue trigger', async () => {
    const { topic, session, post, author } = fixture();
    store.setRobotActivity(topic.id, 'idle');
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id, mode: 'steer' });
    const secondPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'queue trigger' });
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: secondPost.id, mode: 'queue' });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    await processOnce(new PostDispatchService(store, agent as any));
    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(
      topic.id, secondPost.id, expect.objectContaining({ mode: 'queue' })
    );
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

  it.each(['stopping', 'uncertain'])('keeps human post dispatch pending and does not cross the robot boundary while %s', async (activity) => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    store.setRobotActivity(topic.id, activity);
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);
    await processOnce(service);
    expect(agent.dispatchPostToAgent).not.toHaveBeenCalled();
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('pending');
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
    store.recordActiveTurnOrigin({
      topicId: topic.id, dispatchId: dispatch.id, generation: dispatch.generation,
      origin: JSON.parse(dispatch.origin_json),
    });

    expect(store.advanceTopicDispatchGeneration(topic.id)).toMatchObject({ generation: 1, cancelled: 1 });

    expect(store.getPostDispatch(dispatch.id)?.status).toBe('superseded');
    expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
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
      vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({ conversation_id: 'conversation-1', activity: 'active' });
      vi.spyOn((bridge as any).client, 'enqueueConversationMessage').mockResolvedValue({
        messageId: post.id,
        threadId: 'conversation-1',
        deduplicated: true,
      });
      vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});

      const origin = store.resolveUtteranceOrigin(post.id);
      await bridge.dispatchPostToAgent(topic.id, post.id, { dispatchId: post.id, generation: 0, origin });

      expect(store.getRobotState(topic.id)?.activity).toBe('idle');
      expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
      expect(store.getSession(session.id)?.last_dispatched_post_id).toBe(post.id);
      expect((bridge as any).activeTurnThreads.size).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('concurrent unresolved Stop retries reuse one generation and keep posts deferred until proven stopped', async () => {
    const { topic, session, author } = fixture();
    store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    const advance = vi.spyOn(store, 'advanceTopicDispatchGeneration');
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const entered = Promise.withResolvers<void>();
    const cancel = vi.spyOn((bridge as any).client, 'interruptConversation').mockImplementation(async (_id: string, generation: number, operationId: string) => {
      entered.resolve(); await paused;
      return { ok: true, operation_id: operationId, generation, state: 'stopped', targets: 0,
        unresolved_count: 0, effects_unknown_count: 0, error_count: 0, message: 'stopped' };
    });

    const first = bridge.interruptTopic(topic.id);
    await entered.promise;
    const post = store.createPost({ topicId: topic.id, authorId: author.id, body: 'posted behind unresolved fence' });
    const deferred = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const retry = bridge.interruptTopic(topic.id);
    expect(deferred.generation).toBe(1);
    expect(advance).toHaveBeenCalledTimes(1);
    release();
    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(firstResult.operationId).toBe(retryResult.operationId);
    expect(firstResult).toMatchObject({ unresolvedCount: 0, effectsUnknownCount: 0, errorCount: 0 });
    expect(firstResult).not.toHaveProperty('unresolved');
    expect(firstResult).not.toHaveProperty('errors');
    expect(cancel.mock.calls.map((call) => call[1])).toEqual([1, 1]);
    expect(store.getRobotState(topic.id)?.activity).toBe('stopped');
    expect(store.getPostDispatch(deferred.id)?.status).toBe('pending');

    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);
    await processOnce(service);
    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(topic.id, post.id, expect.objectContaining({ generation: 1 }));
  });

  it('an older Stop response cannot overwrite a newer topic generation', async () => {
    const { topic, session } = fixture();
    store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model', workDir: '/tmp', echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const entered = Promise.withResolvers<void>();
    vi.spyOn((bridge as any).client, 'interruptConversation').mockImplementation(async (_id: string, generation: number, operationId: string) => {
      entered.resolve(); await paused;
      return { ok: true, operation_id: operationId, generation, state: 'stopped', targets: 0,
        unresolved_count: 0, effects_unknown_count: 0, error_count: 0, message: 'stopped' };
    });
    const older = bridge.interruptTopic(topic.id);
    await entered.promise;
    store.advanceTopicDispatchGeneration(topic.id, 'newer stop');
    store.setRobotActivity(topic.id, 'uncertain');
    release();
    await older;
    expect(store.getTopicDispatchGeneration(topic.id)).toBe(2);
    expect(store.getRobotState(topic.id)?.activity).toBe('uncertain');
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
  it('contains fire-and-forget selection failures and remains wakeable', async () => {
    const selection = vi
      .spyOn(store, 'listDuePostDispatches')
      .mockImplementationOnce(() => {
        throw new Error('selection unavailable');
      })
      .mockReturnValue([]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const service = new PostDispatchService(store, { dispatchPostToAgent: vi.fn() } as any, { intervalMs: 5 });

    try {
      service.start();
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('selection unavailable')));
      await vi.waitFor(() => expect(selection.mock.calls.length).toBeGreaterThanOrEqual(2));
      const callsBeforeWake = selection.mock.calls.length;
      service.wake();
      await vi.waitFor(() => expect(selection.mock.calls.length).toBeGreaterThan(callsBeforeWake));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      await service.stop();
      process.off('unhandledRejection', unhandled);
      log.mockRestore();
    }
  });

});
