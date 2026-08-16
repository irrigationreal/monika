import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './db';
import { EchsBridge } from './echsBridge';
import { ForumStore } from './store';

describe('ECHS canonical utterance projection', () => {
  let db: Database.Database;
  let store: ForumStore;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });
  afterEach(() => db.close());

  it('preserves grouped contributor provenance through the queued turn sent to agentd', async () => {
    const forum = store.createForum('Forum');
    const human = store.createIdentity('Author', 'human');
    store.createIdentity('Monika', 'robot');
    const { topic, post: first } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'First',
      authorId: human.id,
    });
    const trigger = store.createPost({ topicId: topic.id, authorId: human.id, body: 'Trigger' });
    const activeAttachment = store.createAttachment({
      postId: trigger.id,
      filename: 'active.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: '/tmp/active.txt',
    });
    const deletedAttachment = store.createAttachment({
      postId: trigger.id,
      filename: 'deleted.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: '/tmp/deleted.txt',
    });
    store.deleteAttachment(deletedAttachment.id, 'removed');
    const session = store.ensureSession({ topicId: topic.id });
    store.setSessionAgentThread(session.id, 'echs', 'conversation');
    store.upsertPiSessionLink({
      piSessionId: 'pi-parent',
      piSessionPath: '/tmp/parent.jsonl',
      topicId: topic.id,
      sessionId: session.id,
    });
    const origin = {
      utteranceId: trigger.id,
      originKind: 'forum' as const,
      channelKind: 'forum',
      topicId: topic.id,
      postId: trigger.id,
      surfaceId: topic.id,
      externalEventId: null,
      scope: topic.id,
      scopeKind: 'thread',
    };
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn((bridge as any).client, 'getConversation').mockResolvedValue({ conversation_id: 'conversation' });
    vi.spyOn(bridge as any, 'ensureSubscribed').mockResolvedValue(undefined);
    const enqueue = vi.spyOn((bridge as any).client, 'enqueueConversationMessage').mockResolvedValue({
      messageId: 'dispatch',
      threadId: 'thread',
      deduplicated: false,
    });

    await bridge.dispatchPostToAgent(topic.id, trigger.id, {
      dispatchId: 'dispatch',
      generation: 0,
      contributorPostIds: [first.id, trigger.id],
      origin,
    });

    expect(enqueue).toHaveBeenCalledWith(
      'conversation',
      expect.any(String),
      expect.objectContaining({
        provenance: {
          origin: 'forum',
          topicId: topic.id,
          postId: trigger.id,
          version: 2,
          utteranceIds: [first.id, trigger.id],
          executionOrigins: [origin],
        },
      })
    );
    const envelope = enqueue.mock.calls[0]?.[1] as string;
    expect(envelope).toContain(activeAttachment.id);
    expect(envelope).not.toContain(deletedAttachment.id);
    expect(envelope).not.toContain('deleted.txt');
  });

  it('cancels the delayed completion backfill when stopped before its timer fires', async () => {
    vi.useFakeTimers();
    try {
      const forum = store.createForum('Forum');
      const human = store.createIdentity('Author', 'human');
      const { topic, post } = store.createTopic({
        forumId: forum.id,
        title: 'Topic',
        body: 'Work',
        authorId: human.id,
      });
      const session = store.ensureSession({ topicId: topic.id });
      store.upsertRobotState({
        topicId: topic.id,
        sessionId: session.id,
        activity: 'thinking',
        model: 'm',
        reasoningEffort: null,
        currentPlanId: null,
      });
      const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
        model: 'm',
        workDir: '/tmp',
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      const backfill = vi.spyOn(bridge as any, 'ensureAssistantBackfill').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'forceReasoningBackfill').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'emitContext').mockResolvedValue(undefined);
      (bridge as any).threadMap.set('conversation', {
        topicId: topic.id,
        sessionId: session.id,
        activeThreadId: 'thread',
        lastUserPostId: post.id,
        turnParentPostId: post.id,
        planId: null,
        reasoningSummary: '',
        reasoningBackfillAttempted: false,
        reasoningBackfillRetries: 0,
        model: 'm',
        reasoningEffort: null,
        currentTurnId: 'turn',
        turnStartedAt: Date.now(),
        lastUsage: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        activeSubagents: new Map(),
        lastStreamEventAt: null,
        reasoningCheckpoints: [],
      });

      (bridge as any).handleEvent('conversation', { event: 'turn_completed', data: {} });
      await Promise.resolve();
      expect((bridge as any).assistantBackfillTimers.size).toBe(1);
      await bridge.stop();
      expect((bridge as any).assistantBackfillTimers.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(backfill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes multiple canonical items before turn idle and freezes continuation per item', async () => {
    const forum = store.createForum('Forum');
    const human = store.createIdentity('Author', 'human');
    store.createIdentity('Monika', 'robot');
    const { topic, post: origin } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'Start work',
      authorId: human.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-parent',
      piSessionPath: '/tmp/parent.jsonl',
      topicId: topic.id,
      sessionId: session.id,
    });
    store.upsertRobotState({
      topicId: topic.id,
      sessionId: session.id,
      activity: 'thinking',
      model: 'm',
      reasoningEffort: null,
      currentPlanId: null,
    });
    const bus = { emit: vi.fn(), subscribe: vi.fn() };
    const bridge = new EchsBridge(store, bus as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn(bridge as any, 'syncReasoningFromHistory').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'forceReasoningBackfill').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'ensureAssistantBackfill').mockResolvedValue(undefined);
    vi.spyOn(bridge as any, 'emitContext').mockResolvedValue(undefined);
    (bridge as any).threadMap.set('conversation', {
      topicId: topic.id,
      sessionId: session.id,
      activeThreadId: 'thread',
      lastUserPostId: origin.id,
      turnParentPostId: origin.id,
      planId: null,
      reasoningSummary: '',
      reasoningBackfillAttempted: false,
      reasoningBackfillRetries: 0,
      model: 'm',
      reasoningEffort: null,
      currentTurnId: 'turn',
      turnStartedAt: Date.now(),
      lastUsage: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      activeSubagents: new Map(),
      lastStreamEventAt: null,
      reasoningCheckpoints: [],
    });

    (bridge as any).handleEvent('conversation', {
      event: 'item_completed',
      data: {
        item: {
          id: 'pi-a',
          pi_message_id: 'pi-a',
          utterance_id: 'pi-a',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Ordinary answer' }],
        },
      },
    });
    (bridge as any).handleEvent('conversation', {
      event: 'item_completed',
      data: {
        item: {
          id: 'pi-b',
          pi_message_id: 'pi-b',
          utterance_id: 'pi-b',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Background answer' }],
          source_kind: 'subagent-completion',
          subagent_run_id: 'run-1',
          origin_post_id: origin.id,
          origin_topic_id: topic.id,
        },
      },
    });
    const attachmentPath = `/tmp/forum-utterance-${randomUUID()}.txt`;
    const attachmentBytes = Buffer.from('canonical attachment');
    writeFileSync(attachmentPath, attachmentBytes);
    const pending = store.createPendingAttachment({
      topicId: topic.id,
      filename: 'canonical.txt',
      mimeType: 'text/plain',
      sizeBytes: attachmentBytes.length,
      storagePath: attachmentPath,
      sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const legacyPath = `/tmp/forum-utterance-${randomUUID()}.legacy.txt`;
    writeFileSync(legacyPath, attachmentBytes);
    const legacyPending = store.createPendingAttachment({
      topicId: topic.id,
      filename: 'legacy.txt',
      mimeType: 'text/plain',
      sizeBytes: attachmentBytes.length,
      storagePath: legacyPath,
      sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    (bridge as any).handleEvent('conversation', {
      event: 'item_completed',
      data: {
        item: {
          id: 'pi-c',
          pi_message_id: 'pi-c',
          utterance_id: 'pi-c',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: `Attachment answer\n[forum-attachment id="${legacyPending.id}"]` }],
          attachment_refs: [
            {
              refEntryId: 'canonical-custom-entry-id',
              pendingAttachmentId: pending.id,
              sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
              sizeBytes: attachmentBytes.length,
            },
          ],
        },
      },
    });
    (bridge as any).handleEvent('conversation', { event: 'turn_completed', data: {} });

    await vi.waitFor(() => expect(store.getRobotState(topic.id)?.activity).toBe('idle'));
    const posts = db
      .prepare(
        "select id, body, parent_post_id from posts where body in ('Ordinary answer', 'Background answer', 'Attachment answer') order by rowid"
      )
      .all() as Array<any>;
    expect(posts.map(({ body, parent_post_id }) => ({ body, parent_post_id }))).toEqual([
      { body: 'Ordinary answer', parent_post_id: null },
      { body: 'Background answer', parent_post_id: origin.id },
      { body: 'Attachment answer', parent_post_id: null },
    ]);
    expect(store.listAttachmentsByPost(posts[2].id)).toHaveLength(2);
    expect(
      store.listAttachmentHandoffsForProjection(store.getAssistantProjection('pi-parent', 'pi-c')!.id)[0]?.ref_entry_id
    ).toBe('canonical-custom-entry-id');
    rmSync(attachmentPath, { force: true });
    rmSync(legacyPath, { force: true });
    expect(store.getPiMessageLink('pi-parent', 'pi-a')?.post_id).toBeTruthy();
    expect(store.getPiMessageLink('pi-parent', 'pi-b')?.post_id).toBeTruthy();
    expect(bus.emit).toHaveBeenCalledWith(
      topic.id,
      expect.objectContaining({
        type: 'assistant_message',
        data: expect.objectContaining({ piMessageId: 'pi-b', utteranceId: 'pi-b' }),
      })
    );
  });

  it('recovers every lost canonical sibling after one projected live and replays each identity exactly once', async () => {
    vi.useFakeTimers();
    const attachmentPath = `/tmp/forum-history-recovery-${randomUUID()}.txt`;
    try {
      const forum = store.createForum('Forum');
      const human = store.createIdentity('Author', 'human');
      store.createIdentity('Monika', 'robot');
      const { topic, post: origin } = store.createTopic({
        forumId: forum.id,
        title: 'Topic',
        body: 'Background request',
        authorId: human.id,
      });
      const session = store.ensureSession({ topicId: topic.id });
      store.upsertPiSessionLink({
        piSessionId: 'pi-parent',
        piSessionPath: '/tmp/parent.jsonl',
        topicId: topic.id,
        sessionId: session.id,
      });
      store.upsertRobotState({
        topicId: topic.id,
        sessionId: session.id,
        activity: 'thinking',
        model: 'm',
        reasoningEffort: null,
        currentPlanId: null,
      });
      const attachmentBytes = Buffer.from('recovered attachment');
      writeFileSync(attachmentPath, attachmentBytes);
      const pending = store.createPendingAttachment({
        topicId: topic.id,
        filename: 'recovered.txt',
        mimeType: 'text/plain',
        sizeBytes: attachmentBytes.length,
        storagePath: attachmentPath,
        sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const executionOrigin = {
        utteranceId: 'external-utterance',
        originKind: 'external',
        channelKind: 'discord',
        topicId: topic.id,
        postId: origin.id,
        surfaceId: 'channel-1',
        externalEventId: 'event-1',
        scope: 'thread-1',
        scopeKind: 'thread',
      };
      const canonicalData = {
        piMessageId: ' pi-recovered ',
        item: {
          id: 'adapter-item-id',
          type: 'message',
          message_kind: 'assistant_outward',
          role: 'assistant',
          utterance_id: 'utterance-recovered',
          content: [{ type: 'text', text: 'Recovered background result' }],
          source_kind: 'subagent-completion',
          subagent_run_id: 'run-recovered',
          origin_post_id: origin.id,
          origin_topic_id: topic.id,
          execution_origins: [executionOrigin],
          attachment_refs: [
            {
              refEntryId: 'recovered-ref',
              pendingAttachmentId: pending.id,
              sha256: pending.sha256,
              sizeBytes: pending.size_bytes,
            },
          ],
        },
      };
      const liveAData = {
        item: {
          id: 'pi-live-a',
          type: 'message',
          message_kind: 'assistant_outward',
          role: 'assistant',
          content: [{ type: 'text', text: 'Live A' }],
        },
      };
      const lostCData = {
        item: {
          id: 'pi-lost-c',
          type: 'message',
          message_kind: 'assistant_outward',
          role: 'assistant',
          content: [{ type: 'text', text: 'Lost C' }],
        },
      };
      const history = {
        conversation_id: 'conversation',
        items: [
          { id: 'wire-a', event: 'item_completed', data: liveAData },
          { id: 'wire-b', event: 'item_completed', data: canonicalData },
          { id: 'wire-c', event: 'item_completed', data: lostCData },
          { id: 'wire-turn', event: 'turn_completed', data: { pi_message_id: 'pi-lost-c' } },
        ],
      };
      const bus = { emit: vi.fn(), subscribe: vi.fn() };
      const bridge = new EchsBridge(store, bus as any, {
        model: 'm',
        workDir: '/tmp',
        echs: { baseUrl: 'http://agentd.invalid' },
      });
      const getHistory = vi.spyOn((bridge as any).client, 'getConversationHistory').mockResolvedValue(history);
      vi.spyOn(bridge as any, 'syncReasoningFromHistory').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'forceReasoningBackfill').mockResolvedValue(undefined);
      vi.spyOn(bridge as any, 'emitContext').mockResolvedValue(undefined);
      const turnStartedAt = Date.now() - 1;
      const context = {
        topicId: topic.id,
        sessionId: session.id,
        activeThreadId: 'thread',
        lastUserPostId: origin.id,
        turnParentPostId: origin.id,
        planId: null,
        reasoningSummary: '',
        reasoningBackfillAttempted: false,
        reasoningBackfillRetries: 0,
        model: 'm',
        reasoningEffort: null,
        currentTurnId: 'turn',
        turnStartedAt,
        lastUsage: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        activeSubagents: new Map(),
        lastStreamEventAt: null,
        reasoningCheckpoints: [],
      };
      (bridge as any).threadMap.set('conversation', context);

      // A reached the live projector, while B and C from the same settlement
      // were lost. Delayed history recovery must enumerate the whole settlement.
      (bridge as any).handleEvent('conversation', { event: 'item_completed', data: liveAData });
      (bridge as any).handleEvent('conversation', {
        event: 'turn_completed',
        data: { pi_message_id: 'pi-lost-c' },
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      const projection = store.getAssistantProjection('pi-parent', 'pi-recovered');
      expect(projection?.utterance_id).toBe('utterance-recovered');
      const projectedPost = projection?.post_id ? store.getPost(projection.post_id) : null;
      expect(projectedPost).toMatchObject({
        body: 'Recovered background result',
        parent_post_id: origin.id,
        follow_up: 1,
      });
      expect(store.listAttachmentsByPost(projectedPost!.id)).toHaveLength(1);
      expect(JSON.parse(projection?.origin_json ?? 'null')).toEqual(executionOrigin);
      expect(JSON.parse(store.getPiMessageLink('pi-parent', 'pi-recovered')?.metadata_json ?? '{}')).toMatchObject({
        sourceKind: 'subagent-completion',
        runId: 'run-recovered',
        originPostId: origin.id,
        originTopicId: topic.id,
      });
      const orderedPosts = db
        .prepare(
          "select body, parent_post_id from posts where body in ('Live A', 'Recovered background result', 'Lost C') order by rowid"
        )
        .all();
      expect(orderedPosts).toEqual([
        { body: 'Live A', parent_post_id: null },
        { body: 'Recovered background result', parent_post_id: origin.id },
        { body: 'Lost C', parent_post_id: origin.id },
      ]);

      // A subsequent full gap scan and replayed live items all converge through
      // AssistantProjectionService's canonical identity dedupe.
      context.turnStartedAt = Date.now() + 1;
      (bridge as any).handleEvent('conversation', { event: 'events_gap', data: {} });
      (bridge as any).handleEvent('conversation', { event: 'item_completed', data: liveAData });
      (bridge as any).handleEvent('conversation', { event: 'item_completed', data: canonicalData });
      (bridge as any).handleEvent('conversation', { event: 'item_completed', data: lostCData });
      await ((bridge as any).projectionTails.get('conversation') ?? Promise.resolve());
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(getHistory).toHaveBeenCalledTimes(2);
      expect(
        db.prepare("select count(*) as count from posts where body = 'Recovered background result'").get()
      ).toEqual({ count: 1 });
      expect(
        db.prepare("select count(*) as count from assistant_projections where pi_message_id = 'pi-recovered'").get()
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "select count(*) as count from assistant_projections where pi_message_id in ('pi-live-a', 'pi-recovered', 'pi-lost-c')"
          )
          .get()
      ).toEqual({ count: 3 });
      expect(bus.emit.mock.calls.filter(([, event]) => event?.type === 'assistant_message')).toHaveLength(3);
      await bridge.stop();
    } finally {
      rmSync(attachmentPath, { force: true });
      vi.useRealTimers();
    }
  });

  it('fails closed for a missing-ID history item without suppressing its valid sibling', async () => {
    const forum = store.createForum('Forum');
    const human = store.createIdentity('Author', 'human');
    store.createIdentity('Monika', 'robot');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'Prompt',
      authorId: human.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-parent',
      piSessionPath: '/tmp/parent.jsonl',
      topicId: topic.id,
      sessionId: session.id,
    });
    const bridge = new EchsBridge(store, { emit: vi.fn(), subscribe: vi.fn() } as any, {
      model: 'm',
      workDir: '/tmp',
      echs: { baseUrl: 'http://agentd.invalid' },
    });
    vi.spyOn((bridge as any).client, 'getConversationHistory').mockResolvedValue({
      conversation_id: 'conversation',
      items: [
        {
          id: 'wire-event-id',
          event: 'item_completed',
          data: {
            pi_message_id: '   ',
            item: {
              type: 'message',
              message_kind: 'assistant_outward',
              role: 'assistant',
              content: [{ type: 'text', text: 'Must not be projected' }],
            },
          },
        },
        {
          id: 'wire-valid-id',
          event: 'item_completed',
          data: {
            item: {
              id: 'pi-valid-sibling',
              message_kind: 'assistant_outward',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'Valid sibling' }],
            },
          },
        },
      ],
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = {
      topicId: topic.id,
      sessionId: session.id,
      activeThreadId: 'thread',
      lastUserPostId: post.id,
      turnParentPostId: post.id,
      planId: null,
      reasoningSummary: '',
      reasoningBackfillAttempted: false,
      reasoningBackfillRetries: 0,
      model: 'm',
      reasoningEffort: null,
      currentTurnId: null,
      turnStartedAt: Date.now(),
      lastUsage: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      activeSubagents: new Map(),
      lastStreamEventAt: null,
      reasoningCheckpoints: [],
    };

    await (bridge as any).ensureAssistantBackfill('conversation', context, context.turnStartedAt, post.id);

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('missing canonical Pi message id'));
    expect(db.prepare('select count(*) as count from assistant_projections').get()).toEqual({ count: 1 });
    expect(db.prepare("select count(*) as count from posts where body = 'Must not be projected'").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("select count(*) as count from posts where body = 'Valid sibling'").get()).toEqual({ count: 1 });
    warning.mockRestore();
  });
});
