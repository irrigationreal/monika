import type { FastifyInstance } from 'fastify';

import type { AgentBridge } from '../agentBridge';
import type { TopicAutoRunRow } from '../db';
import type { AutoRunDirector } from '../services/autoRunDirector';
import type { ForumStore } from '../store';
import type { StreamBusInterface, StreamEvent } from '../streamBus';
import type { AccessHelpers } from '../utils/access';

const AUTO_RUN_DEFAULTS = {
  enabled: false,
  context: null as string | null,
  worker: 'echs',
  model: null as string | null,
  reasoningEffort: null as string | null,
  maxReplies: 20,
  replyCount: 0,
  status: 'idle',
  lastRunAt: null as string | null,
  lastReplyAt: null as string | null,
  lastSummary: null as string | null,
  lastNotes: null as string | null,
  lastError: null as string | null,
  steerMessage: null as string | null,
};

function normalizeAutoRunModel(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'default') return null;
  return trimmed;
}

function normalizeAutoRunReasoning(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'default') return null;
  return trimmed;
}

function mapPublicRobotActivity(activity: string | null | undefined): 'idle' | 'thinking' {
  if (!activity || activity === 'idle' || activity === 'stopped' || activity === 'error') return 'idle';
  return 'thinking';
}

export interface PublicRobotState {
  topicId: string;
  activity: 'idle' | 'thinking';
  lastUpdatedAt: string | null;
  currentPlan: null;
  recentToolRuns: [];
}

export function redactRobotStateForPublic(
  state: Record<string, unknown> | null | undefined,
  topicId?: string
): PublicRobotState | null {
  if (!state) return null;
  return {
    topicId: String(state['topicId'] ?? state['topic_id'] ?? topicId ?? ''),
    activity: mapPublicRobotActivity(typeof state['activity'] === 'string' ? state['activity'] : null),
    lastUpdatedAt: (state['lastUpdatedAt'] ?? state['last_updated_at'] ?? null) as string | null,
    currentPlan: null,
    recentToolRuns: [],
  };
}

export function redactStreamEventForPublic(event: StreamEvent): StreamEvent | null {
  if (event.type === 'state') {
    return { type: 'state', data: redactRobotStateForPublic(event.data as Record<string, unknown>) };
  }
  if (event.type === 'assistant_message') {
    return { type: 'assistant_message', data: {} };
  }
  if (event.type === 'assistant_reset') {
    return { type: 'assistant_reset', data: {} };
  }
  if (event.type === 'operational_event') {
    return { type: 'operational_event', data: {} };
  }
  return null;
}

function mapTopicAutoRun(row: TopicAutoRunRow | null, topicId: string) {
  if (!row) {
    return {
      topicId,
      ...AUTO_RUN_DEFAULTS,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    topicId: row.topic_id,
    enabled: Boolean(row.enabled),
    context: row.context,
    worker: row.worker,
    model: normalizeAutoRunModel(row.model),
    reasoningEffort: normalizeAutoRunReasoning(row.reasoning_effort),
    maxReplies: row.max_replies,
    replyCount: row.reply_count,
    status: row.status,
    lastRunAt: row.last_run_at,
    lastReplyAt: row.last_reply_at,
    lastSummary: row.last_summary,
    lastNotes: row.last_notes,
    lastError: row.last_error,
    steerMessage: row.steer_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerRobotRoutes({
  app,
  store,
  codex,
  bus,
  access,
  autoRunDirector,
}: {
  app: FastifyInstance;
  store: ForumStore;
  codex: AgentBridge;
  bus: StreamBusInterface;
  access: AccessHelpers;
  autoRunDirector: AutoRunDirector;
}): void {
  const { getCurrentUser, requireScope, canPostTopic, requireTopicVisible, requireAdmin, getIdentityFromRequest } =
    access;

  function canViewTraceDetails(request: Parameters<typeof getCurrentUser>[0]): boolean {
    return Boolean(getIdentityFromRequest(request));
  }

  function canManageAutoRun(request: Parameters<typeof getCurrentUser>[0]): boolean {
    const user = getCurrentUser(request);
    if (!user) return false;
    const identity = store.getIdentity(user.identityId);
    return identity?.kind === 'admin';
  }

  app.get('/topics/:topicId/state', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const canViewTrace = canViewTraceDetails(request);
    const query = request.query as { view?: string; include?: string };
    const view = query?.view?.toLowerCase();
    const include = (query?.include ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const includePlan =
      view === 'full' || view === 'detailed' || include.includes('plan') || include.includes('currentPlan');
    const includeToolRuns =
      view === 'full' || view === 'detailed' || include.includes('toolRuns') || include.includes('recentToolRuns');
    const state = store.getRobotState(topicId);
    const context = (await codex.getTopicContext?.(topicId).catch(() => null)) ?? null;
    if (!state) {
      if (context && canViewTrace)
        return {
          topicId,
          sessionId: null,
          activity: 'idle',
          model: (context as any).model ?? null,
          reasoningEffort: (context as any).thinkingLevel ?? null,
          lastUpdatedAt: null,
          stream: codex.getStreamLiveness(topicId),
          currentPlan: null,
          recentToolRuns: [],
          context,
        };
      return null;
    }
    if (!canViewTrace) {
      return redactRobotStateForPublic(state as unknown as Record<string, unknown>, topicId);
    }
    const plan =
      includePlan && state.activity !== 'idle' && state.current_plan_id ? store.getPlan(state.current_plan_id) : null;
    const toolRuns = includeToolRuns ? store.listToolRuns(topicId, 20) : [];
    return {
      topicId: state.topic_id,
      sessionId: state.session_id,
      activity: state.activity,
      model: state.model,
      reasoningEffort: state.reasoning_effort,
      lastUpdatedAt: state.last_updated_at,
      lastTurnError: state.last_error_message && state.last_error_at
        ? {
            message: state.last_error_message,
            at: state.last_error_at,
            postId: state.last_error_post_id ?? null,
            turnId: state.last_error_turn_id ?? null,
          }
        : null,
      stream: codex.getStreamLiveness(topicId),
      currentPlan: plan
        ? {
            id: plan.id,
            content: plan.content,
            summary: plan.summary,
            reasoningCheckpoints: plan.reasoning_checkpoints_json
              ? (JSON.parse(plan.reasoning_checkpoints_json) as number[])
              : null,
            visibility: plan.visibility,
            createdAt: plan.created_at,
            updatedAt: plan.updated_at,
          }
        : null,
      context,
      recentToolRuns: includeToolRuns
        ? toolRuns.map((run) => ({
            id: run.id,
            tool: run.tool,
            parentPostId: run.parent_post_id,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            exitCode: run.exit_code,
            command: run.command,
            filesTouched: run.files_touched_json ? JSON.parse(run.files_touched_json) : null,
            outputSummary: run.output_summary,
            redactionsApplied: Boolean(run.redactions_applied),
            visibility: run.visibility,
          }))
        : [],
    };
  });

  app.get('/topics/:topicId/auto-run', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    if (!canManageAutoRun(request)) {
      throw app.httpErrors.forbidden('Admin access required');
    }
    const autoRun = store.getTopicAutoRun(topicId);
    return mapTopicAutoRun(autoRun, topicId);
  });

  app.patch('/topics/:topicId/auto-run', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    if (!canManageAutoRun(request)) {
      throw app.httpErrors.forbidden('Admin access required');
    }
    const { topicId } = request.params as { topicId: string };
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

    const body = request.body as {
      enabled?: boolean;
      context?: string | null;
      worker?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      maxReplies?: number | null;
      resetCount?: boolean;
      steerMessage?: string | null;
    };

    // Backwards-compat: older UIs used the literal string "default".
    // Treat that as unset so we fall back to server defaults.
    if (body.model && body.model.trim().toLowerCase() === 'default') {
      body.model = null;
    }
    if (body.reasoningEffort && body.reasoningEffort.trim().toLowerCase() === 'default') {
      body.reasoningEffort = null;
    }

    if (body.worker && body.worker !== 'echs') {
      throw app.httpErrors.badRequest('worker must be echs');
    }
    if (body.maxReplies !== undefined && body.maxReplies !== null && body.maxReplies < 1) {
      throw app.httpErrors.badRequest('maxReplies must be at least 1');
    }
    if (body.enabled && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }

    const existing = store.getTopicAutoRun(topicId);
    const resetCount = body.resetCount === true;
    const nextReplyCount =
      body.resetCount === true ? 0 : body.enabled && existing && !existing.enabled ? 0 : (existing?.reply_count ?? 0);

    const updated = store.upsertTopicAutoRun({
      topicId,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.context !== undefined ? { context: body.context?.trim() ?? null } : {}),
      ...(body.worker !== undefined ? { worker: body.worker } : {}),
      ...(body.model !== undefined ? { model: body.model?.trim() || null } : {}),
      ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort?.trim() || null } : {}),
      ...(body.maxReplies !== undefined && body.maxReplies !== null ? { maxReplies: body.maxReplies } : {}),
      ...(resetCount || (body.enabled && existing && !existing.enabled) ? { replyCount: nextReplyCount } : {}),
      ...(body.steerMessage !== undefined ? { steerMessage: body.steerMessage?.trim() || null } : {}),
    });

    return mapTopicAutoRun(updated, topicId);
  });

  app.post('/topics/:topicId/auto-run/run', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    if (!canManageAutoRun(request)) {
      throw app.httpErrors.forbidden('Admin access required');
    }
    const { topicId } = request.params as { topicId: string };
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
      throw app.httpErrors.conflict('Robot work is unavailable until compaction recovery is dispatched');
    }
    const robotState = store.getRobotState(topicId);
    if (robotState && ['stopping', 'uncertain'].includes(robotState.activity)) {
      throw app.httpErrors.conflict('Cancellation is unresolved; robot dispatch is fenced until Stop succeeds.');
    }

    const body = request.body as { steerMessage?: string | null };
    const result = await autoRunDirector.runManual({
      topicId,
      ...(body?.steerMessage != null ? { steerMessage: body.steerMessage } : {}),
    });
    if (!result.ok) {
      throw app.httpErrors.badRequest(result.message);
    }
    return { ok: true, message: result.message };
  });

  app.post('/topics/:topicId/robot/interrupt', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
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
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Robot control is unavailable until compaction recovery is dispatched');
    }

    return codex.interruptTopic(topicId);
  });

  app.post('/topics/:topicId/robot/close', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
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
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Robot control is unavailable until compaction recovery is dispatched');
    }

    const result = await codex.closeTopic(topicId);
    if (!result.ok) {
      throw app.httpErrors.badRequest(result.message);
    }
    return result;
  });

  app.post('/topics/:topicId/robot/continue', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { topicId } = request.params as { topicId: string };
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
      throw app.httpErrors.conflict('Robot work is unavailable until compaction recovery is dispatched');
    }
    const robotState = store.getRobotState(topicId);
    if (robotState && ['stopping', 'uncertain'].includes(robotState.activity)) {
      throw app.httpErrors.conflict('Cancellation is unresolved; retry Stop before continuing.');
    }

    const parentPostId = store.getLatestHumanPostId(topicId) ?? store.getLatestPostId(topicId);
    const session = store.ensureSession({ topicId });
    store.createSessionMessage(session.id, 'user', 'Continue.', 'internal');

    await codex.sendUserMessage(topicId, 'Continue.', parentPostId, {});
    return { ok: true, message: 'Continue sent.' };
  });

  app.get('/topics/:topicId/state/stream', async (request, reply) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.write('retry: 1000\n\n');

    const keepAliveMs = 15_000;
    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        // Ignore write errors; the close handler will clean up.
      }
    }, keepAliveMs);

    const canViewTrace = canViewTraceDetails(request);
    const unsubscribe = bus.subscribe(topicId, (event) => {
      const outboundEvent = canViewTrace ? event : redactStreamEventForPublic(event);
      if (!outboundEvent) return;
      reply.raw.write(`event: ${outboundEvent.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(outboundEvent.data)}\n\n`);
    });

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get('/topics/:topicId/identities', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const page = Number((request.query as { page?: string }).page ?? 1);
    const pageSize = Number((request.query as { pageSize?: string }).pageSize ?? 100);
    const identities = store.listIdentities(topicId, page, pageSize);
    return {
      page,
      pageSize,
      total: identities.length,
      items: identities.map((row) => {
        const postCount = store.getIdentityPostCount(row.id);
        return {
          id: row.id,
          tenantId: row.tenant_id,
          displayName: row.display_name,
          kind: row.kind,
          parentIdentityId: row.parent_identity_id,
          avatarUrl: row.avatar_url,
          location: row.location,
          signature: row.signature,
          postCount,
          rank: store.getUserRank(postCount),
          joinDate: row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    };
  });

  app.get('/topics/:topicId/personas', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('Topic not found');
    }
    const personas = store.listRobotPersonas(topic.forum_id);
    return {
      items: personas.map((p) => ({
        key: p.key,
        forumId: p.forumId,
        displayName: p.displayName,
        description: p.description,
        accentColor: p.accentColor,
        avatarUrl: p.avatarUrl,
        signature: p.signature,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  });

  app.get('/topics/:topicId/externals', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const refs = store.listExternalRefs(topicId);
    return refs.map((ref) => ({
      id: ref.id,
      surfaceId: ref.surface_id,
      surfaceKind: ref.surface_kind,
      externalId: ref.external_id,
      kind: ref.kind,
      scope: ref.scope,
      scopeKind: ref.scope_kind,
      mappedForumId: ref.mapped_forum_id,
      mappedTopicId: ref.mapped_topic_id,
      mappedPostId: ref.mapped_post_id,
      mappedIdentityId: ref.mapped_identity_id,
    }));
  });

  app.post('/topics/:topicId/externals', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const body = request.body as {
      surfaceId?: string;
      surfaceKind?: string;
      externalId?: string;
      kind?: string;
      scope?: string | null;
      scopeKind?: string | null;
    };

    if (!body?.surfaceId || !body?.surfaceKind || !body?.externalId || !body?.kind) {
      throw app.httpErrors.badRequest('surfaceId, surfaceKind, externalId, and kind are required');
    }

    const ref = store.createExternalRef({
      surfaceId: body.surfaceId,
      surfaceKind: body.surfaceKind,
      externalId: body.externalId,
      kind: body.kind,
      scope: body.scope ?? null,
      scopeKind: body.scopeKind ?? null,
      mappedTopicId: topicId,
    });

    return {
      id: ref.id,
      surfaceId: ref.surface_id,
      surfaceKind: ref.surface_kind,
      externalId: ref.external_id,
      kind: ref.kind,
      scope: ref.scope,
      scopeKind: ref.scope_kind,
      mappedForumId: ref.mapped_forum_id,
      mappedTopicId: ref.mapped_topic_id,
      mappedPostId: ref.mapped_post_id,
      mappedIdentityId: ref.mapped_identity_id,
    };
  });

  app.delete('/externals/:refId', async (request) => {
    requireAdmin(request);
    const { refId } = request.params as { refId: string };
    const ref = store.getExternalRef(refId);
    if (!ref) {
      throw app.httpErrors.notFound('external ref not found');
    }
    store.deleteExternalRef(refId);
    return { ok: true };
  });

  app.get('/topics/:topicId/session', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);
    const session = store.getSessionByTopic(topicId);
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      topicId: session.topic_id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: session.status,
    };
  });

  app.get('/sessions/:sessionId', async (request) => {
    requireAdmin(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = store.getSession(sessionId);
    if (!session) {
      return null;
    }
    requireTopicVisible(session.topic_id, request);
    return {
      id: session.id,
      topicId: session.topic_id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: session.status,
    };
  });

  app.get('/sessions/:sessionId/inspector', async (request) => {
    requireAdmin(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = store.getSession(sessionId);
    if (!session) {
      throw app.httpErrors.notFound('session not found');
    }
    requireTopicVisible(session.topic_id, request);
    const messages = store.listSessionMessages(sessionId);
    const toolRuns = store.listToolRunsBySession(sessionId, 50);
    const plans = store.listPlansBySession(sessionId, 50);
    return {
      session: {
        id: session.id,
        topicId: session.topic_id,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        status: session.status,
      },
      messages: messages.map((msg) => ({
        id: msg.id,
        sessionId: msg.session_id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.created_at,
        visibility: msg.visibility,
      })),
      toolRuns: toolRuns.map((run) => ({
        id: run.id,
        tool: run.tool,
        parentPostId: run.parent_post_id,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        exitCode: run.exit_code,
        command: run.command,
        filesTouched: run.files_touched_json ? JSON.parse(run.files_touched_json) : null,
        outputSummary: run.output_summary,
        redactionsApplied: Boolean(run.redactions_applied),
        visibility: run.visibility,
      })),
      plans: plans.map((plan) => ({
        id: plan.id,
        content: plan.content,
        summary: plan.summary,
        parentPostId: plan.parent_post_id,
        reasoningCheckpoints: plan.reasoning_checkpoints_json
          ? (JSON.parse(plan.reasoning_checkpoints_json) as number[])
          : null,
        visibility: plan.visibility,
        createdAt: plan.created_at,
        updatedAt: plan.updated_at,
      })),
      artifacts: [],
    };
  });
}
