import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForumQueries } from '../core/queries';
import { ForumStoreRuntime } from '../core/runtime';
import { createCoreServices } from '../core/services';
import { migrate } from '../db';
import { SqliteStatsReadModel } from '../readModels/statsReadModel';
import { ForumStore } from '../store';
import { createStreamBus } from '../streamBus';
import { createAccessHelpers } from '../utils/access';
import { registerForumRoutes } from './forumRoutes';

describe('Forum routes access controls', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
  });

  async function buildApp(compactionService?: any) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    const access = createAccessHelpers(app, store);
    const featureFlags = { enableRateLimiting: false, useRedisStreamBus: false } as any;
    const bus = createStreamBus(false);
    const codex = {
      sendUserMessage: vi.fn(async () => {}),
      steerUserMessage: vi.fn(async () => {}),
      isThreadLoaded: vi.fn(async () => false),
    } as any;
    const core = createCoreServices(db);
    const queries = new ForumQueries(db);
    const runtime = new ForumStoreRuntime(store);
    const statsReadModel = new SqliteStatsReadModel(db);
    registerForumRoutes({
      app,
      store,
      core,
      queries,
      runtime,
      statsReadModel,
      featureFlags,
      codex,
      webhookService: { dispatch: () => {} } as any,
      bus,
      compactionService,
      access,
      webIdentityId: store.createIdentity('web', 'human').id,
    });
    await app.ready();
    return app;
  }

  it('returns only public-safe lineage and hides inaccessible parent topics', async () => {
    const app = await buildApp();
    const publicForum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const membersForum = store.createForum('Members', null, null, null, null, 'active', 'members');
    const author = store.createIdentityWithPassword('Author', 'member', 'pw-hash', 'author');
    store.createAuthSession('member-token', author.id);
    const { topic: parent } = store.createTopic({
      forumId: membersForum.id,
      title: 'Private parent',
      body: 'parent',
      authorId: author.id,
    });
    const parentSession = store.ensureSession({ topicId: parent.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-parent',
      piSessionPath: '/app/.pi/agent/sessions/private-parent.jsonl',
      topicId: parent.id,
      sessionId: parentSession.id,
      cwd: '/workspace/private-project',
    });
    const { topic: child } = store.createTopic({
      forumId: publicForum.id,
      title: 'Public child',
      body: 'child',
      authorId: author.id,
    });
    const childSession = store.ensureSession({ topicId: child.id });
    store.upsertPiSessionLink({
      piSessionId: 'pi-child',
      piSessionPath: '/app/.pi/agent/sessions/public-child.jsonl',
      topicId: child.id,
      sessionId: childSession.id,
      cwd: '/workspace/private-project',
      parentPiSessionId: 'pi-parent',
      parentPiSessionPath: '/app/.pi/agent/sessions/private-parent.jsonl',
      lineageKind: 'handoff',
      lineageSource: 'forum',
    });

    const guest = await app.inject({ method: 'GET', url: `/topics/${child.id}` });
    expect(guest.statusCode).toBe(200);
    expect(guest.json()).toMatchObject({ lineage: { kind: 'handoff', parentTopicId: null } });
    expect(guest.json()).not.toHaveProperty('piSession');
    expect(JSON.stringify(guest.json())).not.toContain('/app/.pi');
    expect(JSON.stringify(guest.json())).not.toContain('/workspace/private-project');

    const member = await app.inject({
      method: 'GET',
      url: `/topics/${child.id}`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toMatchObject({ lineage: { kind: 'handoff', parentTopicId: parent.id } });
    expect(member.json()).not.toHaveProperty('piSession');
  });

  it('returns public post content to guests without trace fields', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const robot = store.createIdentity('Monika', 'robot');
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'starter',
      authorId: robot.id,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.createPlan({
      topicId: topic.id,
      sessionId: session.id,
      content: 'secret plan content',
      summary: 'secret plan summary',
      parentPostId: post.id,
      visibility: 'internal',
    });
    store.createToolRun({
      topicId: topic.id,
      sessionId: session.id,
      tool: 'bash',
      parentPostId: post.id,
      command: 'cat /secret/path',
      outputSummary: 'secret output',
      visibility: 'internal',
    });

    const res = await app.inject({ method: 'GET', url: `/topics/${topic.id}/posts` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].body).toBe('starter');
    expect(body.items[0]).not.toHaveProperty('currentPlan');
    expect(body.items[0]).not.toHaveProperty('recentToolRuns');
    expect(body.items[0]).not.toHaveProperty('toolRuns');
    expect(body.items[0]).not.toHaveProperty('plans');
    expect(JSON.stringify(body)).not.toContain('secret plan content');
    expect(JSON.stringify(body)).not.toContain('cat /secret/path');
  });

  it('redacts operational event detail for guests and includes it for authenticated members', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    store.createAuthSession('member-token', author.id);
    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'starter',
      authorId: author.id,
    });
    store.createTopicOperationalEvent({
      topicId: topic.id,
      anchorPostId: post.id,
      type: 'turn_error',
      category: 'assistant',
      status: 'failed',
      summary: 'Assistant response failed.',
      detail: { error: 'private stack trace' },
      sourceKind: 'echs_turn',
      sourceId: 'evt-1',
    });

    const guest = await app.inject({ method: 'GET', url: `/topics/${topic.id}/operational-events` });
    const member = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/operational-events`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(guest.json().items[0].detail).toBeNull();
    expect(JSON.stringify(guest.json())).not.toContain('private stack trace');
    expect(member.json().items[0].detail).toEqual({ error: 'private stack trace' });
  });

  it('requires an admin identity for manual compaction', async () => {
    const enqueue = vi.fn();
    const app = await buildApp({ enqueue, get: vi.fn(), getState: vi.fn(), retryCheckpoint: vi.fn() });
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('human-token', human.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: human.id });
    const payload = { operationId: 'op', confirmation: 'COMPACT', recoveryPrompt: 'recover' };
    const guest = await app.inject({ method: 'POST', url: `/topics/${topic.id}/compactions`, payload });
    const member = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/compactions`,
      headers: { authorization: 'Bearer human-token' },
      payload,
    });
    expect(guest.statusCode).toBe(401);
    expect(member.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts durable compaction jobs with 202 and exposes reload-safe topic state', async () => {
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: admin.id });
    const pending = {
      id: 'op-pending',
      topicId: topic.id,
      sessionId: 'session-1',
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      customInstructions: null,
      recoveryPrompt: 'recover',
      status: 'pending',
      eventId: null,
      recoveryPostId: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const enqueue = vi.fn().mockResolvedValue(pending);
    const getState = vi.fn().mockReturnValue({ active: pending, latest: pending, checkpointDispatch: null });
    const app = await buildApp({ enqueue, getState, get: vi.fn(), retryCheckpoint: vi.fn() });

    const accepted = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/compactions`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { operationId: pending.id, confirmation: 'COMPACT', customInstructions: null, recoveryPrompt: 'recover' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers.location).toBe(`/topics/${topic.id}/compactions/${pending.id}`);
    expect(accepted.json()).toMatchObject({ id: pending.id, status: 'pending' });

    const stateResponse = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/compactions`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json()).toMatchObject({ active: { id: pending.id }, latest: { id: pending.id } });
  });

  it('blocks ordinary posts while a compaction job is pending', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.createCompactionOperation({
      id: 'op-pending-post-gate',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'must wait' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('compaction is in progress');
    const lock = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}/status`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { status: 'locked' },
    });
    expect(lock.statusCode).toBe(409);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(remove.statusCode).toBe(409);
  });

  it('keeps posts fenced until a successful compaction checkpoint is dispatched', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('admin-token', admin.id);
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: admin.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.createCompactionOperation({
      id: 'op-checkpoint-fence',
      topicId: topic.id,
      sessionId: session.id,
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('op-checkpoint-fence');
    const completed = store.finishCompactionSuccess('op-checkpoint-fence');

    const blocked = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'too soon' },
    });
    expect(blocked.statusCode).toBe(409);
    const dispatch = store.getPostDispatchByPost(completed.recoveryPostId!);
    store.updateTopicStatus(topic.id, 'locked');
    db.prepare("update post_dispatches set status = 'abandoned' where id = ?").run(dispatch!.id);
    const reopened = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}/status`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { status: 'open' },
    });
    expect(reopened.statusCode).toBe(200);
    db.prepare("update post_dispatches set status = 'dispatched' where id = ?").run(dispatch!.id);
    const allowed = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'after checkpoint acceptance', silent: true },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('blocks guests from creating topics and posts (401)', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentity('Author', 'human');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

    const createTopicRes = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      payload: { title: 'New topic', body: 'hello' },
    });
    expect(createTopicRes.statusCode).toBe(401);

    const createPostRes = await app.inject({
      method: 'POST',
      url: `/topics/${topic.id}/posts`,
      payload: { body: 'reply' },
    });
    expect(createPostRes.statusCode).toBe(401);
  });

  it('keeps auto-compaction admin-only, revisioned, and idle-only', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const denied = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: 'Bearer human-token' },
      payload: { title: 'Denied', body: 'starter', autoCompactEnabled: true },
    });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: `/forums/${forum.id}/topics`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { title: 'Enabled', body: 'starter', autoCompactEnabled: true, silent: true },
    });
    expect(created.json()).toMatchObject({ autoCompactEnabled: true, autoCompactRevision: 0 });
    const topicId = created.json().id as string;
    const session = store.ensureSession({ topicId });
    store.upsertRobotState({ topicId, sessionId: session.id, activity: 'idle' });

    const staleNoop = await app.inject({
      method: 'POST',
      url: `/topics/${topicId}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'stale noop', autoCompactEnabled: true, autoCompactRevision: 9, silent: true },
    });
    expect(staleNoop.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST',
      url: `/topics/${topicId}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'stale', autoCompactEnabled: false, autoCompactRevision: 9, silent: true },
    });
    expect(stale.statusCode).toBe(409);
    store.upsertRobotState({ topicId, sessionId: session.id, activity: 'thinking' });
    const busy = await app.inject({
      method: 'POST',
      url: `/topics/${topicId}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'busy', autoCompactEnabled: false, autoCompactRevision: 0, silent: true },
    });
    expect(busy.statusCode).toBe(409);
    store.upsertRobotState({ topicId, sessionId: session.id, activity: 'idle' });
    store.createCompactionOperation({
      id: 'running-compact',
      topicId,
      sessionId: session.id,
      initiatedBy: admin.id,
      expectedLeafId: 'leaf-1',
      recoveryPrompt: 'recover',
    });
    store.claimCompactionOperation('running-compact');
    const compacting = await app.inject({
      method: 'POST',
      url: `/topics/${topicId}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'compacting', autoCompactEnabled: false, autoCompactRevision: 0, silent: true },
    });
    expect(compacting.statusCode).toBe(409);
    store.finishCompactionFailure('running-compact', 'cancelled for test');
    const changed = await app.inject({
      method: 'POST',
      url: `/topics/${topicId}/posts`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'disable', autoCompactEnabled: false, autoCompactRevision: 0, silent: true },
    });
    expect(changed.statusCode).toBe(200);
    expect(store.getTopic(topicId)).toMatchObject({ auto_compact_enabled: 0, auto_compact_revision: 1 });
  });

  it('requires admin access to create forums', async () => {
    const app = await buildApp();
    const admin = store.createIdentity('Admin', 'admin');
    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('human-token', human.id);

    const guestRes = await app.inject({
      method: 'POST',
      url: '/forums',
      payload: { name: 'Guest Forum' },
    });
    expect(guestRes.statusCode).toBe(401);

    const humanRes = await app.inject({
      method: 'POST',
      url: '/forums',
      headers: { authorization: 'Bearer human-token' },
      payload: { name: 'Human Forum' },
    });
    expect(humanRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'POST',
      url: '/forums',
      headers: { authorization: 'Bearer admin-token' },
      payload: { name: 'Admin Forum' },
    });
    expect(adminRes.statusCode).toBe(200);
  });

  it('enforces post edit permissions (only author; admins may not edit others)', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');

    store.createAuthSession('author-token', author.id);
    store.createAuthSession('other-token', other.id);
    store.createAuthSession('admin-token', admin.id);

    const { topic, post } = store.createTopic({
      forumId: forum.id,
      title: 'Topic',
      body: 'starter',
      authorId: author.id,
    });

    const guestRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      payload: { body: 'edited' },
    });
    expect(guestRes.statusCode).toBe(401);

    const otherRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: 'Bearer other-token' },
      payload: { body: 'edited by other' },
    });
    expect(otherRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { body: 'edited by admin' },
    });
    expect(adminRes.statusCode).toBe(403);

    const authorRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: 'Bearer author-token' },
      payload: { body: 'edited by author' },
    });
    expect(authorRes.statusCode).toBe(200);
    expect((authorRes.json() as any).body).toBe('edited by author');
    expect((authorRes.json() as any).editedAt).toBeTruthy();

    // Keep topic referenced so TS doesn't complain in some editors; also sanity-check we created it.
    expect(topic.id).toBeTruthy();
  });

  it('enforces post delete permissions (author can delete own; admin can delete any)', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    const other = store.createIdentityWithPassword('Other', 'other', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');

    store.createAuthSession('author-token', author.id);
    store.createAuthSession('other-token', other.id);
    store.createAuthSession('admin-token', admin.id);

    const { post } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });
    const reply = store.createPost({
      topicId: post.topic_id,
      body: 'reply',
      parentPostId: post.id,
      authorId: author.id,
    });

    const guestRes = await app.inject({ method: 'DELETE', url: `/posts/${reply.id}` });
    expect(guestRes.statusCode).toBe(401);

    const otherRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${reply.id}`,
      headers: { authorization: 'Bearer other-token' },
    });
    expect(otherRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${reply.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminRes.statusCode).toBe(200);
    expect((adminRes.json() as any).deletedAt).toBeTruthy();
  });

  it('prevents posting/creating topics in admin-only forums for non-admin users', async () => {
    const app = await buildApp();
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');

    const human = store.createIdentityWithPassword('Human', 'human', 'pw-hash', 'human');
    const admin = store.createIdentity('Admin', 'admin');
    store.createAuthSession('human-token', human.id);
    store.createAuthSession('admin-token', admin.id);

    const resHumanCreateTopic = await app.inject({
      method: 'POST',
      url: `/forums/${adminForum.id}/topics`,
      headers: { authorization: 'Bearer human-token' },
      payload: { title: 'nope', body: 'nope' },
    });
    expect(resHumanCreateTopic.statusCode).toBe(403);

    const resAdminCreateTopic = await app.inject({
      method: 'POST',
      url: `/forums/${adminForum.id}/topics`,
      headers: { authorization: 'Bearer admin-token' },
      payload: { title: 'ok', body: 'starter' },
    });
    expect(resAdminCreateTopic.statusCode).toBe(200);
    const createdTopic = resAdminCreateTopic.json() as { id: string };

    const resHumanCreatePost = await app.inject({
      method: 'POST',
      url: `/topics/${createdTopic.id}/posts`,
      headers: { authorization: 'Bearer human-token' },
      payload: { body: 'trying to post' },
    });
    expect(resHumanCreatePost.statusCode).toBe(403);
  });

  it('hides admin-only topics from non-admin viewers', async () => {
    const app = await buildApp();
    const adminForum = store.createForum('Admin', null, null, null, null, 'active', 'admin');
    const admin = store.createIdentity('Admin', 'admin');
    const member = store.createIdentityWithPassword('Member', 'member', 'pw-hash', 'human');
    store.createAuthSession('admin-token', admin.id);
    store.createAuthSession('member-token', member.id);

    const { topic } = store.createTopic({
      forumId: adminForum.id,
      title: 'Secret',
      body: 'hidden',
      authorId: admin.id,
    });

    const memberTopicRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(memberTopicRes.statusCode).toBe(404);

    const memberPostsRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}/posts`,
      headers: { authorization: 'Bearer member-token' },
    });
    expect(memberPostsRes.statusCode).toBe(404);

    const adminTopicRes = await app.inject({
      method: 'GET',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(adminTopicRes.statusCode).toBe(200);
  });

  it('requires moderator permissions for topic mutations (title/status/delete)', async () => {
    const app = await buildApp();
    const forum = store.createForum('Forum', null, null, null, null, 'active', 'public');
    const author = store.createIdentityWithPassword('Author', 'author', 'pw-hash', 'human');
    const modUser = store.createIdentityWithPassword('Mod', 'mod', 'pw-hash', 'human');
    store.createAuthSession('author-token', author.id);
    store.createAuthSession('mod-token', modUser.id);

    // Grant moderator permissions via role assignment.
    const modRole = store.createRole('moderator', ['mod.all'], null);
    store.assignRole(modUser.id, modRole.id);

    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'starter', authorId: author.id });

    const guestStatus = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}/status`,
      payload: { status: 'locked' },
    });
    expect(guestStatus.statusCode).toBe(401);

    const authorStatus = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}/status`,
      headers: { authorization: 'Bearer author-token' },
      payload: { status: 'locked' },
    });
    expect(authorStatus.statusCode).toBe(403);

    const modStatus = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}/status`,
      headers: { authorization: 'Bearer mod-token' },
      payload: { status: 'locked' },
    });
    expect(modStatus.statusCode).toBe(200);

    const authorTitle = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer author-token' },
      payload: { title: 'New title' },
    });
    expect(authorTitle.statusCode).toBe(403);

    const modTitle = await app.inject({
      method: 'PATCH',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer mod-token' },
      payload: { title: 'New title' },
    });
    expect(modTitle.statusCode).toBe(200);

    const authorDelete = await app.inject({
      method: 'DELETE',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer author-token' },
    });
    expect(authorDelete.statusCode).toBe(403);

    const modDelete = await app.inject({
      method: 'DELETE',
      url: `/topics/${topic.id}`,
      headers: { authorization: 'Bearer mod-token' },
    });
    expect(modDelete.statusCode).toBe(200);
  });
});
