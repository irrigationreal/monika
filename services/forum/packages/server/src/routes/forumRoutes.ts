import {
  CreateCompactionRequestSchema,
  CreateForkRequestSchema,
  CreatePostRequestSchema,
  CreateTopicRequestSchema,
} from '@irrigationreal/codex-forum-contracts';

import {
  mapCompactionOperationToDto,
  mapForkOperationToDto,
  mapTopicCompactionStateToDto,
  mapTopicOperationalEventToDto,
} from '../mappers/dto';
import { CompactionConflictError, CompactionNotFoundError } from '../services/compactionService';
import { ForkConflictError, ForkNotFoundError } from '../services/forkService';
import { serializePost, serializeTopic } from '../utils/serializers';
import { parseBody } from '../utils/validation';

import type { FastifyInstance } from 'fastify';

import type { AgentBridge } from '../agentBridge';
import type { FeatureFlags } from '../config';
import type { CompactionService } from '../services/compactionService';
import type { ForkService } from '../services/forkService';
import type { PostDispatchService } from '../services/postDispatchService';
import type { WebhookService } from '../services/webhookService';
import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AccessHelpers } from '../utils/access';

export function registerForumRoutes({
  app,
  store,
  featureFlags,
  codex,
  webhookService,
  bus,
  postDispatchService,
  compactionService,
  forkService,
  access,
  webIdentityId,
}: {
  app: FastifyInstance;
  store: ForumStore;
  featureFlags: FeatureFlags;
  codex: AgentBridge;
  webhookService: WebhookService;
  bus: StreamBusInterface;
  postDispatchService?: Pick<PostDispatchService, 'wake'>;
  compactionService?: CompactionService;
  forkService?: ForkService;
  access: AccessHelpers;
  webIdentityId: string;
}): void {
  const {
    getCurrentUser,
    requireScope,
    requireAdmin,
    getIdentityFromRequest,
    canViewForum,
    canViewTopic,
    canCreateTopic,
    canPostTopic,
    requireForumVisible,
    requireTopicVisible,
    requirePostVisible,
    requireModerator,
  } = access;

  function resolveRobotMode(value?: string | null): 'auto' | 'mention' | 'off' {
    if (value === 'mention' || value === 'off' || value === 'auto') {
      return value;
    }
    return 'auto';
  }

  function serializeTopicWithPublicLineage(
    topic: Parameters<typeof serializeTopic>[0],
    request: Parameters<typeof getIdentityFromRequest>[0]
  ): ReturnType<typeof serializeTopic> & {
    lineage?: { kind: 'handoff' | 'fork' | 'delegate' | 'sleep' | 'parent'; parentTopicId: string | null };
  } {
    const dto = serializeTopic(topic) as ReturnType<typeof serializeTopic> & {
      lineage?: { kind: 'handoff' | 'fork' | 'delegate' | 'sleep' | 'parent'; parentTopicId: string | null };
    };
    const link = store.getPiSessionLinkByTopic(topic.id);
    if (!link?.parent_pi_session_id && !link?.parent_pi_session_path) return dto;

    const rawKind = link.lineage_kind?.trim().toLowerCase();
    const kind =
      rawKind === 'handoff' || rawKind === 'fork' || rawKind === 'delegate' || rawKind === 'sleep'
        ? rawKind
        : 'parent';
    const parentLink = link.parent_pi_session_id
      ? store.getPiSessionLinkByPiSessionId(link.parent_pi_session_id)
      : link.parent_pi_session_path
        ? store.getPiSessionLinkByPiSessionPath(link.parent_pi_session_path)
        : null;
    const parentTopic = parentLink ? store.getTopic(parentLink.topic_id) : null;
    const parentForum = parentTopic ? store.getForum(parentTopic.forum_id) : null;
    const identity = getIdentityFromRequest(request);
    const parentTopicId =
      parentTopic && parentForum && canViewTopic(parentTopic, parentForum, identity) ? parentTopic.id : null;

    dto.lineage = { kind, parentTopicId };
    return dto;
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeMentionToken(raw?: string | null): string | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    return /^[a-z0-9_-]+$/i.test(trimmed) ? trimmed : null;
  }

  function hasRobotMention(body: string): boolean {
    const robotIdentity = store.getIdentityByKind('robot');
    const tokens = new Set<string>(['robot']);
    if (robotIdentity?.username) {
      tokens.add(robotIdentity.username);
    }
    const displayToken = normalizeMentionToken(robotIdentity?.display_name);
    if (displayToken) {
      tokens.add(displayToken);
    }
    for (const token of tokens) {
      // Allow common punctuation before @mentions (e.g. "(@robot)" or "hello,@robot"),
      // while avoiding matching inside email addresses / words.
      const pattern = new RegExp(`(^|[^\\w])@${escapeRegExp(token)}(\\b|$)`, 'i');
      if (pattern.test(body)) {
        return true;
      }
    }
    return false;
  }

  function emitNotification(identityId: string, payload: unknown) {
    bus.emit(`notify:${identityId}`, { type: 'notification', data: payload });
  }

  app.get('/forums', async (request) => {
    const identity = getIdentityFromRequest(request);
    const query = request.query as {
      parentForumId?: string;
      status?: 'active' | 'archived';
      includeArchived?: string;
    };
    const includeArchived = query?.includeArchived === 'true' || query?.includeArchived === '1';
    const parentForumId =
      query?.parentForumId !== undefined
        ? query.parentForumId === '' || query.parentForumId === 'null'
          ? null
          : query.parentForumId
        : undefined;
    const listOptions: { parentForumId?: string | null; status?: 'active' | 'archived'; includeArchived?: boolean } =
      {};
    if (parentForumId !== undefined) listOptions.parentForumId = parentForumId;
    if (query?.status !== undefined) listOptions.status = query.status;
    listOptions.includeArchived = includeArchived;
    const forums = store.listForums(listOptions);
    const visibleForums = forums.filter((row) => canViewForum(row, identity));
    const forumStatsById = store.getForumStatsForForums(visibleForums.map((row) => row.id));
    return visibleForums.map((row) => {
      const stats = forumStatsById.get(row.id) ?? {
        threadCount: 0,
        postCount: 0,
        lastPost: null,
      };
      return {
        id: row.id,
        tenantId: row.tenant_id,
        parentForumId: row.parent_forum_id,
        category: row.category,
        name: row.name,
        description: row.description,
        status: row.status,
        visibility: row.visibility,
        archivedAt: row.archived_at,
        threadCount: stats.threadCount,
        postCount: stats.postCount,
        lastPost: stats.lastPost,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  });

  app.get('/posts/recent', async (request) => {
    const identity = getIdentityFromRequest(request);
    const query = request.query as { limit?: string };
    const requestedLimit = Number(query?.limit ?? 3);
    const safeLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.trunc(requestedLimit))) : 3;
    const fetchLimit = Math.min(50, safeLimit * 5);
    const rows = store.listRecentPosts(fetchLimit);
    const visible = rows.filter((row) =>
      canViewForum({ visibility: row.forum_visibility, tenant_id: row.forum_tenant_id }, identity)
    );
    return visible.slice(0, safeLimit).map((row) => ({
      postId: row.post_id,
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      forumId: row.forum_id,
      forumName: row.forum_name,
      authorId: row.author_id,
      authorName: row.author_name,
      body: row.body,
      createdAt: row.created_at,
    }));
  });

  app.get('/leaders', async (request) => {
    const identity = getIdentityFromRequest(request);
    const query = request.query as { limit?: string };
    const requestedLimit = Number(query?.limit ?? 5);
    const safeLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.trunc(requestedLimit))) : 5;

    const includeMembersForums = Boolean(identity);
    const includeAdminForums = Boolean(
      identity &&
        (identity.kind === 'admin' ||
          store.hasPermission(identity.id, 'admin.all', identity.tenant_id) ||
          store.hasPermission(identity.id, 'admin.read', identity.tenant_id) ||
          store.hasPermission(identity.id, '*', identity.tenant_id))
    );

    const leaders = store.listForumLeaders({
      limit: safeLimit,
      includeMembersForums,
      includeAdminForums,
    });

    return {
      leaders: leaders.map(({ identity, postCount }) => ({
        identityId: identity.id,
        displayName: identity.display_name,
        kind: identity.kind,
        avatarUrl: identity.avatar_url,
        postCount,
      })),
    };
  });

  app.post('/forums', async (request) => {
    requireAdmin(request);
    const body = request.body as {
      name?: string;
      description?: string | null;
      parentForumId?: string | null;
      category?: string | null;
      visibility?: 'public' | 'members' | 'admin';
    };
    if (!body?.name) {
      throw app.httpErrors.badRequest('name is required');
    }
    const forum = store.createForum(
      body.name,
      body.description ?? null,
      null,
      body.parentForumId ?? null,
      body.category ?? null,
      'active',
      body.visibility ?? 'public',
      null
    );
    return {
      id: forum.id,
      tenantId: forum.tenant_id,
      parentForumId: forum.parent_forum_id,
      category: forum.category,
      name: forum.name,
      description: forum.description,
      status: forum.status,
      visibility: forum.visibility,
      archivedAt: forum.archived_at,
      threadCount: 0,
      postCount: 0,
      lastPost: null,
      createdAt: forum.created_at,
      updatedAt: forum.updated_at,
    };
  });

  app.get('/forums/:forumId/topics', async (request) => {
    const { forumId } = request.params as { forumId: string };
    const identity = getIdentityFromRequest(request);
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    requireForumVisible(forum, identity);
    const page = Number((request.query as { page?: string }).page ?? 1);
    const pageSize = Number((request.query as { pageSize?: string }).pageSize ?? 50);
    const topics = store.listTopics(forumId, page, pageSize);
    const topicStatsById = store.getTopicStatsForTopics(topics.map((row) => row.id));
    const authorIds = topics.map((row) => row.created_by).filter((id): id is string => Boolean(id));
    const authorsById = store.getIdentitiesByIds(authorIds);
    return {
      page,
      pageSize,
      total: topics.length,
      items: topics.map((row) => {
        const stats = topicStatsById.get(row.id) ?? {
          postCount: 0,
          lastPostAuthorId: null,
          lastPostAuthorName: null,
          lastPostAt: null,
        };
        const author = authorsById.get(row.created_by);
        return {
          id: row.id,
          forumId: row.forum_id,
          tenantId: row.tenant_id,
          title: row.title,
          status: row.status,
          tags: JSON.parse(row.tags_json),
          robotMode: row.robot_mode,
          autoCompactEnabled: Boolean(row.auto_compact_enabled),
          autoCompactRevision: row.auto_compact_revision,
          createdBy: row.created_by,
          createdByName: author?.display_name ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          postCount: stats.postCount,
          lastPostAuthorId: stats.lastPostAuthorId,
          lastPostAuthorName: stats.lastPostAuthorName,
          lastPostAt: stats.lastPostAt,
        };
      }),
    };
  });

  app.post(
    '/forums/:forumId/topics',
    {
      config: {
        rateLimit: featureFlags.enableRateLimiting ? { max: 4, timeWindow: '1 minute' } : false,
      },
    },
    async (request) => {
      // Require authentication for creating topics
      const user = requireScope(getCurrentUser(request), 'write');

      const { forumId } = request.params as { forumId: string };
      const forum = store.getForum(forumId);
      if (!forum) {
        throw app.httpErrors.notFound('Forum not found');
      }
      const identity = store.getIdentity(user.identityId);
      if (!canCreateTopic(forum, identity)) {
        throw app.httpErrors.forbidden('Posting not allowed in this forum');
      }
      const body = parseBody(app, CreateTopicRequestSchema, request.body);
      if (body.draft && user.authType !== 'session') {
        throw app.httpErrors.forbidden('Private drafts require a browser session');
      }
      const robotMode = resolveRobotMode(body.robotMode ?? null);
      if (body.autoCompactEnabled !== undefined) requireAdmin(request);
      const deferRobot = Boolean(body.attachmentsPending) && !body.silent;
      const shouldDispatchRobot =
        !body.silent && !deferRobot && robotMode !== 'off' && (robotMode !== 'mention' || hasRobotMention(body.body));
      let creation: ReturnType<ForumStore['createTopic']>;
      try {
        creation = store.runInTransaction(() => {
          const created = store.createTopic({
        forumId,
        title: body.title,
        body: body.body,
        authorId: user.identityId,
        silent: Boolean(body.silent) || deferRobot,
        robotMode,
        autoCompactEnabled: body.autoCompactEnabled ?? false,
            draft: body.draft,
      });
          const { topic, post } = created;
      store.upsertTopicSubscription({ identityId: user.identityId, topicId: topic.id, mode: 'watching' });
      store.upsertTopicRead({
        identityId: user.identityId,
        topicId: topic.id,
        lastReadPostId: post.id,
        lastReadAt: post.created_at,
      });
      const session = store.ensureSession({ topicId: topic.id });
      store.createSessionMessage(session.id, 'user', body.body, 'public');
      if (shouldDispatchRobot) {
        store.createPostDispatch({
          topicId: topic.id,
          postId: post.id,
          sessionId: session.id,
          mode: 'auto',
          model: body.model?.trim() || null,
          reasoningEffort: body.reasoningEffort?.trim() || null,
        });
      }
          return created;
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'draft changed in another session')
          throw app.httpErrors.conflict(error.message);
        throw error;
      }
      const { topic, post } = creation;

      if (shouldDispatchRobot) {
        try {
          postDispatchService?.wake();
        } catch (error) {
          request.log.error({ err: error, topicId: topic.id }, 'Failed to wake post dispatch after topic commit');
        }
      }
      try {
      webhookService.dispatch('topic.created', {
        topic: {
          id: topic.id,
          forumId: topic.forum_id,
          title: topic.title,
          status: topic.status,
          createdBy: topic.created_by,
          createdAt: topic.created_at,
        },
        post: {
          id: post.id,
          topicId: post.topic_id,
          authorId: post.author_id,
          body: post.body,
          createdAt: post.created_at,
        },
      });
      } catch (error) {
        request.log.error({ err: error, topicId: topic.id }, 'Failed to enqueue topic webhook after commit');
      }

      return serializeTopicWithPublicLineage(topic, request);
    }
  );

  app.get('/topics/:topicId', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(topic.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(topic, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    return serializeTopicWithPublicLineage(topic, request);
  });

  app.get('/topics/:topicId/operational-events', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const includeDetail = Boolean(getIdentityFromRequest(request));
    return {
      items: store
        .listTopicOperationalEvents(topicId)
        .map((event) => mapTopicOperationalEventToDto(event, includeDetail)),
    };
  });

  app.get('/topics/:topicId/compactions', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!compactionService) throw app.httpErrors.serviceUnavailable('Compaction service is unavailable');
    return mapTopicCompactionStateToDto(compactionService.getState(topicId));
  });

  app.post('/topics/:topicId/compactions', async (request, reply) => {
    const user = requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!compactionService) throw app.httpErrors.serviceUnavailable('Compaction service is unavailable');
    const parsed = CreateCompactionRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid compaction request');
    try {
      const operation = await compactionService.enqueue({
        operationId: parsed.data.operationId,
        topicId,
        initiatedBy: user.identityId,
        customInstructions: parsed.data.customInstructions,
        recoveryPrompt: parsed.data.recoveryPrompt,
      });
      reply.code(202);
      reply.header('Location', `${request.url}/${encodeURIComponent(operation.id)}`);
      return mapCompactionOperationToDto(operation);
    } catch (error) {
      if (error instanceof CompactionConflictError) throw app.httpErrors.conflict(error.message);
      throw error;
    }
  });

  app.get('/topics/:topicId/compactions/:operationId', async (request) => {
    requireAdmin(request);
    const { topicId, operationId } = request.params as { topicId: string; operationId: string };
    requireTopicVisible(topicId, request);
    if (!compactionService) throw app.httpErrors.serviceUnavailable('Compaction service is unavailable');
    try {
      return mapCompactionOperationToDto(compactionService.get(topicId, operationId));
    } catch (error) {
      if (error instanceof CompactionNotFoundError) throw app.httpErrors.notFound(error.message);
      throw error;
    }
  });

  app.post('/topics/:topicId/compactions/:operationId/retry-checkpoint', async (request) => {
    requireAdmin(request);
    const { topicId, operationId } = request.params as { topicId: string; operationId: string };
    requireTopicVisible(topicId, request);
    if (!compactionService) throw app.httpErrors.serviceUnavailable('Compaction service is unavailable');
    try {
      return mapTopicCompactionStateToDto(compactionService.retryCheckpoint(topicId, operationId));
    } catch (error) {
      if (error instanceof CompactionNotFoundError) throw app.httpErrors.notFound(error.message);
      if (error instanceof CompactionConflictError) throw app.httpErrors.conflict(error.message);
      throw error;
    }
  });

  app.get('/topics/:topicId/forks', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!forkService) throw app.httpErrors.serviceUnavailable('Fork service is unavailable');
    const state = forkService.state(topicId);
    return {
      active: state.active ? mapForkOperationToDto(state.active) : null,
      latest: state.latest ? mapForkOperationToDto(state.latest) : null,
    };
  });

  app.get('/topics/:topicId/forks/boundaries', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!forkService) throw app.httpErrors.serviceUnavailable('Fork service is unavailable');
    return {
      items: forkService.boundaries(topicId).map((boundary) => ({
        postId: boundary.postId,
        postNumber: boundary.postNumber,
        excerpt: boundary.excerpt,
        body: boundary.body,
      })),
    };
  });

  app.post('/topics/:topicId/forks', async (request, reply) => {
    const user = requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!forkService) throw app.httpErrors.serviceUnavailable('Fork service is unavailable');
    const parsed = CreateForkRequestSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid fork request');
    try {
      const operation = await forkService.enqueue({
        operationId: parsed.data.operationId,
        topicId,
        boundaryPostId: parsed.data.boundaryPostId,
        initiatedBy: user.identityId,
        title: parsed.data.title,
        openingBody: parsed.data.openingBody,
      });
      reply.code(202);
      reply.header('Location', `${request.url}/${encodeURIComponent(operation.id)}`);
      return mapForkOperationToDto(operation);
    } catch (error) {
      if (error instanceof ForkConflictError) throw app.httpErrors.conflict(error.message);
      throw error;
    }
  });

  app.get('/topics/:topicId/forks/:operationId', async (request) => {
    requireAdmin(request);
    const { topicId, operationId } = request.params as { topicId: string; operationId: string };
    requireTopicVisible(topicId, request);
    if (!forkService) throw app.httpErrors.serviceUnavailable('Fork service is unavailable');
    try {
      return mapForkOperationToDto(forkService.get(topicId, operationId));
    } catch (error) {
      if (error instanceof ForkNotFoundError) throw app.httpErrors.notFound(error.message);
      throw error;
    }
  });

  app.post('/topics/:topicId/handoff/draft', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) throw app.httpErrors.notFound('topic not found');
    const forum = store.getForum(topic.forum_id);
    if (!forum) throw app.httpErrors.notFound('forum not found');
    const identity = store.getIdentity(user.identityId);
    if (!canViewTopic(topic, forum, identity)) throw app.httpErrors.notFound('topic not found');
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Handoff is unavailable while conversation compaction is in progress');
    }

    const body = request.body as {
      goal?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      systemPrompt?: string | null;
    };
    const goal = body.goal?.trim();
    if (!goal) throw app.httpErrors.badRequest('goal is required');
    if (body.systemPrompt && body.systemPrompt.length > 20000)
      throw app.httpErrors.badRequest('system prompt is too long');

    return codex.generateHandoffDraft(topicId, {
      goal,
      model: body.model?.trim() || null,
      reasoningEffort: body.reasoningEffort?.trim() || null,
      systemPrompt: body.systemPrompt?.trim() || null,
    });
  });

  app.post('/topics/:topicId/handoff', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
    const sourceTopic = store.getTopic(topicId);
    if (!sourceTopic) throw app.httpErrors.notFound('topic not found');
    const sourceForum = store.getForum(sourceTopic.forum_id);
    if (!sourceForum) throw app.httpErrors.notFound('forum not found');
    const identity = store.getIdentity(user.identityId);
    if (!canViewTopic(sourceTopic, sourceForum, identity)) throw app.httpErrors.notFound('topic not found');
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Handoff is unavailable while conversation compaction is in progress');
    }

    const body = request.body as {
      title?: string;
      draft?: string;
      forumId?: string;
      cwd?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
    };
    const title = body.title?.trim();
    const draft = body.draft?.trim();
    if (!title || title.length < 3) throw app.httpErrors.badRequest('title is required');
    if (!draft || draft.length < 10) throw app.httpErrors.badRequest('draft is required');

    const destinationForumId = body.forumId?.trim() || sourceTopic.forum_id;
    const destinationForum = store.getForum(destinationForumId);
    if (!destinationForum) throw app.httpErrors.notFound('destination forum not found');
    if (!canCreateTopic(destinationForum, identity))
      throw app.httpErrors.forbidden('Posting not allowed in destination forum');

    const sourceLink = store.getPiSessionLinkByTopic(topicId);
    if (!sourceLink)
      throw app.httpErrors.badRequest(
        'Source topic is not linked to a canonical Pi session yet. Generate a draft first, then retry.'
      );

    const { topic, post } = store.createTopic({
      forumId: destinationForumId,
      title,
      body: draft,
      authorId: user.identityId,
      silent: false,
      robotMode: 'auto',
    });
    store.upsertTopicSubscription({ identityId: user.identityId, topicId: topic.id, mode: 'watching' });
    store.upsertTopicRead({
      identityId: user.identityId,
      topicId: topic.id,
      lastReadPostId: post.id,
      lastReadAt: post.created_at,
    });
    const session = store.ensureSession({ topicId: topic.id });
    store.createSessionMessage(session.id, 'user', draft, 'public');

    const cwd = body.cwd?.trim() || destinationForum.cwd || sourceLink.cwd || sourceForum.cwd || undefined;
    const launchModel = body.model?.trim() || null;
    const launchReasoningEffort = body.reasoningEffort?.trim() || null;
    let launchError: { message: string } | null = null;

    try {
      await codex.createLinkedHandoffConversation(topic.id, {
        parentPiSessionId: sourceLink.pi_session_id,
        parentPiSessionPath: sourceLink.pi_session_path,
        cwd: cwd ?? '',
        model: launchModel,
        reasoningEffort: launchReasoningEffort,
      });

      await codex.sendUserMessage(topic.id, draft, post.id, {
        model: launchModel,
        reasoningEffort: launchReasoningEffort,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to launch handoff turn.';
      launchError = { message };
      store.upsertRobotState({
        topicId: topic.id,
        sessionId: session.id,
        activity: 'idle',
        model: launchModel,
        reasoningEffort: launchReasoningEffort,
        currentPlanId: null,
      });
      const robotState = store.setRobotTurnError(topic.id, { message, postId: post.id });
      bus.emit(topic.id, {
        type: 'state',
        data: {
          topicId: topic.id,
          sessionId: session.id,
          activity: 'idle',
          model: launchModel,
          reasoningEffort: launchReasoningEffort,
          lastUpdatedAt: robotState?.last_updated_at ?? null,
          lastTurnError:
            robotState?.last_error_message && robotState.last_error_at
            ? {
                message: robotState.last_error_message,
                at: robotState.last_error_at,
                postId: robotState.last_error_post_id ?? null,
                turnId: robotState.last_error_turn_id ?? null,
              }
            : { message, at: new Date().toISOString(), postId: post.id, turnId: null },
          currentPlan: null,
          recentToolRuns: [],
        },
      });
    }

    webhookService.dispatch('topic.created', {
      topic: {
        id: topic.id,
        forumId: topic.forum_id,
        title: topic.title,
        status: topic.status,
        createdBy: topic.created_by,
        createdAt: topic.created_at,
      },
      post: {
        id: post.id,
        topicId: post.topic_id,
        authorId: post.author_id,
        body: post.body,
        createdAt: post.created_at,
      },
    });

    return { topic: serializeTopicWithPublicLineage(topic, request), post: serializePost(post), launchError };
  });

  app.patch('/topics/:topicId/status', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const body = request.body as { status?: string };
    if (!body?.status) {
      throw app.httpErrors.badRequest('status is required');
    }
    if (!['open', 'locked', 'archived'].includes(body.status)) {
      throw app.httpErrors.badRequest('status must be one of: open, locked, archived');
    }
    const existing = store.getTopic(topicId);
    if (!existing) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(existing.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(existing, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    requireModerator(request, existing.tenant_id);
    if (store.hasForkFence(topicId) || (store.hasCompactionFence(topicId) && body.status !== 'open')) {
      throw app.httpErrors.conflict('Topic status cannot be changed while the canonical conversation is fenced');
    }

    try {
      const topic = store.updateTopicStatus(topicId, body.status as 'open' | 'locked' | 'archived');
      return serializeTopicWithPublicLineage(topic, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'topic not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.patch('/topics/:topicId', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const body = request.body as { title?: string };
    if (!body?.title) {
      throw app.httpErrors.badRequest('title is required');
    }
    const existing = store.getTopic(topicId);
    if (!existing) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(existing.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(existing, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    requireModerator(request, existing.tenant_id);
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Topic cannot be changed while the canonical conversation is fenced');
    }

    try {
      const topic = store.updateTopicTitle(topicId, body.title);
      return serializeTopicWithPublicLineage(topic, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'topic not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.patch('/topics/:topicId/tags', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const body = request.body as { sticky?: boolean; tags?: string[] };
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(topic.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(topic, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    requireModerator(request, topic.tenant_id);
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Topic cannot be changed while the canonical conversation is fenced');
    }

    if (body?.sticky === undefined && !Array.isArray(body?.tags)) {
      throw app.httpErrors.badRequest('sticky or tags is required');
    }

    const existingTags = JSON.parse(topic.tags_json) as string[];
    let nextTags = Array.isArray(body.tags)
      ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : existingTags;

    if (typeof body.sticky === 'boolean') {
      const tagSet = new Set(nextTags);
      if (body.sticky) {
        tagSet.add('sticky');
      } else {
        tagSet.delete('sticky');
      }
      nextTags = Array.from(tagSet);
    }

    const updated = store.updateTopicTags(topicId, nextTags);
    return serializeTopicWithPublicLineage(updated, request);
  });

  app.delete('/topics/:topicId', async (request) => {
    const { topicId } = request.params as { topicId: string };

    try {
      const topic = store.getTopic(topicId);
      if (!topic) {
        throw new Error('topic not found');
      }
      const forum = store.getForum(topic.forum_id);
      if (!forum) {
        throw new Error('forum not found');
      }
      const identity = getIdentityFromRequest(request);
      if (!canViewTopic(topic, forum, identity)) {
        throw new Error('topic not found');
      }
      requireModerator(request, topic.tenant_id);
      if (store.hasCompactionFence(topicId)) {
        throw app.httpErrors.conflict('Topic cannot be deleted until compaction recovery is dispatched');
      }
      store.deleteTopic(topicId);
      return { ok: true };
    } catch (err) {
      // Preserve Fastify HTTP errors (e.g. forbidden/unauthorized) as-is.
      const maybeHttpError = err as { statusCode?: number } | null;
      if (maybeHttpError?.statusCode) {
        throw err;
      }
      const message = err instanceof Error ? err.message : 'delete failed';
      if (message === 'topic not found') {
        throw app.httpErrors.notFound(message);
      }
      if (message === 'forum not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  app.get('/topics/:topicId/posts', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const page = Number((request.query as { page?: string }).page ?? 1);
    const pageSize = Number((request.query as { pageSize?: string }).pageSize ?? 200);
    const include = ((request.query as { include?: string }).include ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const includeReactions = include.includes('reactions');
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(topic.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = getIdentityFromRequest(request);
    if (!canViewTopic(topic, forum, identity)) {
      throw app.httpErrors.notFound('topic not found');
    }
    const posts = store.listPosts(topicId, page, pageSize);
    const total = store.countPostsByTopic(topicId);

    const reactionCountsMap = includeReactions
      ? store.getReactionCountsForPosts(posts.map((p) => p.id))
      : new Map<string, { emoji: string; count: number }[]>();

    return {
      page,
      pageSize,
      total,
      items: posts.map((row) => ({
        ...serializePost(row),
        reactionCounts: includeReactions ? (reactionCountsMap.get(row.id) ?? []) : undefined,
      })),
    };
  });

  app.post(
    '/topics/:topicId/posts',
    {
      config: {
        rateLimit: featureFlags.enableRateLimiting ? { max: 10, timeWindow: '1 minute' } : false,
      },
    },
    async (request) => {
      // Require authentication for posting
      const user = requireScope(getCurrentUser(request), 'write');

      const { topicId } = request.params as { topicId: string };
      const body = parseBody(app, CreatePostRequestSchema, request.body);
      if (body.draft && user.authType !== 'session') {
        throw app.httpErrors.forbidden('Private drafts require a browser session');
      }
      const topic = store.getTopic(topicId);
      if (!topic) {
        throw app.httpErrors.notFound('topic not found');
      }
      const forum = store.getForum(topic.forum_id);
      if (!forum) {
        throw app.httpErrors.notFound('forum not found');
      }
      const identity = store.getIdentity(user.identityId);
      if (!canPostTopic(topic, forum, identity)) {
        throw app.httpErrors.forbidden('Posting not allowed in this topic');
      }
      if (topic.status === 'locked' || topic.status === 'archived') {
        throw app.httpErrors.forbidden('topic is locked or archived');
      }
      if (store.hasCompactionFence(topicId)) {
        throw app.httpErrors.conflict('Posting is unavailable while conversation compaction is in progress');
      }
      const changingAutoCompact =
        body.autoCompactEnabled !== undefined && body.autoCompactEnabled !== Boolean(topic.auto_compact_enabled);
      if (body.autoCompactEnabled !== undefined) {
        requireAdmin(request);
      }
      if (changingAutoCompact) {
        if (body.autoCompactRevision !== topic.auto_compact_revision) {
          throw app.httpErrors.conflict('Auto-compaction setting changed in another request');
        }
        const state = store.getRobotState(topicId);
        if (
          (state && !['idle', 'stopped'].includes(state.activity)) ||
          store.countActionablePostDispatches(topicId) > 0 ||
          store.hasCompactionFence(topicId)
        ) {
          throw app.httpErrors.conflict('Auto-compaction can only be changed while the topic is idle');
        }
      }
      const robotMode = resolveRobotMode(topic.robot_mode);
      const deferRobot = Boolean(body.attachmentsPending) && !body.silent;
      const shouldDispatchRobot =
        !body.silent &&
        !deferRobot &&
        robotMode !== 'off' &&
        (robotMode !== 'mention' || hasRobotMention(body.body ?? ''));

      let post: ReturnType<ForumStore['createPost']>;
      const committedNotifications: { identityId: string; payload: unknown }[] = [];
      try {
        post = store.runInTransaction(() => {
          const created = store.createPost({
        topicId,
        body: body.body,
        parentPostId: body.parentPostId ?? null,
        authorId: user.identityId,
        autoCompactEnabled: changingAutoCompact ? body.autoCompactEnabled : undefined,
        autoCompactRevision: changingAutoCompact ? body.autoCompactRevision : undefined,
        silent: Boolean(body.silent) || deferRobot,
            draft: body.draft,
      });
      if (!store.getTopicSubscription(user.identityId, topicId)) {
        store.upsertTopicSubscription({ identityId: user.identityId, topicId, mode: 'watching' });
      }
      store.upsertTopicRead({
        identityId: user.identityId,
        topicId,
            lastReadPostId: created.id,
            lastReadAt: created.created_at,
      });
      const session = store.ensureSession({ topicId });
      store.createSessionMessage(session.id, 'user', body.body, 'public');
      if (shouldDispatchRobot) {
        store.createPostDispatch({
          topicId,
              postId: created.id,
          sessionId: session.id,
          mode: 'auto',
          model: body.model?.trim() || null,
          reasoningEffort: body.reasoningEffort?.trim() || null,
        });
          }
          const subscriptions = store.listTopicSubscriptions(topicId, 'watching');
          for (const subscription of subscriptions) {
            if (subscription.identity_id === user.identityId) continue;
            const notification = store.createNotification({
              identityId: subscription.identity_id,
              type: 'post.created',
              actorId: user.identityId,
              topicId,
              postId: created.id,
              payload: { topicId, postId: created.id },
            });
            committedNotifications.push({ identityId: subscription.identity_id, payload: notification });
          }
          return created;
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'draft changed in another session')
          throw app.httpErrors.conflict(error.message);
        throw error;
      }

      if (shouldDispatchRobot) {
        try {
          postDispatchService?.wake();
        } catch (error) {
          request.log.error(
            { err: error, topicId, postId: post.id },
            'Failed to wake post dispatch after reply commit'
          );
        }
      }
      try {
      webhookService.dispatch('post.created', {
        post: {
          id: post.id,
          topicId: post.topic_id,
          parentPostId: post.parent_post_id,
          authorId: post.author_id,
          body: post.body,
          createdAt: post.created_at,
        },
      });
      } catch (error) {
        request.log.error({ err: error, topicId, postId: post.id }, 'Failed to enqueue post webhook after commit');
      }
      for (const notification of committedNotifications) {
        try {
          emitNotification(notification.identityId, notification.payload);
        } catch (error) {
          request.log.error(
            { err: error, topicId, postId: post.id, identityId: notification.identityId },
            'Failed to emit committed post notification'
          );
        }
      }

      return serializePost(post);
    }
  );

  app.post('/posts/:postId/dispatch', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { postId } = request.params as { postId: string };
    const body = request.body as { model?: string | null; reasoningEffort?: string | null };

    const post = store.getPost(postId);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(post.topic_id, request);

    if (post.author_id !== user.identityId) {
      throw app.httpErrors.forbidden('Only the post author can dispatch this post');
    }
    if (post.deleted_at) {
      throw app.httpErrors.badRequest('post has been deleted');
    }

    const topic = store.getTopic(post.topic_id);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const forum = store.getForum(topic.forum_id);
    if (!forum) {
      throw app.httpErrors.notFound('forum not found');
    }
    const identity = store.getIdentity(user.identityId);
    if (!canPostTopic(topic, forum, identity)) {
      throw app.httpErrors.forbidden('Posting not allowed in this topic');
    }
    if (topic.status === 'locked' || topic.status === 'archived') {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    if (store.hasCompactionFence(topic.id)) {
      throw app.httpErrors.conflict('Dispatch is unavailable while conversation compaction is in progress');
    }

    const robotMode = resolveRobotMode(topic.robot_mode);
    const shouldDispatchRobot = robotMode !== 'off' && (robotMode !== 'mention' || hasRobotMention(post.body ?? ''));

    if (!shouldDispatchRobot) {
      if (post.silent) {
        store.setPostSilent(postId, false);
      }
      return { ok: true, dispatched: false, post: serializePost(store.getPost(postId)!) };
    }

    if (post.silent) {
      store.setPostSilent(postId, false);
    }

    const session = store.ensureSession({ topicId: topic.id });
    store.createPostDispatch({
      topicId: topic.id,
      postId,
      sessionId: session.id,
      mode: 'auto',
      model: body.model?.trim() || null,
      reasoningEffort: body.reasoningEffort?.trim() || null,
    });
    postDispatchService?.wake();

    return { ok: true, dispatched: true, post: serializePost(store.getPost(postId)!) };
  });

  app.patch('/posts/:postId', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { postId } = request.params as { postId: string };
    const body = request.body as { body?: string };
    if (!body?.body) {
      throw app.httpErrors.badRequest('body is required');
    }

    const existingPost = store.getPost(postId);
    if (!existingPost) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(existingPost.topic_id, request);
    if (existingPost.author_id !== user.identityId) {
      // Intentionally do not allow admins/moderators to edit other users' posts.
      throw app.httpErrors.forbidden('Only the post author can edit this post');
    }

    const topic = store.getTopic(existingPost.topic_id);
    if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    if (store.hasCompactionFence(existingPost.topic_id)) {
      throw app.httpErrors.conflict('Posts cannot be changed until compaction recovery is dispatched');
    }

    try {
      const post = store.updatePost(postId, { body: body.body });

      // Dispatch webhook for post update
      webhookService.dispatch('post.updated', {
        post: {
          id: post.id,
          topicId: post.topic_id,
          parentPostId: post.parent_post_id,
          authorId: post.author_id,
          body: post.body,
          createdAt: post.created_at,
          editedAt: post.edited_at,
        },
      });

      return serializePost(post);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      throw app.httpErrors.badRequest(message);
    }
  });

  app.delete('/posts/:postId', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { postId } = request.params as { postId: string };

    const existingPost = store.getPost(postId);
    if (!existingPost) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(existingPost.topic_id, request);
    if (existingPost.author_id !== user.identityId) {
      // Deleting someone else's post is restricted to admins.
      requireAdmin(request);
    }

    const topic = store.getTopic(existingPost.topic_id);
    if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    if (store.hasCompactionFence(existingPost.topic_id)) {
      throw app.httpErrors.conflict('Posts cannot be changed until compaction recovery is dispatched');
    }

    try {
      const post = store.softDeletePost(postId);

      // Dispatch webhook for post deletion
      webhookService.dispatch('post.deleted', {
        post: {
          id: post.id,
          topicId: post.topic_id,
          parentPostId: post.parent_post_id,
          authorId: post.author_id,
          deletedAt: post.deleted_at,
        },
      });

      return serializePost(post);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete failed';
      throw app.httpErrors.badRequest(message);
    }
  });

  // Reaction endpoints
  app.post('/posts/:postId/reactions', async (request) => {
    const { postId } = request.params as { postId: string };
    const body = request.body as { emoji?: string };

    if (!body?.emoji) {
      throw app.httpErrors.badRequest('emoji is required');
    }

    requirePostVisible(postId, request);

    // Use current user or fall back to web identity
    const user = getCurrentUser(request);
    const identityId = user?.identityId ?? webIdentityId;

    const reaction = store.addReaction(postId, identityId, body.emoji);

    return {
      id: reaction.id,
      postId: reaction.post_id,
      identityId: reaction.identity_id,
      emoji: reaction.emoji,
      createdAt: reaction.created_at,
    };
  });

  app.delete('/posts/:postId/reactions/:emoji', async (request) => {
    const { postId, emoji } = request.params as { postId: string; emoji: string };

    requirePostVisible(postId, request);

    // Use current user or fall back to web identity
    const user = getCurrentUser(request);
    const identityId = user?.identityId ?? webIdentityId;

    store.removeReaction(postId, identityId, emoji);

    return { ok: true };
  });

  app.get('/posts/:postId/reactions', async (request) => {
    const { postId } = request.params as { postId: string };
    requirePostVisible(postId, request);

    const reactions = store.listReactionsByPost(postId);
    return reactions.map((reaction) => ({
      id: reaction.id,
      postId: reaction.post_id,
      identityId: reaction.identity_id,
      emoji: reaction.emoji,
      createdAt: reaction.created_at,
    }));
  });

  app.get('/posts/:postId/reactions/counts', async (request) => {
    const { postId } = request.params as { postId: string };
    requirePostVisible(postId, request);

    const counts = store.getReactionCounts(postId);
    return counts;
  });
}
