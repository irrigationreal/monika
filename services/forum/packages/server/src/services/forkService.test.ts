import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { DeploymentAdmissionCoordinator, DispatchAdmissionFencedError } from './deploymentAdmissionCoordinator';
import { ForkBoundariesUnavailableError, ForkService } from './forkService';

describe('ForkService', () => {
  let db: Database.Database;
  let store: ForumStore;
  let uploads: string;
  const services: ForkService[] = [];

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    uploads = await mkdtemp(join(tmpdir(), 'forum-fork-uploads-'));
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.stop()));
    db.close();
    await rm(uploads, { recursive: true, force: true });
  });

  async function seed() {
    const forum = store.createForum('Forum', undefined, '/workspace/project');
    const admin = store.createIdentity('Admin', 'admin');
    const robot = store.createIdentity('Robot', 'robot');
    const created = store.createTopic({ forumId: forum.id, title: 'Parent', body: 'first', authorId: admin.id });
    const answer = store.createPost({ topicId: created.topic.id, body: 'first answer', authorId: robot.id });
    const boundary = store.createPost({ topicId: created.topic.id, body: 'opening original', authorId: admin.id });
    const boundaryAnswer = store.createPost({ topicId: created.topic.id, body: 'opening answer', authorId: robot.id });
    const session = store.ensureSession({ topicId: created.topic.id });
    store.upsertPiSessionLink({
      piSessionId: 'parent-pi',
      piSessionPath: '/pi/parent.jsonl',
      topicId: created.topic.id,
      sessionId: session.id,
      cwd: '/workspace/project',
      metadata: { currentSessionFormat: true },
    });
    const ids = ['user-1', 'assistant-1', 'user-2', 'assistant-2'];
    for (const [index, entryId] of ids.entries()) {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      db.prepare(
        `insert into pi_entry_index(pi_session_id,entry_id,parent_entry_id,entry_type,role,has_visible_text,first_indexed_at) values(?,?,?,?,?,1,?)`
      ).run('parent-pi', entryId, index ? ids[index - 1] : null, 'message', role, new Date().toISOString());
    }
    const posts = [created.post, answer, boundary, boundaryAnswer];
    for (const [index, post] of posts.entries())
      store.createPiMessageLink({
        piSessionId: 'parent-pi',
        piMessageId: ids[index]!,
        postId: post.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        metadata: index % 2 === 0 ? { contributorPostIds: [post.id] } : { linkedBy: 'assistant-projection' },
      });
    db.prepare(
      'insert into pi_session_heads(pi_session_id,leaf_entry_id,active_entry_ids_json,observed_at) values(?,?,?,?)'
    ).run('parent-pi', 'custom-leaf', JSON.stringify([...ids, 'custom-leaf']), new Date().toISOString());
    store.upsertRobotState({ topicId: created.topic.id, sessionId: session.id, activity: 'idle', currentPlanId: null });
    const source = join(uploads, 'source.txt');
    await writeFile(source, 'independent bytes');
    store.createAttachment({
      postId: created.post.id,
      filename: 'source.txt',
      mimeType: 'text/plain',
      sizeBytes: 17,
      storagePath: source,
    });
    const deletedSource = join(uploads, 'deleted.txt');
    await writeFile(deletedSource, 'deleted bytes');
    const deletedAttachment = store.createAttachment({
      postId: created.post.id,
      filename: 'deleted.txt',
      mimeType: 'text/plain',
      sizeBytes: 13,
      storagePath: deletedSource,
    });
    store.deleteAttachment(deletedAttachment.id, 'removed');
    const openingSource = join(uploads, 'opening.txt');
    await writeFile(openingSource, 'opening attachment');
    store.createAttachment({
      postId: boundary.id,
      filename: 'opening.txt',
      mimeType: 'text/plain',
      sizeBytes: 18,
      storagePath: openingSource,
    });
    return { forum, admin, topic: created.topic, first: created.post, answer, boundary, ids, source, openingSource };
  }

  it('rejects a new fork before async leaf/prestage work while deployment admission is acquired', async () => {
    const seeded = await seed();
    const getTopicCompactionLeaf = vi.fn().mockResolvedValue('custom-leaf');
    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf,
        forkTopicConversation: vi.fn(),
        acknowledgeFork: vi.fn(),
      },
      { wake: vi.fn() },
      { intervalMs: 60_000, uploadsDir: uploads }
    );
    services.push(service);
    const coordinator = new DeploymentAdmissionCoordinator(store, null, () => []);
    await coordinator.acquire({ operationId: 'deploy-fork', waitTimeoutMs: 100, leaseMs: 60_000 });

    await expect(
      service.enqueue({
        operationId: 'fork-fenced',
        topicId: seeded.topic.id,
        boundaryPostId: seeded.boundary.id,
        initiatedBy: seeded.admin.id,
        title: 'Forked topic',
        openingBody: 'edited opening',
      })
    ).rejects.toBeInstanceOf(DispatchAdmissionFencedError);
    expect(getTopicCompactionLeaf).not.toHaveBeenCalled();
    expect(store.getForkOperation('fork-fenced')).toBeNull();
    coordinator.close();
  });

  it('durably forks, materializes inherited posts and independent attachments, then dispatches edited opening once', async () => {
    const seeded = await seed();
    const forkTopicConversation = vi.fn().mockResolvedValue({
      child_session_id: 'child-pi',
      child_session_path: '/pi/child.jsonl',
      inherited_generation: 7,
      active_entry_ids: [seeded.ids[0], seeded.ids[1], 'lineage', 'pending'],
    });
    const acknowledgeFork = vi.fn().mockResolvedValue(undefined);
    const wake = vi.fn();
    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf: vi.fn().mockResolvedValue('custom-leaf'),
        forkTopicConversation,
        acknowledgeFork,
      },
      { wake },
      { intervalMs: 60_000, uploadsDir: uploads }
    );
    services.push(service);
    service.start();

    db.prepare('update posts set follow_up=1 where id in (?, ?)').run(seeded.first.id, seeded.boundary.id);
    db.prepare('update posts set parent_post_id=? where id=?').run(seeded.first.id, seeded.boundary.id);

    const accepted = await service.enqueue({
      operationId: 'fork-1',
      topicId: seeded.topic.id,
      boundaryPostId: seeded.boundary.id,
      initiatedBy: seeded.admin.id,
      title: 'Forked topic',
      openingBody: 'edited opening',
    });
    expect(accepted.status).toBe('pending');
    expect(service.state(seeded.topic.id)).toMatchObject({
      active: { id: 'fork-1' },
      latest: { id: 'fork-1' },
    });
    expect(['pending', 'running']).toContain(service.state(seeded.topic.id).active?.status);
    expect(store.hasForkFence(seeded.topic.id)).toBe(true);
    await vi.waitFor(() => expect(service.get(seeded.topic.id, 'fork-1').status).toBe('succeeded'));

    const completed = service.get(seeded.topic.id, 'fork-1');
    const child = store.getTopic(completed.childTopicId!);
    expect(child?.forum_id).toBe(seeded.forum.id);
    const posts = store.listPosts(child!.id, 1, 100);
    expect(posts.map((post) => post.body)).toEqual(['first', 'first answer', 'edited opening']);
    expect(posts.map((post) => Boolean(post.follow_up))).toEqual([true, false, true]);
    expect(posts[2]!.parent_post_id).toBe(posts[0]!.id);
    expect(store.getPostDispatchByPost(posts[2]!.id)).toMatchObject({ generation: 7, status: 'pending' });
    expect(db.prepare('select count(*) count from post_dispatches where topic_id=?').get(child!.id)).toEqual({
      count: 1,
    });
    const inheritedLinks = db
      .prepare('select * from pi_message_links where pi_session_id=? order by rowid asc')
      .all('child-pi') as Array<{ post_id: string; metadata_json: string }>;
    expect(inheritedLinks.map((link) => link.post_id)).toEqual([posts[0]!.id, posts[1]!.id]);
    expect(inheritedLinks.map((link) => JSON.parse(link.metadata_json).contributorPostIds)).toEqual([
      [posts[0]!.id],
      [posts[1]!.id],
    ]);
    const childSession = store.getSessionByTopic(child!.id)!;
    expect(childSession.last_dispatched_post_id).toBe(posts[1]!.id);
    expect(
      store.listPostsBetween(child!.id, {
        afterPostId: childSession.last_dispatched_post_id,
        beforePostId: posts[2]!.id,
        excludePiSessionId: 'child-pi',
      })
    ).toEqual([]);
    const copiedAttachment = store.listAttachmentsByPost(posts[0]!.id)[0]!;
    expect(copiedAttachment.storage_path).not.toBe(seeded.source);
    expect(copiedAttachment.storage_path).toContain('/fork-attachments/fork-1/');
    expect(await readFile(copiedAttachment.storage_path, 'utf8')).toBe('independent bytes');
    expect(copiedAttachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(store.listAttachmentsByPost(posts[0]!.id)).toHaveLength(1);
    expect(store.listAttachmentsByPost(posts[0]!.id).some((attachment) => attachment.filename === 'deleted.txt')).toBe(
      false
    );
    const openingAttachment = store.listAttachmentsByPost(posts[2]!.id)[0]!;
    expect(openingAttachment.storage_path).not.toBe(seeded.openingSource);
    expect(await readFile(openingAttachment.storage_path, 'utf8')).toBe('opening attachment');
    expect(store.getPiSessionLinkByTopic(child!.id)).toMatchObject({
      lineage_kind: 'fork',
      parent_pi_session_id: 'parent-pi',
    });
    expect(forkTopicConversation).toHaveBeenCalledTimes(1);
    expect(acknowledgeFork).toHaveBeenCalledWith('fork-1', 'child-pi');
    expect(store.hasForkFence(seeded.topic.id)).toBe(false);
    expect(service.state(seeded.topic.id)).toMatchObject({
      active: null,
      latest: { id: 'fork-1', status: 'succeeded' },
    });
    await expect(stat(join(uploads, 'fork-prestage', 'fork-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(wake).toHaveBeenCalled();
  });

  it('refreshes canonical projection before listing boundaries and reports refresh outages distinctly', async () => {
    const seeded = await seed();
    const refreshBoundaries = vi.fn().mockResolvedValue(undefined);
    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf: vi.fn(),
        forkTopicConversation: vi.fn(),
        acknowledgeFork: vi.fn(),
      },
      { wake: vi.fn() },
      { intervalMs: 60_000, uploadsDir: uploads, refreshBoundaries }
    );
    services.push(service);

    await expect(service.boundaries(seeded.topic.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ postId: seeded.boundary.id })])
    );
    expect(refreshBoundaries).toHaveBeenCalledWith(seeded.topic.id);

    refreshBoundaries.mockRejectedValueOnce(new Error('agentd unavailable'));
    await expect(service.boundaries(seeded.topic.id)).rejects.toBeInstanceOf(ForkBoundariesUnavailableError);
  });

  it('excludes grouped and incomplete/deleted projection boundaries', async () => {
    const seeded = await seed();
    const candidates = store.listEligibleForkBoundaries(seeded.topic.id);
    expect(candidates.map((candidate) => candidate.postId)).toContain(seeded.boundary.id);
    expect(candidates.map((candidate) => candidate.postId)).not.toContain(seeded.first.id);
    db.prepare('update pi_message_links set metadata_json=? where pi_session_id=? and pi_message_id=?').run(
      JSON.stringify({ contributorPostIds: ['a', 'b'] }),
      'parent-pi',
      'user-2'
    );
    expect(store.listEligibleForkBoundaries(seeded.topic.id).map((candidate) => candidate.postId)).not.toContain(
      seeded.boundary.id
    );
    db.prepare(
      'update posts set deleted_at=? where id=(select post_id from pi_message_links where pi_session_id=? and pi_message_id=?)'
    ).run(new Date().toISOString(), 'parent-pi', 'assistant-1');
    expect(store.listEligibleForkBoundaries(seeded.topic.id)).toEqual([]);
  });

  it('keeps the forum source fenced without retrying an ambiguous child that needs manual review', async () => {
    const seeded = await seed();
    const rejection = Object.assign(new Error('unmarked child outcome requires manual recovery'), {
      status: 409,
      details: { error: 'fork_manual_recovery' },
    });
    const forkTopicConversation = vi.fn().mockRejectedValue(rejection);
    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf: vi.fn().mockResolvedValue('custom-leaf'),
        forkTopicConversation,
        acknowledgeFork: vi.fn(),
      },
      { wake: vi.fn() },
      { intervalMs: 10, uploadsDir: uploads }
    );
    services.push(service);
    service.start();
    await service.enqueue({
      operationId: 'fork-manual-review',
      topicId: seeded.topic.id,
      boundaryPostId: seeded.boundary.id,
      initiatedBy: seeded.admin.id,
      title: 'Ambiguous fork',
      openingBody: 'edited',
    });

    await vi.waitFor(() =>
      expect(service.get(seeded.topic.id, 'fork-manual-review').status).toBe('needs_manual_review')
    );
    expect(service.state(seeded.topic.id).active).toMatchObject({
      id: 'fork-manual-review',
      status: 'needs_manual_review',
    });
    expect(store.hasForkFence(seeded.topic.id)).toBe(true);
    expect(store.hasCompactionFence(seeded.topic.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(forkTopicConversation).toHaveBeenCalledTimes(1);
    expect(service.get(seeded.topic.id, 'fork-manual-review')).toMatchObject({
      status: 'needs_manual_review',
      finishedAt: null,
    });
    await expect(stat(join(uploads, 'fork-prestage', 'fork-manual-review'))).resolves.toBeDefined();
  });

  it('cleans prestaged attachments after a definitive agentd rejection', async () => {
    const seeded = await seed();
    const rejection = Object.assign(new Error('invalid boundary'), {
      status: 400,
      details: { error: 'invalid_boundary' },
    });
    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf: vi.fn().mockResolvedValue('custom-leaf'),
        forkTopicConversation: vi.fn().mockRejectedValue(rejection),
        acknowledgeFork: vi.fn(),
      },
      { wake: vi.fn() },
      { intervalMs: 60_000, uploadsDir: uploads }
    );
    services.push(service);
    service.start();
    await service.enqueue({
      operationId: 'fork-definitive-failure',
      topicId: seeded.topic.id,
      boundaryPostId: seeded.boundary.id,
      initiatedBy: seeded.admin.id,
      title: 'Rejected fork',
      openingBody: 'edited',
    });
    await vi.waitFor(() => expect(service.get(seeded.topic.id, 'fork-definitive-failure').status).toBe('failed'));
    await expect(stat(join(uploads, 'fork-prestage', 'fork-definitive-failure'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes only bounded, old pre-row orphan prestage directories at startup', async () => {
    const orphan = join(uploads, 'fork-prestage', 'orphan-operation');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'orphan.txt'), 'orphan');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(orphan, old, old);
    const recent = join(uploads, 'fork-prestage', 'recent-operation');
    await mkdir(recent, { recursive: true });

    const service = new ForkService(
      store,
      {
        getTopicCompactionLeaf: vi.fn(),
        forkTopicConversation: vi.fn(),
        acknowledgeFork: vi.fn(),
      },
      { wake: vi.fn() },
      { intervalMs: 60_000, uploadsDir: uploads }
    );
    services.push(service);
    service.start();
    await service.waitForIdle();

    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(recent)).resolves.toBeDefined();
  });
});
