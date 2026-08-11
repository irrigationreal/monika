import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrate } from '../db';
import { InMemoryMessageTamperLayer } from '../messageTamper';
import { ForumStore } from '../store';
import { AssistantProjectionService } from './assistantProjectionService';
import { AttachmentHandoffService } from './attachmentHandoffService';

async function raceSnapshot(order: 'live-first' | 'sync-first') {
  const db = new Database(':memory:');
  migrate(db);
  const store = new ForumStore(db);
  const forum = store.createForum('Forum');
  const human = store.createIdentity('Human', 'human');
  store.createIdentity('Monika', 'robot');
  store.createRobotPersona({ forumId: forum.id, key: 'monika', displayName: 'Monika', description: '', soul: '' });
  const { topic, post: parent } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'Prompt', authorId: human.id });
  const session = store.ensureSession({ topicId: topic.id });
  store.upsertPiSessionLink({ piSessionId: 'pi-session', piSessionPath: '/tmp/pi.jsonl', topicId: topic.id, sessionId: session.id });
  const bytes = Buffer.from('one durable file');
  const storagePath = `/tmp/forum-projection-race-${randomUUID()}.txt`;
  writeFileSync(storagePath, bytes);
  const pending = store.createPendingAttachment({
    topicId: topic.id, filename: 'result.txt', mimeType: 'text/plain', sizeBytes: bytes.length,
    storagePath, sha256: createHash('sha256').update(bytes).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const tamper = new InMemoryMessageTamperLayer();
  tamper.register({
    key: 'deterministic-outbound', stages: ['outbound.codex_to_forum'],
    tamper: ({ text }) => ({ text: `Visible: ${text}` }),
  });
  const handoffs = new AttachmentHandoffService(store);
  const project = new AssistantProjectionService(store, {
    tamperLayer: tamper,
    onProjectionBegun: (projection) => handoffs.processProjection(projection.id),
  });
  const liveContinuation = {
    source_kind: 'subagent-completion', subagent_run_id: 'run-1', subagent_run_ids: ['run-1'],
    subagent_origins: [{ run_id: 'run-1', turn_id: 'turn-1', post_id: parent.id, topic_id: topic.id }],
    origin_turn_id: 'turn-1', origin_post_id: parent.id, origin_topic_id: topic.id,
  };
  const syncContinuation = {
    sourceKind: 'subagent-completion', subagentRunId: 'run-1', subagentRunIds: ['run-1'],
    subagentOrigins: [{ runId: 'run-1', turnId: 'turn-1', postId: parent.id, topicId: topic.id }],
    origin: { turnId: 'turn-1', postId: parent.id, topicId: topic.id },
  };
  const common = {
    piSessionId: 'pi-session', piMessageId: 'pi-message', utteranceId: 'pi-message',
    topicId: topic.id, sessionId: session.id,
    rawText: `Answer\n[forum-attachment id="${pending.id}"]`,
    parentPostId: null,
    attachmentRefs: [{ refEntryId: 'structured-ref', pendingAttachmentId: pending.id, sha256: pending.sha256, sizeBytes: pending.size_bytes }],
    origin: null,
  };
  const live = () => project.project({ ...common, continuation: liveContinuation, completion: { threadId: 'conversation' } });
  const sync = () => project.project({ ...common, continuation: syncContinuation, completion: null });
  if (order === 'live-first') { await live(); await sync(); } else { await sync(); await live(); }

  const projection = store.getAssistantProjection('pi-session', 'pi-message')!;
  const post = store.getPost(projection.post_id!)!;
  const rawMetadata = JSON.parse(projection.projection_json).metadata;
  const result = {
    body: post.body,
    parentIsOrigin: post.parent_post_id === parent.id,
    followUp: post.follow_up,
    metadata: {
      ...rawMetadata,
      originPostId: rawMetadata.originPostId === parent.id,
      originTopicId: rawMetadata.originTopicId === topic.id,
      origins: rawMetadata.origins.map((origin: Record<string, unknown>) => ({
        ...origin, postId: origin['postId'] === parent.id, topicId: origin['topicId'] === topic.id,
      })),
    },
    attachments: store.listAttachmentsByPost(post.id).map((item) => ({ filename: item.filename, sha256: item.sha256 })),
    handoffCount: store.listAttachmentHandoffsForProjection(projection.id).length,
    runLookup: db.prepare(`select count(*) as count from pi_message_links
      where exists (select 1 from json_each(metadata_json, '$.runIds') where value = 'run-1')`).get(),
  };
  db.close();
  rmSync(storagePath, { force: true });
  return result;
}

describe('deterministic assistant projection races', () => {
  it('converges when the live projector wins and when sync wins', async () => {
    const liveFirst = await raceSnapshot('live-first');
    const syncFirst = await raceSnapshot('sync-first');
    expect(liveFirst).toEqual(syncFirst);
    expect(liveFirst).toMatchObject({
      body: '[[persona:monika]]\nVisible: Answer\n[[/persona]]',
      parentIsOrigin: true,
      followUp: 1,
      handoffCount: 1,
      runLookup: { count: 1 },
      attachments: [{ filename: 'result.txt' }],
    });
  });
});
