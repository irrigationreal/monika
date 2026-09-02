import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { EchsBridge } from '../echsBridge';
import { EchsDispatchNotAcceptedError, EchsTransportError } from '../echsClient';
import { ForumStore } from '../store';
import { PostDispatchService, transportRetryAtForAttempt } from './postDispatchService';

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
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: null,
      reasoningEffort: null,
      currentPlanId: null,
    });
    const post = store.createPost({ topicId: topic.id, authorId: author.id, body: 'work' });
    return { topic, session, post, author };
  }

  it('does not let a newer due dispatch bypass a delayed ordered head', () => {
    const { topic, session, post, author } = fixture();
    const head = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run('9999-01-01T00:00:00.000Z', head.id);
    const newerPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'newer work' });
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: newerPost.id });

    expect(store.listDuePostDispatches(10)).toEqual([]);
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', head.id);
    expect(store.listDuePostDispatches(10).map((row) => row.id)).toEqual([head.id]);
  });

  it('uses deterministic progressive transport retry delays capped at five minutes', () => {
    const now = Date.parse('2025-01-01T00:00:00.000Z');
    expect([1, 2, 3, 4, 99].map((attempt) => Date.parse(transportRetryAtForAttempt(attempt, now)) - now)).toEqual([
      30_000, 60_000, 120_000, 300_000, 300_000,
    ]);
  });

  it('records immutable claim and terminal attempt events', () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const claimed = store.claimPostDispatch(dispatch.id, dispatch)!;
    store.markPostDispatchFailed(dispatch.id, claimed.claim_token!, 'network reset', {
      retryAt: '2030-01-01T00:00:00.000Z',
      classification: 'transport',
    });
    const before = store.listPostDispatchAttempts([dispatch.id]);
    expect(before.map((attempt) => attempt.event)).toEqual(['retry_scheduled', 'claimed']);
    db.prepare("update post_dispatches set error_message = 'new mutable error'").run();
    expect(store.listPostDispatchAttempts([dispatch.id])).toEqual(before);
  });

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
      store.upsertPiSessionLink({
        piSessionId: 'pi-1',
        piSessionPath: '/tmp/pi-1.jsonl',
        topicId: topic.id,
        sessionId: session.id,
      });
      store.createExternalRef({
        surfaceId: 'discord:guild-1',
        surfaceKind: 'discord',
        externalId: 'discord-event-1',
        kind: 'post',
        scope: 'discord-thread-1',
        scopeKind: 'thread',
        mappedTopicId: topic.id,
        mappedPostId: post.id,
      });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model',
        workDir: cwd,
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((bridge as any).client, 'getConversation')
        .mockResolvedValueOnce({ conversation_id: 'conversation-1', activity: 'idle' })
        .mockResolvedValue({ conversation_id: 'conversation-1', activity: 'active' });
      vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      const enqueue = vi
        .spyOn((bridge as any).client, 'enqueueConversationMessage')
        .mockImplementation(async (_thread: string, _body: string, opts: any) => ({
          messageId: opts.dispatchId,
          threadId: 'conversation-1',
          deduplicated: false,
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
        model: 'model',
        workDir: cwd,
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((restartedBridge as any).client, 'getConversation').mockResolvedValue({
        conversation_id: 'conversation-1',
        activity: 'active',
      });
      vi.spyOn(restartedBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      await restartedBridge.reconcileLoadedThreads();
      expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
      (restartedBridge as any).handleEvent('conversation-1', {
        event: 'turn_started',
        data: { turn_id: webDispatch.id, message_id: webDispatch.id },
      });
      expect(store.getActiveTurnOrigin(topic.id)?.origin_key).toContain(`forum:web:${topic.id}`);

      const restartedEnqueue = vi
        .spyOn((restartedBridge as any).client, 'enqueueConversationMessage')
        .mockImplementation(async (_thread: string, _body: string, opts: any) => ({
          messageId: opts.dispatchId,
          threadId: 'conversation-1',
          deduplicated: false,
        }));
      const restartedService = new PostDispatchService(store, restartedBridge as any);
      const discord = store.createPost({ topicId: topic.id, authorId: author.id, body: 'discord follow-up' });
      store.createExternalRef({
        surfaceId: 'discord:guild-1',
        surfaceKind: 'discord',
        externalId: 'discord-event-2',
        kind: 'post',
        scope: 'discord-thread-1',
        scopeKind: 'thread',
        mappedTopicId: topic.id,
        mappedPostId: discord.id,
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
      store.upsertPiSessionLink({
        piSessionId: 'pi-1',
        piSessionPath: '/tmp/pi-1.jsonl',
        topicId: topic.id,
        sessionId: session.id,
      });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      const firstBridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model',
        workDir: cwd,
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((firstBridge as any).client, 'getConversation').mockResolvedValue({
        conversation_id: 'conversation-1',
        activity: 'idle',
      });
      vi.spyOn(firstBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      vi.spyOn((firstBridge as any).client, 'enqueueConversationMessage').mockImplementation(
        async (_thread: string, _body: string, opts: any) => ({
          messageId: opts.dispatchId,
          threadId: 'conversation-1',
        })
      );
      await processOnce(new PostDispatchService(store, firstBridge as any));

      const secondPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'same web turn' });
      store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: secondPost.id });
      const restartedBridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model',
        workDir: cwd,
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((restartedBridge as any).client, 'getConversation').mockResolvedValue({
        conversation_id: 'conversation-1',
        activity: 'active',
      });
      vi.spyOn(restartedBridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
      await restartedBridge.reconcileLoadedThreads();
      const enqueue = vi.spyOn((restartedBridge as any).client, 'enqueueConversationMessage').mockResolvedValue({
        messageId: 'second-dispatch',
        threadId: 'conversation-1',
        deduplicated: false,
      });

      await processOnce(new PostDispatchService(store, restartedBridge as any));

      expect(enqueue).toHaveBeenCalledWith(
        'conversation-1',
        expect.any(String),
        expect.objectContaining({ mode: 'queue' })
      );
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
      topicId: topic.id,
      sessionId: session.id,
      postId: post.id,
      mode: 'queue',
      model: 'model-first',
      reasoningEffort: 'low',
    });
    const secondPost = store.createPost({ topicId: topic.id, authorId: author.id, body: 'second contributor' });
    const second = store.createPostDispatch({
      topicId: topic.id,
      sessionId: session.id,
      postId: secondPost.id,
      mode: 'steer',
      model: 'model-trigger',
      reasoningEffort: 'high',
    });
    store.recordActiveTurnOrigin({
      topicId: topic.id,
      dispatchId: first.id,
      generation: first.generation,
      origin: JSON.parse(first.origin_json),
    });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    await processOnce(new PostDispatchService(store, agent as any));

    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(
      topic.id,
      secondPost.id,
      expect.objectContaining({
        mode: 'steer',
        model: 'model-trigger',
        reasoningEffort: 'high',
        dispatchId: second.id,
        contributorPostIds: [post.id, secondPost.id],
      })
    );
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
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
      new Date(0).toISOString(),
      trigger.id
    );
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
      topic.id,
      secondPost.id,
      expect.objectContaining({ mode: 'queue' })
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
    const agent = {
      dispatchPostToAgent: vi.fn(async (_topicId: string, postId: string) => {
        calls.push(postId);
      }),
    };
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
      const post = store.createPost({
        topicId: blocked.topic.id,
        authorId: blocked.author.id,
        body: `blocked ${index}`,
      });
      store.createPostDispatch({ topicId: blocked.topic.id, sessionId: blocked.session.id, postId: post.id });
    }
    const ready = fixture();
    const readyDispatch = store.createPostDispatch({
      topicId: ready.topic.id,
      sessionId: ready.session.id,
      postId: ready.post.id,
    });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(ready.topic.id, ready.post.id, expect.anything());
    expect(store.getPostDispatch(readyDispatch.id)?.status).toBe('dispatched');
  });

  it('does not bypass recovery-checkpoint retry backoff through a newer due post', async () => {
    const { topic, session, author } = fixture();
    store.createCompactionOperation({
      id: 'op-backoff',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: author.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('op-backoff');
    const completed = store.finishCompactionSuccess('op-backoff');
    const checkpoint = store.getPostDispatchByPost(completed.recoveryPostId!);
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
      new Date(Date.now() + 60_000).toISOString(),
      checkpoint!.id
    );
    const later = store.createPost({ topicId: topic.id, authorId: author.id, body: 'later' });
    store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: later.id });
    const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    expect(agent.dispatchPostToAgent).not.toHaveBeenCalled();
  });

  it.each(['stopping', 'uncertain'])(
    'keeps human post dispatch pending and does not cross the robot boundary while %s',
    async (activity) => {
      const { topic, session, post } = fixture();
      const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
      store.setRobotActivity(topic.id, activity);
      const agent = { dispatchPostToAgent: vi.fn(async () => {}) };
      const service = new PostDispatchService(store, agent as any);
      await processOnce(service);
      expect(agent.dispatchPostToAgent).not.toHaveBeenCalled();
      expect(store.getPostDispatch(dispatch.id)?.status).toBe('pending');
    }
  );

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
      topicId: topic.id,
      dispatchId: dispatch.id,
      generation: dispatch.generation,
      origin: JSON.parse(dispatch.origin_json),
    });

    expect(store.advanceTopicDispatchGeneration(topic.id)).toMatchObject({ generation: 1, cancelled: 1 });

    expect(store.getPostDispatch(dispatch.id)?.status).toBe('superseded');
    expect(store.getActiveTurnOrigin(topic.id)).toBeNull();
    expect(store.getRobotState(topic.id)?.activity).toBe('idle');
    expect(store.listDuePostDispatches(10)).toEqual([]);
  });

  it('does not let late abandonment overwrite a newer cancellation generation', () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    store.advanceTopicDispatchGeneration(topic.id, 'cancelled');

    expect(store.markPostDispatchAbandoned(dispatch.id, 'late lifecycle observation')?.status).toBe('superseded');
    expect(store.listPostDispatchAttempts([dispatch.id]).map((attempt) => attempt.event)).toEqual(['superseded']);
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

  it('allows canonical creation only for the sole current dispatch with no prior canonical evidence', () => {
    const { topic, session, post } = fixture();
    const current = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    expect(store.isPristineConversationCreation(topic.id, current.id)).toBe(true);

    const laterPost = store.createPost({ topicId: topic.id, authorId: post.author_id, body: 'later' });
    const later = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: laterPost.id });
    expect(store.isPristineConversationCreation(topic.id, later.id)).toBe(false);
    store.markPostDispatchSuperseded(current.id);
    store.createPiMessageLink({ piSessionId: 'lost-pi', piMessageId: 'message-1', postId: post.id });
    expect(store.isPristineConversationCreation(topic.id, later.id)).toBe(false);
  });

  it('does not authorize fresh creation after a lost create response and generation advance', () => {
    const { topic, session, post } = fixture();
    const ambiguous = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    expect(store.isPristineConversationCreation(topic.id, ambiguous.id)).toBe(true);

    store.advanceTopicDispatchGeneration(topic.id);
    expect(store.getPostDispatch(ambiguous.id)?.status).toBe('superseded');
    expect(store.isPristineConversationCreation(topic.id, ambiguous.id)).toBe(true);
    const retryPost = store.createPost({
      topicId: topic.id,
      authorId: post.author_id,
      body: 'retry after lost response',
    });
    const later = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: retryPost.id });

    expect(later.generation).toBeGreaterThan(ambiguous.generation);
    expect(store.isPristineConversationCreation(topic.id, later.id)).toBe(false);
    // The exact ambiguous dispatch identity remains the only identity that was
    // ever eligible for the agentd creation ledger.
    expect(store.isPristineConversationCreation(topic.id, ambiguous.id)).toBe(false);
  });

  it('fails closed when accepted history has lost its canonical session link', async () => {
    const { topic, session, post } = fixture();
    store.setSessionLastDispatchedPostId(session.id, post.id);
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const create = vi.spyOn((bridge as any).client, 'createConversation');

    await expect(
      bridge.dispatchPostToAgent(topic.id, post.id, {
        dispatchId: 'dispatch',
        generation: 0,
        contributorPostIds: [post.id],
        origin: store.resolveUtteranceOrigin(post.id),
      })
    ).rejects.toThrow(/canonical_session_link_missing/);
    expect(create).not.toHaveBeenCalled();
    expect(store.getPiSessionLinkByTopic(topic.id)).toBeNull();
  });

  it('fails closed on an authoritatively missing linked session instead of inventing a replacement', async () => {
    const { topic, session, post } = fixture();
    store.upsertPiSessionLink({
      piSessionId: 'missing-pi',
      piSessionPath: '/tmp/missing-pi.jsonl',
      topicId: topic.id,
      sessionId: session.id,
      cwd: '/tmp',
      kind: 'normal',
      metadata: { source: 'forum-created' },
    });
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    const open = vi
      .spyOn((bridge as any).client, 'openConversation')
      .mockRejectedValue(new Error('ECHS 404: not_found'));
    const create = vi.spyOn((bridge as any).client, 'createConversation');

    await expect(
      bridge.dispatchPostToAgent(topic.id, post.id, {
        dispatchId: 'dispatch',
        generation: 0,
        contributorPostIds: [post.id],
        origin: store.resolveUtteranceOrigin(post.id),
      })
    ).rejects.toThrow(/404/);
    expect(open).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(store.getPiSessionLinkByTopic(topic.id)?.pi_session_id).toBe('missing-pi');
  });

  it('rethrows a typed not-accepted 404 before conversation recovery', async () => {
    const { topic, session, post } = fixture();
    store.upsertPiSessionLink({
      piSessionId: 'pi-linked',
      piSessionPath: '/tmp/pi-linked.jsonl',
      topicId: topic.id,
      sessionId: session.id,
      cwd: '/tmp',
      kind: 'normal',
      metadata: { source: 'forum-created' },
    });
    store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
    vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({
      conversation_id: 'conversation-1',
      session_id: 'pi-linked',
      session_path: '/tmp/pi-linked.jsonl',
      activity: 'idle',
      cwd: '/tmp',
    });
    const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage').mockRejectedValue(
      new EchsDispatchNotAcceptedError('ECHS 404: package initialization failed', 404, {
        dispatch_acceptance: 'not_accepted',
      })
    );
    const open = vi.spyOn((bridge as any).client, 'openConversation');
    const create = vi.spyOn((bridge as any).client, 'createConversation');

    await expect(
      bridge.dispatchPostToAgent(topic.id, post.id, {
        dispatchId: 'dispatch-typed-404',
        generation: 0,
        contributorPostIds: [post.id],
        origin: store.resolveUtteranceOrigin(post.id),
      })
    ).rejects.toBeInstanceOf(EchsDispatchNotAcceptedError);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps an agentd transport outage pending beyond the ordinary attempt budget and resumes exact identity', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const calls: any[] = [];
    let unavailable = true;
    const agent = {
      dispatchPostToAgent: vi.fn(async (...args: any[]) => {
        calls.push(args);
        if (unavailable) throw new EchsTransportError('offline');
      }),
    };
    const service = new PostDispatchService(store, agent as any);

    for (let index = 0; index < 7; index += 1) {
      await processOnce(service);
      const current = store.getPostDispatch(dispatch.id)!;
      expect(current.status).toBe('pending');
      db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
        new Date(0).toISOString(),
        dispatch.id
      );
    }
    unavailable = false;
    await processOnce(service);

    expect(store.getPostDispatch(dispatch.id)?.status).toBe('dispatched');
    expect(calls).toHaveLength(8);
    expect(
      calls.every((call) => call[2].dispatchId === dispatch.id && call[2].generation === dispatch.generation)
    ).toBe(true);
  });

  it('retries explicitly safe pre-acceptance draining failures indefinitely as lifecycle work', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const agent = {
      dispatchPostToAgent: vi.fn(async () => {
        throw new EchsDispatchNotAcceptedError(
          'ECHS 503: draining',
          503,
          { dispatch_acceptance: 'not_accepted', dispatch_retry: 'safe' },
          true
        );
      }),
    };
    const service = new PostDispatchService(store, agent as any);

    for (let index = 0; index < 7; index += 1) {
      await processOnce(service);
      expect(store.getPostDispatch(dispatch.id)).toMatchObject({ status: 'pending' });
      db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
        new Date(0).toISOString(),
        dispatch.id
      );
    }
    expect(agent.dispatchPostToAgent).toHaveBeenCalledTimes(7);
    expect(store.listPostDispatchAttempts([dispatch.id])).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'retry_scheduled', classification: 'lifecycle' })])
    );
  });

  it('makes a marked pre-acceptance failure terminal lifecycle work without deleting the post', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const agent = {
      dispatchPostToAgent: vi.fn(async () => {
        throw new EchsDispatchNotAcceptedError('ECHS 500: initialization failed', 500, {
          dispatch_acceptance: 'not_accepted',
        });
      }),
    };
    const service = new PostDispatchService(store, agent as any);

    await processOnce(service);
    await processOnce(service);

    expect(agent.dispatchPostToAgent).toHaveBeenCalledOnce();
    expect(store.getPost(post.id)).not.toBeNull();
    expect(store.getPostDispatch(dispatch.id)).toMatchObject({
      status: 'failed',
      next_attempt_at: null,
    });
    expect(store.listPostDispatchAttempts([dispatch.id])).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'terminal_failure', classification: 'lifecycle' })])
    );

    expect(store.retryTerminalPostDispatch(dispatch.id)?.status).toBe('pending');
  });

  it('keeps definite application failures terminal after the ordinary attempt budget', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const service = new PostDispatchService(store, {
      dispatchPostToAgent: vi.fn(async () => {
        throw new Error('ECHS 409: conflict');
      }),
    } as any);
    for (let index = 0; index < 5; index += 1) {
      await processOnce(service);
      db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
        new Date(0).toISOString(),
        dispatch.id
      );
    }
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('failed');
  });

  it('keeps lifetime audit attempt numbers monotonic across manual terminal retry', () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const first = store.claimPostDispatch(dispatch.id, dispatch)!;
    store.markPostDispatchFailed(dispatch.id, first.claim_token!, 'terminal');
    store.retryTerminalPostDispatch(dispatch.id);
    const second = store.claimPostDispatch(dispatch.id, store.getPostDispatch(dispatch.id)!)!;

    expect(
      store
        .listPostDispatchAttempts([dispatch.id])
        .filter((attempt) => attempt.event === 'claimed')
        .map((attempt) => attempt.attempt_number)
        .sort()
    ).toEqual([1, 2]);
    expect(second.attempt_count).toBe(1);
  });

  it('manual terminal retry cannot resurrect superseded or abandoned work', () => {
    const first = fixture();
    const superseded = store.createPostDispatch({
      topicId: first.topic.id,
      sessionId: first.session.id,
      postId: first.post.id,
    });
    store.advanceTopicDispatchGeneration(first.topic.id);
    expect(store.retryTerminalPostDispatch(superseded.id)).toBeNull();

    const second = fixture();
    const abandoned = store.createPostDispatch({
      topicId: second.topic.id,
      sessionId: second.session.id,
      postId: second.post.id,
    });
    store.markPostDispatchAbandoned(abandoned.id, 'deleted');
    expect(store.retryTerminalPostDispatch(abandoned.id)).toBeNull();
  });

  it('lost forum response retries the same durable dispatch identity', async () => {
    const { topic, session, post } = fixture();
    const dispatch = store.createPostDispatch({ topicId: topic.id, sessionId: session.id, postId: post.id });
    const calls: any[] = [];
    const agent = {
      dispatchPostToAgent: vi.fn(async (...args: any[]) => {
        calls.push(args);
        if (calls.length === 1) throw new Error('lost response');
      }),
    };
    const service = new PostDispatchService(store, agent as any);
    await processOnce(service);
    db.prepare('update post_dispatches set next_attempt_at = ? where id = ?').run(
      new Date(0).toISOString(),
      dispatch.id
    );
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
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = Promise.withResolvers<void>();
    const agent = {
      dispatchPostToAgent: vi.fn(async () => {
        entered.resolve();
        await paused;
      }),
    };
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
    const agent = {
      dispatchPostToAgent: vi.fn(async () => {
        entered.resolve();
        await blocked;
      }),
    };
    const service = new PostDispatchService(store, agent as any, { intervalMs: 60_000 });
    service.start();
    await entered.promise;
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
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
      store.upsertPiSessionLink({
        piSessionId: 'pi-1',
        piSessionPath: '/tmp/pi-1.jsonl',
        topicId: topic.id,
        sessionId: session.id,
      });
      store.setRobotActivity(topic.id, 'idle');
      const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'model',
        workDir: cwd,
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({
        conversation_id: 'conversation-1',
        activity: 'active',
      });
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
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    const advance = vi.spyOn(store, 'advanceTopicDispatchGeneration');
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = Promise.withResolvers<void>();
    const cancel = vi
      .spyOn((bridge as any).client, 'interruptConversation')
      .mockImplementation(async (_id: string, generation: number, operationId: string) => {
        entered.resolve();
        await paused;
        return {
          ok: true,
          operation_id: operationId,
          generation,
          state: 'stopped',
          targets: 0,
          unresolved_count: 0,
          effects_unknown_count: 0,
          error_count: 0,
          message: 'stopped',
        };
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
    expect(agent.dispatchPostToAgent).toHaveBeenCalledWith(
      topic.id,
      post.id,
      expect.objectContaining({ generation: 1 })
    );
  });

  it('an older Stop response cannot overwrite a newer topic generation', async () => {
    const { topic, session } = fixture();
    store.setSessionAgentThread(session.id, 'echs', 'conversation-1');
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'emitState').mockImplementation(() => {});
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = Promise.withResolvers<void>();
    vi.spyOn((bridge as any).client, 'interruptConversation').mockImplementation(
      async (_id: string, generation: number, operationId: string) => {
        entered.resolve();
        await paused;
        return {
          ok: true,
          operation_id: operationId,
          generation,
          state: 'stopped',
          targets: 0,
          unresolved_count: 0,
          effects_unknown_count: 0,
          error_count: 0,
          message: 'stopped',
        };
      }
    );
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
      model: 'model',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
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
