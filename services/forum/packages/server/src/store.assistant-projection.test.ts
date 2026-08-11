import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { mapPostRowToDomain } from './mappers/db';
import { mapPostToDto } from './mappers/dto';
import { ForumStore } from './store';

describe('assistant projections', () => {
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
    const human = store.createIdentity('Human', 'human');
    const robot = store.createIdentity('Monika', 'robot');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'hello', authorId: human.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-session', piSessionPath: '/tmp/session.jsonl', topicId: topic.id, sessionId: session.id,
    });
    return { topic, session, robot };
  }

  it('claims a canonical Pi message exactly once across replaying projectors', () => {
    const { topic, session, robot } = fixture();
    const input = {
      piSessionId: 'pi-session', piMessageId: 'pi-message', utteranceId: 'pi-message',
      topicId: topic.id, sessionId: session.id, body: 'Exact answer', authorId: robot.id,
    };
    const first = store.beginAssistantProjection(input);
    const replay = store.beginAssistantProjection(input);

    expect(replay.id).toBe(first.id);
    expect(db.prepare("select count(*) as count from posts where body = 'Exact answer'").get()).toEqual({ count: 1 });
    expect(store.getPiMessageLink('pi-session', 'pi-message')?.post_id).toBe(first.post_id);
  });

  it('marks only explicit subagent-completion projections as follow-ups in the post DTO', () => {
    const { topic, session, robot } = fixture();
    const parent = store.listPosts(topic.id)[0]!;
    const ordinary = store.createPost({ topicId: topic.id, authorId: robot.id, body: 'Ordinary parented', parentPostId: parent.id });
    const projection = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-follow-up', utteranceId: 'pi-follow-up',
      topicId: topic.id, sessionId: session.id, body: 'Background', authorId: robot.id, parentPostId: parent.id,
      metadata: { sourceKind: 'subagent-completion' },
    });
    const ordinaryDto = mapPostToDto(mapPostRowToDomain(ordinary));
    const followUpDto = mapPostToDto(mapPostRowToDomain(store.getPost(projection.post_id!)!));
    expect(ordinaryDto.followUp).toBe(false);
    expect(followUpDto.followUp).toBe(true);
  });

  it('deduplicates mixed structured and legacy references to one pending attachment', () => {
    const { topic, session, robot } = fixture();
    const projection = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-mixed-ref', utteranceId: 'pi-mixed-ref',
      topicId: topic.id, sessionId: session.id, body: 'One file', authorId: robot.id,
      handoffs: [
        {
          refEntryId: 'structured-ref', sourceKind: 'structured-pending',
          sourceRef: { pendingAttachmentId: 'pending-file' },
        },
        {
          refEntryId: 'legacy-marker:pending-file', sourceKind: 'legacy-marker',
          sourceRef: { pendingAttachmentId: 'pending-file' },
        },
      ],
    });

    const handoffs = store.listAttachmentHandoffsForProjection(projection.id);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.ref_entry_id).toBe('structured-ref');
    expect(handoffs[0]?.source_kind).toBe('structured-pending');
  });

  it('deletes staged projections and handoffs with their topic', () => {
    const { topic, session, robot } = fixture();
    store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-delete', utteranceId: 'pi-delete',
      topicId: topic.id, sessionId: session.id, body: 'Pending', authorId: robot.id,
      handoffs: [{ refEntryId: 'delete-ref', sourceKind: 'structured-pending', sourceRef: { pendingAttachmentId: 'pending' } }],
    });
    store.deleteTopic(topic.id);
    expect(db.prepare('select count(*) as count from assistant_projections').get()).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from attachment_handoffs').get()).toEqual({ count: 0 });
  });

  it('does not create a publicly queryable post until every attachment handoff is linked', () => {
    const { topic, session, robot } = fixture();
    const projection = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-with-file', utteranceId: 'pi-with-file',
      topicId: topic.id, sessionId: session.id, body: 'File attached', authorId: robot.id,
      handoffs: [{
        refEntryId: 'ref-entry', sourceKind: 'structured-pending',
        sourceRef: { pendingAttachmentId: 'pending-file' }, expectedSha256: 'a'.repeat(64), expectedSizeBytes: 4,
      }],
    });

    expect(projection.post_id).toBeNull();
    expect(db.prepare("select count(*) as count from posts where body = 'File attached'").get()).toEqual({ count: 0 });
    expect(store.listPosts(topic.id).some((post) => post.body === 'File attached')).toBe(false);
    expect(store.search('File attached', 'posts').posts).toEqual([]);
    expect(store.listRecentPosts(50).some((post) => post.body === 'File attached')).toBe(false);
    expect(store.getTopicStats(topic.id).postCount).toBe(1);
    expect(store.finalizeAssistantProjection(projection.id)?.status).toBe('linking');
  });
});
