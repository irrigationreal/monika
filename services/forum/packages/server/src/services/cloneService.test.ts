import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { CloneService, CloneUnavailableError } from './cloneService';
import { DeploymentAdmissionCoordinator, DispatchAdmissionFencedError } from './deploymentAdmissionCoordinator';
import { PostDispatchService } from './postDispatchService';

interface Seeded {
  forumId: string;
  adminId: string;
  topicId: string;
  postIds: string[];
  activeEntryIds: string[];
  leafId: string;
  attachmentPath: string;
}

describe('CloneService', () => {
  let db: Database.Database;
  let store: ForumStore;
  let uploads: string;
  const services: CloneService[] = [];
  const dispatchServices: PostDispatchService[] = [];

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    uploads = await mkdtemp(join(tmpdir(), 'forum-clone-uploads-'));
  });

  afterEach(async () => {
    await Promise.all([
      ...services.map((service) => service.stop()),
      ...dispatchServices.map((service) => service.stop()),
    ]);
    db.close();
    await rm(uploads, { recursive: true, force: true });
  });

  async function seed(): Promise<Seeded> {
    const forum = store.createForum('Forum', undefined, '/workspace/project');
    const admin = store.createIdentity('Admin', 'admin');
    const contributor = store.createIdentity('Contributor', 'human');
    const robot = store.createIdentity('Robot', 'robot');
    const created = store.createTopic({
      forumId: forum.id,
      title: 'Parent',
      body: 'grouped first',
      authorId: admin.id,
      robotMode: 'mention',
      autoCompactEnabled: true,
    });
    const groupedSecond = store.createPost({
      topicId: created.topic.id,
      body: 'grouped second',
      authorId: contributor.id,
      parentPostId: created.post.id,
      silent: true,
    });
    const answer = store.createPost({
      topicId: created.topic.id,
      body: 'answer',
      authorId: robot.id,
      parentPostId: groupedSecond.id,
    });
    const followUp = store.createPost({
      topicId: created.topic.id,
      body: 'follow up',
      authorId: admin.id,
      parentPostId: created.post.id,
      silent: true,
    });
    db.prepare('update posts set follow_up=1 where id=?').run(followUp.id);
    const finalAnswer = store.createPost({ topicId: created.topic.id, body: 'final answer', authorId: robot.id });
    const session = store.ensureSession({ topicId: created.topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'parent-pi',
      piSessionPath: '/pi/parent.jsonl',
      topicId: created.topic.id,
      sessionId: session.id,
      cwd: '/workspace/project',
      metadata: { currentSessionFormat: true },
    });
    const messageEntries = [
      { id: 'user-group', role: 'user', postId: groupedSecond.id, contributors: [created.post.id, groupedSecond.id] },
      { id: 'assistant-1', role: 'assistant', postId: answer.id },
      { id: 'user-2', role: 'user', postId: followUp.id, contributors: [followUp.id] },
      { id: 'assistant-2', role: 'assistant', postId: finalAnswer.id },
    ];
    for (const [index, entry] of messageEntries.entries()) {
      db.prepare(
        `insert into pi_entry_index(pi_session_id,entry_id,parent_entry_id,entry_type,role,has_visible_text,first_indexed_at)
         values(?,?,?,?,?,1,?)`
      ).run(
        'parent-pi',
        entry.id,
        index ? messageEntries[index - 1]!.id : null,
        'message',
        entry.role,
        new Date().toISOString()
      );
      store.createPiMessageLink({
        piSessionId: 'parent-pi',
        piMessageId: entry.id,
        postId: entry.postId,
        role: entry.role,
        metadata: entry.contributors
          ? { contributorPostIds: entry.contributors }
          : { linkedBy: 'assistant-projection' },
      });
    }
    const leafId = 'compaction-leaf';
    db.prepare(
      `insert into pi_entry_index(pi_session_id,entry_id,parent_entry_id,entry_type,role,has_visible_text,first_indexed_at)
       values(?,?,?,?,?,0,?)`
    ).run('parent-pi', leafId, 'assistant-2', 'custom', null, new Date().toISOString());
    const activeEntryIds = [...messageEntries.map((entry) => entry.id), leafId];
    db.prepare(
      'insert into pi_session_heads(pi_session_id,leaf_entry_id,active_entry_ids_json,observed_at) values(?,?,?,?)'
    ).run('parent-pi', leafId, JSON.stringify(activeEntryIds), new Date().toISOString());
    store.upsertRobotState({ topicId: created.topic.id, sessionId: session.id, activity: 'idle', currentPlanId: null });

    const attachmentPath = join(uploads, 'source.txt');
    await writeFile(attachmentPath, 'verified independent bytes');
    store.createAttachment({
      postId: groupedSecond.id,
      filename: 'source.txt',
      mimeType: 'text/plain',
      sizeBytes: 26,
      storagePath: attachmentPath,
    });
    return {
      forumId: forum.id,
      adminId: admin.id,
      topicId: created.topic.id,
      postIds: [created.post.id, groupedSecond.id, answer.id, followUp.id, finalAnswer.id],
      activeEntryIds,
      leafId,
      attachmentPath,
    };
  }

  function createService(
    cloneTopicConversation = vi.fn(),
    acknowledgeClone = vi.fn().mockResolvedValue(undefined)
  ): CloneService {
    const service = new CloneService(
      store,
      {
        getTopicCloneSnapshot: vi.fn().mockImplementation(async () => ({
          leaf_entry_id: 'compaction-leaf',
          active_entry_ids: ['user-group', 'assistant-1', 'user-2', 'assistant-2', 'compaction-leaf'],
        })),
        cloneTopicConversation,
        acknowledgeClone,
      },
      { intervalMs: 5, uploadsDir: uploads }
    );
    services.push(service);
    return service;
  }

  it('durably materializes an idle exact copy with grouped provenance, threading, flags, and verified attachments without dispatch', async () => {
    const seeded = await seed();
    const cloneTopicConversation = vi.fn().mockResolvedValue({
      child_session_id: 'child-pi',
      child_session_path: '/pi/child.jsonl',
      inherited_generation: 9,
      active_entry_ids: [...seeded.activeEntryIds, 'operation', 'lineage', 'pending'],
    });
    const acknowledgeClone = vi.fn().mockResolvedValue(undefined);
    const service = createService(cloneTopicConversation, acknowledgeClone);
    service.start();

    const accepted = await service.enqueue({
      operationId: 'clone-one',
      topicId: seeded.topicId,
      initiatedBy: seeded.adminId,
      title: 'Copy of Parent',
    });
    expect(accepted).toMatchObject({ id: 'clone-one', status: 'pending', childTopicId: null });
    expect(store.hasCloneFence(seeded.topicId)).toBe(true);
    await vi.waitFor(() => expect(service.get(seeded.topicId, 'clone-one').status).toBe('succeeded'));

    const completed = service.get(seeded.topicId, 'clone-one');
    const child = store.getTopic(completed.childTopicId!)!;
    expect(child).toMatchObject({
      forum_id: seeded.forumId,
      title: 'Copy of Parent',
      robot_mode: 'mention',
      auto_compact_enabled: 1,
    });
    const posts = store.listPosts(child.id, 1, 100);
    expect(posts.map((post) => post.body)).toEqual([
      'grouped first',
      'grouped second',
      'answer',
      'follow up',
      'final answer',
    ]);
    expect(posts.map((post) => Boolean(post.silent))).toEqual([false, true, false, true, false]);
    expect(posts.map((post) => Boolean(post.follow_up))).toEqual([false, false, false, true, false]);
    expect(posts[1]!.parent_post_id).toBe(posts[0]!.id);
    expect(posts[3]!.parent_post_id).toBe(posts[0]!.id);
    expect(db.prepare('select count(*) as count from post_dispatches where topic_id=?').get(child.id)).toEqual({
      count: 0,
    });
    expect(store.getRobotState(child.id)?.activity).toBe('idle');
    expect(store.getTopicDispatchGeneration(child.id)).toBe(9);
    expect(store.getSessionByTopic(child.id)?.last_dispatched_post_id).toBe(posts.at(-1)!.id);

    const links = db
      .prepare('select pi_message_id,post_id,metadata_json from pi_message_links where pi_session_id=? order by rowid')
      .all('child-pi') as Array<{ pi_message_id: string; post_id: string; metadata_json: string }>;
    expect(links.map((link) => link.post_id)).toEqual([posts[1]!.id, posts[2]!.id, posts[3]!.id, posts[4]!.id]);
    expect(JSON.parse(links[0]!.metadata_json).contributorPostIds).toEqual([posts[0]!.id, posts[1]!.id]);

    const copied = store.listAttachmentsByPost(posts[1]!.id)[0]!;
    expect(copied.storage_path).not.toBe(seeded.attachmentPath);
    expect(copied.storage_path).toContain('/clone-attachments/clone-one/');
    expect(copied.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(copied.storage_path, 'utf8')).toBe('verified independent bytes');
    await writeFile(seeded.attachmentPath, 'changed parent bytes');
    expect(await readFile(copied.storage_path, 'utf8')).toBe('verified independent bytes');
    expect(await stat(copied.storage_path)).toMatchObject({ size: 26 });

    expect(store.getPiSessionLinkByTopic(child.id)).toMatchObject({
      cwd: '/workspace/project',
      lineage_kind: 'clone',
      parent_pi_session_id: 'parent-pi',
    });
    expect(cloneTopicConversation).toHaveBeenCalledWith(seeded.topicId, {
      operationId: 'clone-one',
      expectedLeafId: seeded.leafId,
    });
    expect(acknowledgeClone).toHaveBeenCalledWith('clone-one', 'child-pi');
    expect(store.hasCloneFence(seeded.topicId)).toBe(false);
  });

  it('fences a materialized child and holds its dispatches until agentd acknowledges the clone', async () => {
    const seeded = await seed();
    let releaseAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const cloneTopicConversation = vi.fn().mockResolvedValue({
      child_session_id: 'child-pi-blocked',
      child_session_path: '/pi/child-blocked.jsonl',
      inherited_generation: 9,
      active_entry_ids: [...seeded.activeEntryIds, 'operation', 'lineage', 'pending'],
    });
    const acknowledgeClone = vi.fn().mockReturnValue(acknowledgement);
    const service = createService(cloneTopicConversation, acknowledgeClone);
    service.start();
    await service.enqueue({
      operationId: 'clone-blocked-ack',
      topicId: seeded.topicId,
      initiatedBy: seeded.adminId,
      title: 'Copy held for acknowledgement',
    });

    await vi.waitFor(() => expect(service.get(seeded.topicId, 'clone-blocked-ack').childTopicId).toBeTruthy());
    const childTopicId = service.get(seeded.topicId, 'clone-blocked-ack').childTopicId!;
    expect(store.hasCloneFence(childTopicId)).toBe(true);
    expect(store.hasCompactionFence(childTopicId)).toBe(true);

    const childPost = store.createPost({
      topicId: childTopicId,
      body: 'queued before acknowledgement',
      authorId: seeded.adminId,
      silent: true,
    });
    const childSession = store.getSessionByTopic(childTopicId)!;
    const dispatch = store.createPostDispatch({
      topicId: childTopicId,
      postId: childPost.id,
      sessionId: childSession.id,
      mode: 'auto',
    });
    const dispatchPostToAgent = vi.fn().mockResolvedValue(undefined);
    const dispatchService = new PostDispatchService(store, { dispatchPostToAgent } as any, { intervalMs: 5 });
    dispatchServices.push(dispatchService);
    dispatchService.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dispatchPostToAgent).not.toHaveBeenCalled();
    expect(store.getPostDispatch(dispatch.id)?.status).toBe('pending');

    releaseAcknowledgement();
    await vi.waitFor(() => expect(service.get(seeded.topicId, 'clone-blocked-ack').status).toBe('succeeded'));
    expect(store.hasCloneFence(childTopicId)).toBe(false);
    expect(store.hasCompactionFence(childTopicId)).toBe(false);
    dispatchService.wake();
    await vi.waitFor(() => expect(dispatchPostToAgent).toHaveBeenCalledTimes(1));
    await dispatchService.stop();
  });

  it('rejects incomplete or divergent projection before creating durable state', async () => {
    const seeded = await seed();
    db.prepare('delete from pi_message_links where pi_session_id=? and pi_message_id=?').run(
      'parent-pi',
      'assistant-2'
    );
    const service = createService();
    await expect(
      service.enqueue({
        operationId: 'clone-divergent',
        topicId: seeded.topicId,
        initiatedBy: seeded.adminId,
        title: 'Copy',
      })
    ).rejects.toBeInstanceOf(CloneUnavailableError);
    expect(store.getCloneOperation('clone-divergent')).toBeNull();
  });

  it('is idempotent and mutually fenced against fork, compaction, dispatch, and non-idle sources', async () => {
    const seeded = await seed();
    const service = createService();
    const first = await service.enqueue({
      operationId: 'clone-idempotent',
      topicId: seeded.topicId,
      initiatedBy: seeded.adminId,
      title: 'Copy',
    });
    const retry = await service.enqueue({
      operationId: 'clone-idempotent',
      topicId: seeded.topicId,
      initiatedBy: seeded.adminId,
      title: 'Copy',
    });
    expect(retry.id).toBe(first.id);
    await expect(
      service.enqueue({
        operationId: 'clone-idempotent',
        topicId: seeded.topicId,
        initiatedBy: seeded.adminId,
        title: 'Different copy',
      })
    ).rejects.toThrow('operationId is already used');
    expect(store.hasCompactionFence(seeded.topicId)).toBe(true);

    db.prepare("update clone_operations set status='failed' where id='clone-idempotent'").run();
    db.prepare("update robot_state set activity='responding' where topic_id=?").run(seeded.topicId);
    await expect(
      service.enqueue({
        operationId: 'clone-busy',
        topicId: seeded.topicId,
        initiatedBy: seeded.adminId,
        title: 'Copy',
      })
    ).rejects.toThrow(/open and idle/);
  });

  it('keeps ambiguous/manual-recovery operations durable and source-fenced without blind duplicate creation', async () => {
    const seeded = await seed();
    const manual = Object.assign(new Error('canonical child outcome is unknown'), {
      status: 409,
      details: { error: 'clone_manual_recovery' },
    });
    const cloneTopicConversation = vi.fn().mockRejectedValue(manual);
    const service = createService(cloneTopicConversation);
    service.start();
    await service.enqueue({
      operationId: 'clone-manual',
      topicId: seeded.topicId,
      initiatedBy: seeded.adminId,
      title: 'Copy',
    });
    await vi.waitFor(() =>
      expect(service.get(seeded.topicId, 'clone-manual')).toMatchObject({ status: 'needs_manual_review' })
    );
    expect(store.hasCloneFence(seeded.topicId)).toBe(true);
    expect(store.hasCompactionFence(seeded.topicId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cloneTopicConversation).toHaveBeenCalledTimes(1);
  });

  it('acquires deployment admission before snapshot or attachment work', async () => {
    const seeded = await seed();
    const service = createService();
    const coordinator = new DeploymentAdmissionCoordinator(store, null, () => []);
    await coordinator.acquire({ operationId: 'deploy-clone', waitTimeoutMs: 100, leaseMs: 60_000 });
    await expect(
      service.enqueue({
        operationId: 'clone-deploy-fenced',
        topicId: seeded.topicId,
        initiatedBy: seeded.adminId,
        title: 'Copy',
      })
    ).rejects.toBeInstanceOf(DispatchAdmissionFencedError);
    expect(store.getCloneOperation('clone-deploy-fenced')).toBeNull();
    coordinator.close();
  });
});
