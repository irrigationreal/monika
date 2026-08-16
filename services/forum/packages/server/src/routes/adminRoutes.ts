import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { ForumStore } from '../store';
import type { AgentBridge } from '../agentBridge';
import type { PiSessionSyncService } from '../services/piSessionSyncService';
import type { MessageTamperContext } from '@irrigationreal/codex-forum-core';
import type { AccessHelpers } from '../utils/access';
import { hashPassword } from '../utils/auth';
import { createAutomationRunner, mapRobotAutomation, mapRobotAutomationRun } from '../utils/automation';
import { isSafeAvatarUrl, isSafeHexColor, isValidPersonaKey, RESERVED_PERSONA_NAMES } from '../utils/persona';
import { getTamperPluginDirections, normalizeTamperDirection, serializeTamperConfig } from '../utils/tamper';
import { InMemoryMessageTamperLayer } from '../messageTamper';
import type { RobotSubagentRunDto } from '@irrigationreal/codex-forum-contracts';
import {
  AdminAccessRuleRequestSchema,
  AdminCreateForumRequestSchema,
  AdminCreatePersonaRequestSchema,
  AdminCreateRobotAutomationRequestSchema,
  AdminCreateTamperRequestSchema,
  AdminCreateUserRequestSchema,
  AdminMoveTopicRequestSchema,
  AdminTestTamperRequestSchema,
  AdminUpdateForumRequestSchema,
  AdminUpdatePersonaRequestSchema,
  AdminUpdateRobotAutomationRequestSchema,
  AdminUpdateRobotSettingsRequestSchema,
  AdminUpdateTamperRequestSchema,
  AdminUpdateUserRequestSchema
} from '@irrigationreal/codex-forum-contracts';
import {
  createPromptEnhancerPlugin,
  createPromptEnhancerTestPlugin,
  getTamperPluginCatalog
} from '../tamperPlugins';
import { buildAdminSkillsCatalog } from '../utils/skillsCatalog';
import { mapTopicRowToDomain } from '../mappers/db';
import { mapTopicToDto } from '../mappers/dto';
import type {
  MessageTamperDirection,
  MessageTamperStage
} from '@irrigationreal/codex-forum-core';
import {
  API_BASE_URL,
  AUTOMATION_LOG_DIR,
  COMMIT_SHA,
  ECHS_BASE_URL,
  ECHS_API_TOKEN,
  DEPLOY_LOG,
  DEPLOY_SCRIPT,
  DEPLOY_STATE_FILE,
  DEPLOY_WORKDIR,
  PASSWORD_LOGIN_ENABLED,
  PROMPT_ENHANCER_ENABLED,
  WORK_DIR
} from '../runtimeConfig';
import { readDeployState, writeDeployState } from '../utils/deployState';
import { parseBody } from '../utils/validation';

type RetentionDashboard = { available: boolean; generatedAt: string | null; retentionDays: number; counts: { protected: number; waiting: number; eligible: number; compacted: number; error: number }; trackedRemovableBytes: number; eligibleBytes: number; omitted: number; running: boolean; lastError: string | null };
export function retentionDashboard(summary: Awaited<ReturnType<AgentBridge['getSubagentRetention']>>): RetentionDashboard {
  return { available: true, generatedAt: summary.generatedAt ? new Date(summary.generatedAt).toISOString() : null,
    retentionDays: Math.round(summary.retentionMs / 86_400_000), counts: summary.counts,
    trackedRemovableBytes: summary.bytes.tracked_removable, eligibleBytes: summary.bytes.eligible, omitted: summary.omitted,
    running: summary.running, lastError: summary.last_error ?? null };
}
export function unavailableRetentionDashboard(error: unknown): RetentionDashboard {
  return { available: false, generatedAt: null, retentionDays: 14,
    counts: { protected: 0, waiting: 0, eligible: 0, compacted: 0, error: 0 }, trackedRemovableBytes: 0, eligibleBytes: 0, omitted: 0, running: false,
    lastError: error instanceof Error ? error.message : 'Retention inventory unavailable' };
}

export function groupSubagentRuns(runs: RobotSubagentRunDto[]): {
  blockers: RobotSubagentRunDto[];
  pendingDelivery: RobotSubagentRunDto[];
  history: RobotSubagentRunDto[];
} {
  const blockers = runs.filter((run) => run.blocking === true || run.executionState === 'uncertain' || run.effectsState === 'unknown');
  const blockerIds = new Set(blockers.map((run) => run.runId));
  const pendingDelivery = runs.filter((run) => !blockerIds.has(run.runId) && ['pending', 'unproven'].includes(run.deliveryState ?? ''));
  const pendingIds = new Set(pendingDelivery.map((run) => run.runId));
  const history = runs.filter((run) => !blockerIds.has(run.runId) && !pendingIds.has(run.runId));
  return { blockers, pendingDelivery, history };
}

export function registerAdminRoutes({
  app,
  store,
  db,
  access,
  codex,
  piSessionSync = null
}: {
  app: FastifyInstance;
  store: ForumStore;
  db: Database;
  access: AccessHelpers;
  codex: AgentBridge;
  piSessionSync?: PiSessionSyncService | null;
}): void {
  const { requireAdmin } = access;
  const echsBaseUrl = ECHS_BASE_URL ?? 'http://localhost:0';
  const automationRunner = createAutomationRunner({
    app,
    store,
    apiBaseUrl: API_BASE_URL,
    workDir: WORK_DIR,
    automationLogDir: AUTOMATION_LOG_DIR,
    echs: {
      baseUrl: echsBaseUrl,
      apiToken: ECHS_API_TOKEN
    }
  });

  const deployEnabled = Boolean(DEPLOY_SCRIPT && existsSync(DEPLOY_SCRIPT));
  let deployInProgress = false;

  function resolveCommitSha(): string | null {
    if (COMMIT_SHA?.trim()) return COMMIT_SHA.trim();

    // Best-effort fallback: infer from a local git checkout (if present).
    // This is intentionally defensive: production deploys may not ship with a .git dir.
    try {
      const git = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: DEPLOY_WORKDIR ?? process.cwd(),
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const candidate = (git.stdout ?? '').trim();
      if (/^[0-9a-f]{7,40}$/i.test(candidate)) return candidate;
    } catch {
      // ignore
    }

    return null;
  }

  const commitSha = resolveCommitSha();
  const initialDeployState = readDeployState(DEPLOY_STATE_FILE);
  let lastDeployStartedAt: string | null = initialDeployState?.lastStartedAt ?? null;
  let lastDeployFinishedAt: string | null = initialDeployState?.lastFinishedAt ?? null;
  let lastDeployExitCode: number | null = initialDeployState?.lastExitCode ?? null;
  let lastDeployError: string | null = initialDeployState?.lastError ?? null;
  let deployOnFinishRequestedAt: string | null = initialDeployState?.deployOnFinishRequestedAt ?? null;
  let deployOnFinishLastCheckedAt: string | null = initialDeployState?.deployOnFinishLastCheckedAt ?? null;
  let deployOnFinishLastError: string | null = initialDeployState?.deployOnFinishLastError ?? null;
  let deployOnFinishTimer: ReturnType<typeof setInterval> | null = null;
  let deployOnFinishChecking = false;

  function persistDeployState(): void {
    writeDeployState(DEPLOY_STATE_FILE, {
      lastStartedAt: lastDeployStartedAt, lastFinishedAt: lastDeployFinishedAt,
      lastExitCode: lastDeployExitCode, lastError: lastDeployError, commitSha,
      deployOnFinishRequestedAt, deployOnFinishLastCheckedAt, deployOnFinishLastError
    });
  }

  function getDeployBlockers(): Array<Record<string, unknown>> {
    const blockers: Array<Record<string, unknown>> = [];
    const activeTurns = codex.listActiveTurns();
    const queuedTurns = codex.listQueuedTurns();
    if (activeTurns.length > 0) blockers.push({ code: 'active_robot_turns', count: activeTurns.length });
    if (queuedTurns.length > 0) blockers.push({ code: 'queued_robot_turns', count: queuedTurns.length });

    const actionableDispatches = store.countGlobalActionablePostDispatches();
    if (actionableDispatches > 0) blockers.push({ code: 'actionable_post_dispatches', count: actionableDispatches });

    // Pi sync is telemetry here, not a blocker: deploy-if-safe acquires forum
    // admission, pauses new cycles, and boundedly waits for an in-flight cycle.
    // DB-persisted robot state (ex: waiting). We deliberately ignore "error"
    // states since they are "concluded" from a deploy-safety standpoint.
    const blockingRobotStates = store
      .listRobotStates()
      .filter((state) => !['idle', 'stopped', 'error'].includes(state.activity));
    if (blockingRobotStates.length > 0) {
      blockers.push({ code: 'non_idle_robot_states', count: blockingRobotStates.length });
    }
    return blockers;
  }

  function hasBlockingRobotWork(): boolean {
    return getDeployBlockers().length > 0;
  }

  async function startDeploy(opts: { source: 'manual' | 'on_finish' }): Promise<{ ok: true; startedAt: string; logPath: string }> {
    if (!deployEnabled || !DEPLOY_SCRIPT) {
      throw app.httpErrors.serviceUnavailable('Deploy script not configured');
    }
    if (deployInProgress) {
      throw app.httpErrors.conflict('Deploy already in progress');
    }

    deployInProgress = true;
    lastDeployStartedAt = new Date().toISOString();
    lastDeployError = null;
    try {
      persistDeployState();
    } catch (err) {
      console.warn(
        `Failed to write deploy state file (${DEPLOY_STATE_FILE}):`,
        err instanceof Error ? err.message : err
      );
    }

    try {
      try {
        const { paused, skipped } = await codex.pauseActiveThreads(`deploy:${opts.source}`);
        if (paused > 0 || skipped > 0) {
          console.log(`Paused ${paused} active ECHS thread(s) before deploy (${skipped} idle).`);
        }
      } catch (err) {
        console.warn('Failed to pause ECHS threads before deploy:', err instanceof Error ? err.message : err);
      }

      const logDir = dirname(DEPLOY_LOG);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const logStream = createWriteStream(DEPLOY_LOG, { flags: 'a' });
      logStream.write(`\n[${lastDeployStartedAt}] Deploy started (source=${opts.source})\n`);

      const child = spawn('bash', [DEPLOY_SCRIPT], {
        cwd: DEPLOY_WORKDIR ?? undefined,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (child.stdout) {
        child.stdout.pipe(logStream, { end: false });
      }
      if (child.stderr) {
        child.stderr.pipe(logStream, { end: false });
      }

      child.on('close', (code) => {
        deployInProgress = false;
        const finishedAt = new Date().toISOString();
        lastDeployFinishedAt = finishedAt;
        lastDeployExitCode = typeof code === 'number' ? code : null;
        lastDeployError = null;
        if (opts.source === 'on_finish' && code === 75) {
          deployOnFinishRequestedAt ??= lastDeployStartedAt;
          deployOnFinishLastError = 'Deployment deferred by quiescence (exit 75); it will retry.';
        } else if (opts.source === 'on_finish') {
          deployOnFinishLastError = code === 0 ? null : `Deploy on Finish exited with code ${code ?? 'unknown'}.`;
        }
        try {
          persistDeployState();
        } catch (err) {
          console.warn(
            `Failed to write deploy state file (${DEPLOY_STATE_FILE}):`,
            err instanceof Error ? err.message : err
          );
        }
        logStream.write(`[${finishedAt}] Deploy finished with code ${code ?? 'unknown'}\n`);
        logStream.end();
      });

      child.on('error', (err) => {
        deployInProgress = false;
        const finishedAt = new Date().toISOString();
        lastDeployFinishedAt = finishedAt;
        lastDeployExitCode = null;
        lastDeployError = err instanceof Error ? err.message : 'unknown error';
        if (opts.source === 'on_finish') {
          deployOnFinishRequestedAt ??= lastDeployStartedAt;
          deployOnFinishLastError = lastDeployError;
        }
        try {
          persistDeployState();
        } catch (stateErr) {
          console.warn(
            `Failed to write deploy state file (${DEPLOY_STATE_FILE}):`,
            stateErr instanceof Error ? stateErr.message : stateErr
          );
        }
        logStream.write(`[${finishedAt}] Deploy failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
        logStream.end();
      });

      child.unref();
    } catch (err) {
      deployInProgress = false;
      const message = err instanceof Error ? err.message : 'Failed to start deploy';
      throw app.httpErrors.internalServerError(message);
    }

    return {
      ok: true,
      startedAt: lastDeployStartedAt,
      logPath: DEPLOY_LOG
    };
  }

  function ensureDeployOnFinishTimer(): void {
    if (deployOnFinishTimer) return;
    deployOnFinishTimer = setInterval(() => {
      if (!deployOnFinishRequestedAt || deployInProgress || deployOnFinishChecking || !deployEnabled || !DEPLOY_SCRIPT) return;
      deployOnFinishChecking = true;
      void (async () => {
        deployOnFinishLastCheckedAt = new Date().toISOString();
        if (hasBlockingRobotWork()) { persistDeployState(); return; }
        try {
          const agentd = await codex.getAgentdQuiescence();
          if (agentd['status'] === 'blocked') {
            deployOnFinishLastError = `Waiting for agentd quiescence: ${JSON.stringify(agentd['blockers'] ?? [])}`;
            persistDeployState();
            return;
          }
        } catch (err) {
          deployOnFinishLastError = `Waiting for agentd: ${err instanceof Error ? err.message : String(err)}`;
          persistDeployState();
          return;
        }
        const requestedAt = deployOnFinishRequestedAt;
        deployOnFinishRequestedAt = null;
        deployOnFinishLastError = null;
        persistDeployState();
        try { await startDeploy({ source: 'on_finish' }); }
        catch (err) {
          deployOnFinishRequestedAt = requestedAt;
          deployOnFinishLastError = err instanceof Error ? err.message : 'Failed to start deploy';
          persistDeployState();
        }
      })().catch((err) => {
        deployOnFinishLastError = err instanceof Error ? err.message : String(err);
        try { persistDeployState(); } catch {}
      }).finally(() => { deployOnFinishChecking = false; });
    }, 2_000);
    deployOnFinishTimer.unref?.();
  }
  if (deployOnFinishRequestedAt) ensureDeployOnFinishTimer();

  function getDeployStatus() {
    return {
      enabled: deployEnabled,
      scriptPath: deployEnabled ? DEPLOY_SCRIPT : null,
      logPath: deployEnabled ? DEPLOY_LOG : null,
      running: deployInProgress,
      lastStartedAt: lastDeployStartedAt,
      lastFinishedAt: lastDeployFinishedAt,
      lastExitCode: lastDeployExitCode,
      lastError: lastDeployError,
      commitSha,
      safeToStop: getDeployBlockers().length === 0,
      blockers: getDeployBlockers(),
      robot: {
        activeTurns: codex.listActiveTurns().length,
        queuedTurns: codex.listQueuedTurns().length
      },
      piSessionSync: piSessionSync?.getStatus() ?? { enabled: false, running: false, intervalMs: null },
      deployOnFinishRequestedAt,
      deployOnFinishLastCheckedAt,
      deployOnFinishLastError
    };
  }

  // Admin user management endpoints
  app.get('/admin/users', async (request) => {
    requireAdmin(request);
    const { page = '1', pageSize = '50' } = request.query as { page?: string; pageSize?: string };
    const users = store.listAllIdentities(Number(page), Number(pageSize));
    return {
      items: users.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        username: u.username,
        kind: u.kind,
        parentIdentityId: u.parent_identity_id,
        avatarUrl: u.avatar_url,
        createdAt: u.created_at
      })),
      total: users.length
    };
  });

  app.post('/admin/users', async (request) => {
    requireAdmin(request);
    if (!PASSWORD_LOGIN_ENABLED) throw app.httpErrors.forbidden('Password credentials are disabled');
    const body = parseBody(app, AdminCreateUserRequestSchema, request.body);

    // Check if username taken
    const existing = store.getIdentityByUsername(body.username);
    if (existing) {
      throw app.httpErrors.conflict('Username already taken');
    }

    // Check if displayName taken
    const existingDisplay = store.getIdentityByDisplayName(body.displayName);
    if (existingDisplay) {
      throw app.httpErrors.conflict('Display name already taken');
    }

    const passwordHash = await hashPassword(body.password);
    const identity = store.createIdentityWithPassword(
      body.displayName,
      body.username,
      passwordHash,
      body.kind ?? 'human'
    );

    return {
      id: identity.id,
      displayName: identity.display_name,
      username: identity.username,
      kind: identity.kind,
      parentIdentityId: identity.parent_identity_id,
      avatarUrl: identity.avatar_url,
      createdAt: identity.created_at
    };
  });

  app.patch('/admin/users/:userId', async (request) => {
    requireAdmin(request);
    const { userId } = request.params as { userId: string };
    const body = parseBody(app, AdminUpdateUserRequestSchema, request.body);

    const identity = store.getIdentity(userId);
    if (!identity) {
      throw app.httpErrors.notFound('User not found');
    }

    // Update kind if provided
    if (body.kind) {
      db.prepare('update identities set kind = ?, updated_at = ? where id = ?')
        .run(body.kind, new Date().toISOString(), userId);
    }

    // Update display name if provided
    if (body.displayName) {
      store.updateIdentity(userId, { displayName: body.displayName });
    }

    // Update password if provided and revoke every existing login for the target.
    if (body.password) {
      if (!PASSWORD_LOGIN_ENABLED) throw app.httpErrors.forbidden('Password credentials are disabled');
      const passwordHash = await hashPassword(body.password);
      const target = store.getIdentity(userId);
      if (!target?.username) throw app.httpErrors.badRequest('User does not support password login');
      store.setIdentityPassword(userId, target.username, passwordHash);
      store.deleteAuthSessionsForIdentity(userId);
    }

    const updated = store.getIdentity(userId);
    return {
      id: updated!.id,
      displayName: updated!.display_name,
      username: updated!.username,
      kind: updated!.kind,
      avatarUrl: updated!.avatar_url
    };
  });

  app.delete('/admin/users/:userId', async (request) => {
    const admin = requireAdmin(request);
    const { userId } = request.params as { userId: string };

    // Can't delete yourself
    if (admin.identityId === userId) {
      throw app.httpErrors.badRequest('Cannot delete your own account');
    }

    const identity = store.getIdentity(userId);
    if (!identity) {
      throw app.httpErrors.notFound('User not found');
    }

    // Don't allow deleting the robot
    if (identity.kind === 'robot') {
      throw app.httpErrors.badRequest('Cannot delete the robot identity');
    }

  db.prepare('delete from auth_sessions where identity_id = ?').run(userId);
  db.prepare('delete from refresh_sessions where identity_id = ?').run(userId);
    db.prepare('delete from one_time_links where identity_id = ?').run(userId);
    db.prepare('delete from identity_roles where identity_id = ?').run(userId);
    db.prepare('delete from reactions where identity_id = ?').run(userId);
    db.prepare('delete from invites where created_by = ?').run(userId);
    db.prepare('update external_refs set mapped_identity_id = null where mapped_identity_id = ?').run(userId);

    db.prepare('delete from identities where id = ?').run(userId);
    return { ok: true };
  });

  // Admin forum management endpoints
  app.get('/admin/forums', async (request) => {
    requireAdmin(request);
    const forums = store.listForums({ includeArchived: true });
    return {
      items: forums.map((f) => ({
        id: f.id,
        parentForumId: f.parent_forum_id,
        category: f.category,
        name: f.name,
        description: f.description,
        cwd: f.cwd,
        prePrompt: f.pre_prompt,
        status: f.status,
        visibility: f.visibility,
        archivedAt: f.archived_at,
        topicCount: store.getForumTopicCount(f.id),
        createdAt: f.created_at,
        updatedAt: f.updated_at
      }))
    };
  });

  app.post('/admin/forums', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, AdminCreateForumRequestSchema, request.body);
    const forum = store.createForum(
      body.name.trim(),
      body.description ?? null,
      body.cwd ?? null,
      body.parentForumId ?? null,
      body.category ?? null,
      body.status ?? 'active',
      body.visibility ?? 'public',
      body.prePrompt ?? null
    );
    return {
      id: forum.id,
      parentForumId: forum.parent_forum_id,
      category: forum.category,
      name: forum.name,
      description: forum.description,
      cwd: forum.cwd,
      prePrompt: forum.pre_prompt,
      status: forum.status,
      visibility: forum.visibility,
      archivedAt: forum.archived_at,
      topicCount: 0,
      createdAt: forum.created_at,
      updatedAt: forum.updated_at
    };
  });

  app.patch('/admin/forums/:forumId', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };
    const body = parseBody(app, AdminUpdateForumRequestSchema, request.body);

    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }

    const updates: {
      name?: string;
      description?: string | null;
      cwd?: string | null;
      prePrompt?: string | null;
      parentForumId?: string | null;
      category?: string | null;
      status?: 'active' | 'archived';
      visibility?: 'public' | 'members' | 'admin';
      archivedAt?: string | null;
    } = {};
    if (body.name !== undefined) {
      updates.name = body.name.trim();
    }
    if (body.description !== undefined) {
      updates.description = body.description;
    }
    if (body.cwd !== undefined) {
      updates.cwd = body.cwd;
    }
    if (body.prePrompt !== undefined) {
      updates.prePrompt = body.prePrompt;
    }
    if (body.parentForumId !== undefined) {
      updates.parentForumId = body.parentForumId;
    }
    if (body.category !== undefined) {
      updates.category = body.category;
    }
    if (body.status !== undefined) {
      updates.status = body.status;
    }
    if (body.visibility !== undefined) {
      updates.visibility = body.visibility;
    }
    if (body.archivedAt !== undefined) {
      updates.archivedAt = body.archivedAt;
    }
    const updated = store.updateForum(forumId, updates);

    return {
      id: updated!.id,
      parentForumId: updated!.parent_forum_id,
      category: updated!.category,
      name: updated!.name,
      description: updated!.description,
      cwd: updated!.cwd,
      prePrompt: updated!.pre_prompt,
      status: updated!.status,
      visibility: updated!.visibility,
      archivedAt: updated!.archived_at,
      topicCount: store.getForumTopicCount(forumId),
      createdAt: updated!.created_at,
      updatedAt: updated!.updated_at
    };
  });

  app.delete('/admin/forums/:forumId', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };

    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }

    const topicCount = store.getForumTopicCount(forumId);
    if (topicCount > 0) {
      throw app.httpErrors.badRequest(`Cannot delete forum with ${topicCount} topics. Delete topics first.`);
    }

    const deleted = store.deleteForum(forumId);
    if (!deleted) {
      throw app.httpErrors.internalServerError('Failed to delete forum');
    }

    return { ok: true };
  });

  // Admin forum access rules
  app.get('/admin/forums/:forumId/access', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const rules = store.listAccessRules('forum', forumId);
    return {
      items: rules.map((rule) => ({
        id: rule.id,
        scopeKind: rule.scope_kind,
        scopeId: rule.scope_id,
        principalKind: rule.principal_kind,
        principalId: rule.principal_id,
        action: rule.action,
        effect: rule.effect,
        createdAt: rule.created_at
      }))
    };
  });

  app.post('/admin/forums/:forumId/access', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const body = parseBody(app, AdminAccessRuleRequestSchema, request.body);
    const principalKind = body.principalKind;
    const action = body.action;
    const effect = body.effect;
    let principalId: string | null = body.principalId ?? null;
    if (principalKind === 'all' || principalKind === 'logged_in') {
      principalId = null;
    } else if (!principalId) {
      throw app.httpErrors.badRequest('principalId is required for identity or role');
    } else if (principalKind === 'identity') {
      const identity = store.getIdentity(principalId);
      if (!identity) {
        throw app.httpErrors.badRequest('identity not found');
      }
    } else if (principalKind === 'role') {
      const role = store.getRole(principalId);
      if (!role) {
        throw app.httpErrors.badRequest('role not found');
      }
    }
    const rule = store.createAccessRule({
      scopeKind: 'forum',
      scopeId: forumId,
      principalKind,
      principalId,
      action,
      effect
    });
    return {
      id: rule.id,
      scopeKind: rule.scope_kind,
      scopeId: rule.scope_id,
      principalKind: rule.principal_kind,
      principalId: rule.principal_id,
      action: rule.action,
      effect: rule.effect,
      createdAt: rule.created_at
    };
  });

  app.post('/admin/topics/:topicId/move', async (request) => {
    const admin = requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    const body = parseBody(app, AdminMoveTopicRequestSchema, request.body);
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    if (topic.forum_id === body.forumId) {
      throw app.httpErrors.badRequest('topic is already in that forum');
    }
    const fromForum = store.getForum(topic.forum_id);
    const toForum = store.getForum(body.forumId);
    if (!fromForum) {
      throw app.httpErrors.notFound('source forum not found');
    }
    if (!toForum) {
      throw app.httpErrors.notFound('destination forum not found');
    }

    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('cannot move thread until compaction recovery is dispatched');
    }
    const activeTurn = codex.listActiveTurns().find((turn) => turn.topicId === topicId);
    if (activeTurn) {
      throw app.httpErrors.conflict('cannot move thread while an assistant response is in progress');
    }

    const silent = Boolean(body.silent);
    const adminIdentity = store.getIdentity(admin.identityId);
    const adminName = adminIdentity?.display_name ?? 'admin';
    const movedAt = new Date().toISOString();
    const markerBody = silent
      ? null
      : [
          `Automatic post: This thread was moved from "${fromForum.name}" to "${toForum.name}" by ${adminName} on ${movedAt}.`,
          'AI agents: the working directory context has changed. Files that were previously available may no longer exist in the new forum workspace.'
        ].join('\n');

    const result = store.moveTopic({
      topicId,
      toForumId: body.forumId,
      movedBy: admin.identityId,
      markerBody,
      silent
    });

    const movedTopic = mapTopicRowToDomain(result.topic);
    return {
      topic: mapTopicToDto({ ...movedTopic, robotMode: movedTopic.robotMode ?? null }),
      move: result.move
    };
  });

  // Admin topic access rules
  app.get('/admin/topics/:topicId/access', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const rules = store.listAccessRules('topic', topicId);
    return {
      items: rules.map((rule) => ({
        id: rule.id,
        scopeKind: rule.scope_kind,
        scopeId: rule.scope_id,
        principalKind: rule.principal_kind,
        principalId: rule.principal_id,
        action: rule.action,
        effect: rule.effect,
        createdAt: rule.created_at
      }))
    };
  });

  app.post('/admin/topics/:topicId/access', async (request) => {
    requireAdmin(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) {
      throw app.httpErrors.notFound('topic not found');
    }
    const body = parseBody(app, AdminAccessRuleRequestSchema, request.body);
    const principalKind = body.principalKind;
    const action = body.action;
    const effect = body.effect;
    let principalId: string | null = body.principalId ?? null;
    if (principalKind === 'all' || principalKind === 'logged_in') {
      principalId = null;
    } else if (!principalId) {
      throw app.httpErrors.badRequest('principalId is required for identity or role');
    } else if (principalKind === 'identity') {
      const identity = store.getIdentity(principalId);
      if (!identity) {
        throw app.httpErrors.badRequest('identity not found');
      }
    } else if (principalKind === 'role') {
      const role = store.getRole(principalId);
      if (!role) {
        throw app.httpErrors.badRequest('role not found');
      }
    }
    const rule = store.createAccessRule({
      scopeKind: 'topic',
      scopeId: topicId,
      principalKind,
      principalId,
      action,
      effect
    });
    return {
      id: rule.id,
      scopeKind: rule.scope_kind,
      scopeId: rule.scope_id,
      principalKind: rule.principal_kind,
      principalId: rule.principal_id,
      action: rule.action,
      effect: rule.effect,
      createdAt: rule.created_at
    };
  });

  app.delete('/admin/access/:ruleId', async (request) => {
    requireAdmin(request);
    const { ruleId } = request.params as { ruleId: string };
    const deleted = store.deleteAccessRule(ruleId);
    if (!deleted) {
      throw app.httpErrors.notFound('access rule not found');
    }
    return { ok: true };
  });

  // Admin robot persona management endpoints
  app.get('/admin/forums/:forumId/personas', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const personas = store.listRobotPersonas(forumId);
    return {
      items: personas.map((p) => ({
        key: p.key,
        forumId: p.forumId,
        identityId: p.identityId,
        displayName: p.displayName,
        description: p.description,
        accentColor: p.accentColor,
        avatarUrl: p.avatarUrl,
        signature: p.signature,
        soul: p.soul,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    };
  });

  app.post('/admin/forums/:forumId/personas', async (request) => {
    requireAdmin(request);
    const { forumId } = request.params as { forumId: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const body = parseBody(app, AdminCreatePersonaRequestSchema, request.body);

    const key = body.key.trim();
    const displayName = body.displayName.trim();
    if (!isValidPersonaKey(key)) {
      throw app.httpErrors.badRequest('Invalid persona key (use letters/numbers/_/- up to 32 chars)');
    }
    if (RESERVED_PERSONA_NAMES.has(displayName.toLowerCase())) {
      throw app.httpErrors.badRequest('Persona displayName is reserved');
    }

    const existingDisplay = store.getIdentityByDisplayName(displayName);
    if (existingDisplay) {
      throw app.httpErrors.conflict('Display name already taken');
    }

    const accentColor = body.accentColor?.trim() ? body.accentColor.trim() : null;
    if (accentColor && !isSafeHexColor(accentColor)) {
      throw app.httpErrors.badRequest('accentColor must be a 6-digit hex color like #aabbcc');
    }

    const avatarUrl = body.avatarUrl?.trim() ? body.avatarUrl.trim() : null;
    if (avatarUrl && !isSafeAvatarUrl(avatarUrl)) {
      throw app.httpErrors.badRequest('avatarUrl must be https://, http://, or a /relative path');
    }

    const persona = store.createRobotPersona({
      forumId,
      key,
      displayName,
      description: body.description ?? null,
      accentColor,
      avatarUrl,
      signature: body.signature ?? null,
      soul: body.soul ?? null
    });

    return {
      key: persona.key,
      forumId: persona.forumId,
      identityId: persona.identityId,
      displayName: persona.displayName,
      description: persona.description,
      accentColor: persona.accentColor,
      avatarUrl: persona.avatarUrl,
      signature: persona.signature,
      soul: persona.soul,
      createdAt: persona.createdAt,
      updatedAt: persona.updatedAt
    };
  });

  app.patch('/admin/forums/:forumId/personas/:key', async (request) => {
    requireAdmin(request);
    const { forumId, key } = request.params as { forumId: string; key: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const body = parseBody(app, AdminUpdatePersonaRequestSchema, request.body);

    const displayName = body.displayName !== undefined ? body.displayName.trim() : undefined;
    if (displayName !== undefined && !displayName) {
      throw app.httpErrors.badRequest('displayName cannot be empty');
    }
    if (displayName) {
      if (RESERVED_PERSONA_NAMES.has(displayName.toLowerCase())) {
        throw app.httpErrors.badRequest('Persona displayName is reserved');
      }
      const existing = store.getIdentityByDisplayName(displayName);
      const current = store.getRobotPersona(forumId, key);
      if (existing && current && existing.id !== current.identityId) {
        throw app.httpErrors.conflict('Display name already taken');
      }
    }

    const accentColor = body.accentColor?.trim() ? body.accentColor.trim() : body.accentColor === null ? null : undefined;
    if (accentColor && accentColor !== undefined && !isSafeHexColor(accentColor)) {
      throw app.httpErrors.badRequest('accentColor must be a 6-digit hex color like #aabbcc');
    }

    const avatarUrl = body.avatarUrl?.trim() ? body.avatarUrl.trim() : body.avatarUrl === null ? null : undefined;
    if (avatarUrl && avatarUrl !== undefined && !isSafeAvatarUrl(avatarUrl)) {
      throw app.httpErrors.badRequest('avatarUrl must be https://, http://, or a /relative path');
    }

    const updates: Parameters<typeof store.updateRobotPersona>[2] = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (body.description !== undefined) updates.description = body.description;
    if (accentColor !== undefined) updates.accentColor = accentColor;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
    if (body.signature !== undefined) updates.signature = body.signature;
    if (body.soul !== undefined) updates.soul = body.soul;

    const updated = store.updateRobotPersona(forumId, key, updates);

    return {
      key: updated.key,
      forumId: updated.forumId,
      identityId: updated.identityId,
      displayName: updated.displayName,
      description: updated.description,
      accentColor: updated.accentColor,
      avatarUrl: updated.avatarUrl,
      signature: updated.signature,
      soul: updated.soul,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete('/admin/forums/:forumId/personas/:key', async (request) => {
    requireAdmin(request);
    const { forumId, key } = request.params as { forumId: string; key: string };
    const forum = store.getForum(forumId);
    if (!forum) {
      throw app.httpErrors.notFound('Forum not found');
    }
    const existing = store.getRobotPersona(forumId, key);
    if (!existing) {
      throw app.httpErrors.notFound('Persona not found');
    }
    store.deleteRobotPersona(forumId, key);
    return { ok: true };
  });

  // Admin tamper layer endpoints
  app.get('/admin/tampers/plugins', async (request) => {
    requireAdmin(request);
    return { items: getTamperPluginCatalog() };
  });

  app.get('/admin/skills', async (request) => {
    requireAdmin(request);
    return buildAdminSkillsCatalog({ store });
  });

  app.get('/admin/tampers', async (request) => {
    requireAdmin(request);
    const { forumId } = request.query as { forumId?: string };
    const configs = store.listTamperConfigs(forumId ?? undefined);
    return { items: configs.map(serializeTamperConfig) };
  });

  app.post('/admin/tampers', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, AdminCreateTamperRequestSchema, request.body);
    const pluginKey = body.pluginKey.trim();
    const plugin = getTamperPluginCatalog().find((entry) => entry.key === pluginKey);
    if (!plugin) {
      throw app.httpErrors.badRequest('Unknown pluginKey');
    }
    if (body.onlyFirstMessage !== undefined && body.onlyFirstMessage !== null && typeof body.onlyFirstMessage !== 'boolean') {
      throw app.httpErrors.badRequest('onlyFirstMessage must be a boolean');
    }
    const pluginDirections = getTamperPluginDirections(plugin.stages);
    const allowedDirections =
      pluginDirections.length > 1 ? [...pluginDirections, 'both'] : pluginDirections.length === 1 ? pluginDirections : ['both'];
    const normalizedDirection = normalizeTamperDirection(body.direction);
    const direction =
      normalizedDirection ??
      plugin.defaultDirection ??
      (pluginDirections.length > 1 ? 'both' : pluginDirections[0] ?? 'both');
    if (!allowedDirections.includes(direction)) {
      throw app.httpErrors.badRequest('Invalid direction for plugin');
    }
    const onlyFirstMessage =
      typeof body.onlyFirstMessage === 'boolean'
        ? body.onlyFirstMessage
        : plugin.defaultOnlyFirstMessage ?? false;
    const forumId = body.forumId ?? null;
    if (forumId) {
      const forum = store.getForum(forumId);
      if (!forum) {
        throw app.httpErrors.badRequest('Forum not found');
      }
    }

    const existing = forumId
      ? store.getTamperConfigForForum(forumId, pluginKey, direction)
      : store.getGlobalTamperConfig(pluginKey, direction);
    if (existing) {
      throw app.httpErrors.conflict('Tamper config already exists for that scope');
    }

    const created = store.createTamperConfig({
      forumId,
      pluginKey,
      enabled: body.enabled ?? true,
      priority: body.priority ?? 0,
      direction,
      onlyFirstMessage,
      config: body.config ?? null
    });
    return serializeTamperConfig(created);
  });

  app.patch('/admin/tampers/:configId', async (request) => {
    requireAdmin(request);
    const { configId } = request.params as { configId: string };
    const body = parseBody(app, AdminUpdateTamperRequestSchema, request.body);

    const existing = store.getTamperConfig(configId);
    if (!existing) {
      throw app.httpErrors.notFound('Tamper config not found');
    }
    if (body.onlyFirstMessage !== undefined && body.onlyFirstMessage !== null && typeof body.onlyFirstMessage !== 'boolean') {
      throw app.httpErrors.badRequest('onlyFirstMessage must be a boolean');
    }
    const plugin = getTamperPluginCatalog().find((entry) => entry.key === existing.plugin_key);
    if (!plugin) {
      throw app.httpErrors.badRequest('Unknown pluginKey');
    }
    const pluginDirections = getTamperPluginDirections(plugin.stages);
    const allowedDirections =
      pluginDirections.length > 1 ? [...pluginDirections, 'both'] : pluginDirections.length === 1 ? pluginDirections : ['both'];
    let resolvedDirection: string | null | undefined;
    if (body.direction !== undefined) {
      if (body.direction === null) {
        resolvedDirection = plugin.defaultDirection ?? (pluginDirections.length > 1 ? 'both' : pluginDirections[0] ?? 'both');
      } else {
        const normalized = normalizeTamperDirection(body.direction);
        if (!normalized) {
          throw app.httpErrors.badRequest('Invalid direction');
        }
        resolvedDirection = normalized;
      }
      if (resolvedDirection && !allowedDirections.includes(resolvedDirection)) {
        throw app.httpErrors.badRequest('Invalid direction for plugin');
      }
    }
    let resolvedOnlyFirst: boolean | null | undefined;
    if (body.onlyFirstMessage !== undefined) {
      resolvedOnlyFirst = body.onlyFirstMessage ?? (plugin.defaultOnlyFirstMessage ?? false);
    }

    if (body.forumId !== undefined && body.forumId !== null) {
      const forum = store.getForum(body.forumId);
      if (!forum) {
        throw app.httpErrors.badRequest('Forum not found');
      }
    }

    const nextForumId = body.forumId !== undefined ? body.forumId ?? null : existing.forum_id;
    const nextDirection = resolvedDirection ?? existing.direction ?? plugin.defaultDirection ?? null;
    if (
      nextDirection &&
      (nextDirection !== existing.direction || nextForumId !== existing.forum_id) &&
      (nextForumId
        ? store.getTamperConfigForForum(nextForumId, existing.plugin_key, nextDirection)
        : store.getGlobalTamperConfig(existing.plugin_key, nextDirection))
    ) {
      throw app.httpErrors.conflict('Tamper config already exists for that scope');
    }

    const updates: {
      forumId?: string | null;
      enabled?: boolean;
      priority?: number;
      direction?: string | null;
      onlyFirstMessage?: boolean | null;
      config?: Record<string, unknown> | null;
    } = {};
    if (body.forumId !== undefined) updates.forumId = body.forumId;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (resolvedDirection !== undefined) updates.direction = resolvedDirection;
    if (resolvedOnlyFirst !== undefined) updates.onlyFirstMessage = resolvedOnlyFirst;
    if (body.config !== undefined) updates.config = body.config;

    const updated = store.updateTamperConfig(configId, updates);
    return serializeTamperConfig(updated!);
  });

  app.delete('/admin/tampers/:configId', async (request) => {
    requireAdmin(request);
    const { configId } = request.params as { configId: string };
    const deleted = store.deleteTamperConfig(configId);
    if (!deleted) {
      throw app.httpErrors.notFound('Tamper config not found');
    }
    return { ok: true };
  });

  app.post('/admin/tampers/test', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, AdminTestTamperRequestSchema, request.body);
    const text = body.text;
    const stage = (body.stage ?? 'outbound.codex_to_forum') as MessageTamperStage;
    const direction = (body.direction ?? 'outbound') as MessageTamperDirection;
    const allowedStages: MessageTamperStage[] = [
      'inbound.user_to_codex',
      'outbound.codex_to_forum',
      'outbound.forum_post_body'
    ];
    const allowedDirections: MessageTamperDirection[] = ['inbound', 'outbound'];
    if (!allowedStages.includes(stage)) {
      throw app.httpErrors.badRequest('Invalid stage');
    }
    if (!allowedDirections.includes(direction)) {
      throw app.httpErrors.badRequest('Invalid direction');
    }

    const context = {
      topicId: '',
      sessionId: '',
      forumId: body.forumId ?? null,
      parentPostId: null,
      actorId: null,
      metadata: { isFirstMessage: body.isFirstMessage !== undefined ? Boolean(body.isFirstMessage) : true }
    };

    const testLayer = new InMemoryMessageTamperLayer<MessageTamperContext>({ throwOnError: true });
    const pluginKey = body.pluginKey ?? null;

    if (body.onlyPlugin && pluginKey) {
      if (pluginKey === 'prompt.enhancer') {
        const config = (body.pluginConfig ?? null) as Record<string, unknown> | null;
        testLayer.register(
          createPromptEnhancerTestPlugin({
            config: (config ?? null) as any,
            priority: config && typeof config['priority'] === 'number' ? config['priority'] : 5
          })
        );
      } else {
        throw app.httpErrors.badRequest('Unknown pluginKey');
      }
    } else {
      testLayer.register(
        createPromptEnhancerPlugin({
          store,
          enabledByDefault: PROMPT_ENHANCER_ENABLED,
          defaultPriority: 5,
          defaultOnlyFirstMessage: true
        })
      );
    }

    const result = await testLayer.run({
      stage,
      direction,
      text,
      context
    });

    return {
      inputText: text,
      outputText: result.text,
      tampered: result.tampered,
      trail: result.trail
    };
  });

  // Pi session sync health endpoints
  app.get('/admin/pi-sync/health', async (request) => {
    requireAdmin(request);
    if (!piSessionSync) {
      return {
        enabled: false,
        running: false,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastRunError: null,
        lastRunStats: null,
        counts: {},
        anomalies: []
      };
    }
    return piSessionSync.getHealth();
  });

  app.get('/admin/pi-sync/repair-inventory', async (request) => {
    requireAdmin(request);
    if (!piSessionSync) return { generatedAt: new Date().toISOString(), candidates: [] };
    return piSessionSync.getRepairInventory();
  });

  app.post('/admin/pi-sync/topics/:topicId/bump-repaired', async (request) => {
    requireAdmin(request);
    if (!piSessionSync) throw app.httpErrors.conflict('Pi session sync is disabled.');
    const params = request.params as { topicId: string };
    const result = piSessionSync.bumpRepairedTopic(params.topicId);
    if (!result.ok) throw app.httpErrors.conflict(result.message);
    return result;
  });

  app.post('/admin/pi-sync/run', async (request) => {
    requireAdmin(request);
    if (!piSessionSync) throw app.httpErrors.conflict('Pi session sync is disabled.');
    return piSessionSync.runManualSync();
  });

  app.post('/admin/pi-sync/sessions/:piSessionId/run', async (request) => {
    requireAdmin(request);
    if (!piSessionSync) throw app.httpErrors.conflict('Pi session sync is disabled.');
    const params = request.params as { piSessionId: string };
    return piSessionSync.runManualSync(params.piSessionId);
  });

  app.post('/admin/pi-sync/anomalies/:anomalyId/backfill', async (request) => {
    const user = requireAdmin(request);
    if (!piSessionSync) throw app.httpErrors.conflict('Pi session sync is disabled.');
    const params = request.params as { anomalyId: string };
    const body = (request.body ?? {}) as { bumpTopic?: boolean };
    const result = await piSessionSync.backfillAnomaly(params.anomalyId, {
      bumpTopic: Boolean(body.bumpTopic),
      resolvedBy: user.identityId
    });
    if (!result.ok) throw app.httpErrors.badRequest(result.message);
    return result;
  });

  app.post('/admin/pi-sync/anomalies/:anomalyId/ignore', async (request) => {
    const user = requireAdmin(request);
    if (!piSessionSync) throw app.httpErrors.conflict('Pi session sync is disabled.');
    const params = request.params as { anomalyId: string };
    const body = (request.body ?? {}) as { note?: string | null };
    const result = piSessionSync.ignoreAnomaly(params.anomalyId, user.identityId, body.note ?? null);
    if (!result.ok) throw app.httpErrors.badRequest(result.message);
    return result;
  });

  // Admin deploy endpoints
  app.get('/admin/deploy/status', async (request) => {
    requireAdmin(request);
    return getDeployStatus();
  });

  app.post('/admin/deploy', async (request) => {
    requireAdmin(request);
    return startDeploy({ source: 'manual' });
  });

  app.post('/admin/deploy/on-finish', async (request) => {
    requireAdmin(request);
    if (!deployEnabled || !DEPLOY_SCRIPT) {
      throw app.httpErrors.serviceUnavailable('Deploy script not configured');
    }
    if (deployInProgress) {
      throw app.httpErrors.conflict('Deploy already in progress');
    }

    if (!deployOnFinishRequestedAt) {
      deployOnFinishRequestedAt = new Date().toISOString();
      deployOnFinishLastError = null;
    }

    persistDeployState();
    ensureDeployOnFinishTimer();

    return {
      ok: true,
      requestedAt: deployOnFinishRequestedAt
    };
  });

  app.post('/admin/deploy/on-finish/cancel', async (request) => {
    requireAdmin(request);

    deployOnFinishRequestedAt = null;
    deployOnFinishLastCheckedAt = null;
    deployOnFinishLastError = null;
    persistDeployState();

    return { ok: true };
  });

  // Robot automation endpoints
  app.get('/admin/robot/automations', async (request) => {
    requireAdmin(request);
    const items = store.listRobotAutomations().map(mapRobotAutomation);
    return { items };
  });

  app.post('/admin/robot/automations', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, AdminCreateRobotAutomationRequestSchema, request.body);
    if (body.runMode === 'interval' && (!body.intervalMinutes || body.intervalMinutes < 1)) {
      throw app.httpErrors.badRequest('intervalMinutes must be at least 1');
    }
    if (body.forumId) {
      const forum = store.getForum(body.forumId);
      if (!forum) {
        throw app.httpErrors.badRequest('forumId not found');
      }
    }

    const automation = store.createRobotAutomation({
      name: body.name.trim(),
      forumId: body.forumId ?? null,
      prompt: body.prompt.trim(),
      enabled: body.enabled !== false,
      worker: body.worker ?? 'echs',
      model: body.model ?? null,
      reasoningEffort: body.reasoningEffort ?? null,
      runMode: body.runMode ?? 'manual',
      intervalMinutes: body.runMode === 'interval' ? body.intervalMinutes ?? null : null
    });
    return mapRobotAutomation(automation);
  });

  app.patch('/admin/robot/automations/:automationId', async (request) => {
    requireAdmin(request);
    const { automationId } = request.params as { automationId: string };
    const body = parseBody(app, AdminUpdateRobotAutomationRequestSchema, request.body);
    if (body.runMode === 'interval' && (!body.intervalMinutes || body.intervalMinutes < 1)) {
      throw app.httpErrors.badRequest('intervalMinutes must be at least 1');
    }
    if (body.forumId) {
      const forum = store.getForum(body.forumId);
      if (!forum) {
        throw app.httpErrors.badRequest('forumId not found');
      }
    }

    const updates: {
      name?: string;
      forumId?: string | null;
      prompt?: string;
      enabled?: boolean;
      worker?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      runMode?: string;
      intervalMinutes?: number | null;
    } = {};
    if (body.name !== undefined) updates.name = body.name?.trim();
    if (body.forumId !== undefined) updates.forumId = body.forumId ?? null;
    if (body.prompt !== undefined) updates.prompt = body.prompt?.trim();
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.worker !== undefined) updates.worker = body.worker;
    if (body.model !== undefined) updates.model = body.model ?? null;
    if (body.reasoningEffort !== undefined) updates.reasoningEffort = body.reasoningEffort ?? null;
    if (body.runMode !== undefined) updates.runMode = body.runMode;
    if (body.intervalMinutes !== undefined) {
      updates.intervalMinutes =
        body.runMode === 'interval' ? body.intervalMinutes ?? null : body.intervalMinutes;
    }

    const automation = store.updateRobotAutomation(automationId, updates);
    return mapRobotAutomation(automation);
  });

  app.delete('/admin/robot/automations/:automationId', async (request) => {
    requireAdmin(request);
    const { automationId } = request.params as { automationId: string };
    const existing = store.getRobotAutomation(automationId);
    if (!existing) {
      throw app.httpErrors.notFound('Automation not found');
    }
    store.deleteRobotAutomation(automationId);
    return { ok: true };
  });

  app.post('/admin/robot/automations/:automationId/run', async (request) => {
    requireAdmin(request);
    const { automationId } = request.params as { automationId: string };
    const automation = store.getRobotAutomation(automationId);
    if (!automation) {
      throw app.httpErrors.notFound('Automation not found');
    }
    if (!automation.enabled) {
      throw app.httpErrors.badRequest('Automation is disabled');
    }
    automationRunner.startRun(automationId);
    return { ok: true };
  });

  app.get('/admin/robot/automations/:automationId/runs', async (request) => {
    requireAdmin(request);
    const { automationId } = request.params as { automationId: string };
    const runs = store.listRobotAutomationRuns(automationId, 20).map(mapRobotAutomationRun);
    return { items: runs };
  });

  app.get('/admin/robot/automations/runs/:runId/log', async (request) => {
    requireAdmin(request);
    const { runId } = request.params as { runId: string };
    const { offset, tail } = request.query as { offset?: string; tail?: string };
    const run = store.getRobotAutomationRun(runId);
    if (!run) {
      throw app.httpErrors.notFound('Automation run not found');
    }
    if (!run.log_path || !existsSync(run.log_path)) {
      return { content: '', nextOffset: 0, size: 0, startOffset: 0, eof: true };
    }
    const stat = await fs.stat(run.log_path);
    const size = stat.size;
    const maxBytes = 20000;
    let startOffset = Number(offset);
    if (!Number.isFinite(startOffset) || Number.isNaN(startOffset)) {
      startOffset = 0;
    }
    if (tail === '1' || tail === 'true') {
      startOffset = Math.max(0, size - maxBytes);
    }
    if (startOffset < 0) startOffset = 0;
    if (startOffset > size) {
      return { content: '', nextOffset: size, size, startOffset, eof: true };
    }
    const bytesToRead = Math.min(maxBytes, size - startOffset);
    if (bytesToRead <= 0) {
      return { content: '', nextOffset: size, size, startOffset, eof: true };
    }
    const handle = await fs.open(run.log_path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, startOffset);
      const content = buffer.toString('utf8');
      const nextOffset = startOffset + bytesToRead;
      return { content, nextOffset, size, startOffset, eof: nextOffset >= size };
    } finally {
      await handle.close();
    }
  });

  // Robot dashboard (Admin)
  app.get('/admin/robot/dashboard', async (request) => {
    requireAdmin(request);

    const activeTurns = codex.listActiveTurns();
    const activeTurnIdByTopic = new Map<string, string>();
    for (const active of activeTurns) {
      activeTurnIdByTopic.set(active.topicId, active.turnId);
    }

    const robotStates = store
      .listRobotStates()
      .filter((s) => !['idle', 'stopped'].includes(s.activity))
      .sort((a, b) => new Date(b.last_updated_at).getTime() - new Date(a.last_updated_at).getTime());

    const jobs = await Promise.all(
      robotStates.map(async (state) => {
        const topic = store.getTopic(state.topic_id);
        const forum = topic ? store.getForum(topic.forum_id) : null;
        const session = store.getSession(state.session_id);
        const codexThreadId = session?.codex_thread_id ?? null;
        const agentThreadId = session?.agent_thread_id ?? codexThreadId ?? null;
        let threadLoaded: boolean | null = null;
        if (agentThreadId) {
          try {
            threadLoaded = await codex.isThreadLoaded(agentThreadId);
          } catch {
            threadLoaded = null;
          }
        }

        return {
          topicId: state.topic_id,
          topicTitle: topic?.title ?? null,
          topicStatus: topic?.status ?? null,
          forumId: topic?.forum_id ?? null,
          forumName: forum?.name ?? null,
          sessionId: state.session_id,
          codexThreadId,
          agentThreadId,
          agentBackend: 'echs',
          activity: state.activity,
          model: state.model ?? null,
          reasoningEffort: state.reasoning_effort ?? null,
          lastUpdatedAt: state.last_updated_at,
          activeTurnId: activeTurnIdByTopic.get(state.topic_id) ?? null,
          threadLoaded
        };
      })
    );

    const queueSnapshot = codex.listQueuedTurns();
    const queue = queueSnapshot.map((turn, idx) => {
      const topic = store.getTopic(turn.topicId);
      const forum = topic ? store.getForum(topic.forum_id) : null;
      return {
        position: idx + 1,
        queuedAt: turn.queuedAt,
        topicId: turn.topicId,
        topicTitle: topic?.title ?? null,
        forumId: topic?.forum_id ?? null,
        forumName: forum?.name ?? null,
        parentPostId: turn.parentPostId,
        sessionId: turn.sessionId
      };
    });

    let subagents: {
      activeCount: number; uncertainCount: number; effectsUnknownCount: number; runs: RobotSubagentRunDto[];
      groups: { blockers: RobotSubagentRunDto[]; pendingDelivery: RobotSubagentRunDto[]; history: RobotSubagentRunDto[] };
      omitted: number; blockerCount: number; omittedBlockerCount: number; available: boolean; error?: string | null;
      retention?: { available: boolean; generatedAt?: string | null; retentionDays: number; counts: { protected: number; waiting: number; eligible: number; compacted: number; error: number }; trackedRemovableBytes: number; eligibleBytes: number; omitted: number; running: boolean; lastError?: string | null };
    };
    try {
      const workload = await codex.getSubagentWorkload();
      const runs = workload.runs.map((run) => {
        const directTopicId = run.origin?.topicId ?? null;
        const link = run.parent_session_id
          ? store.getPiSessionLinkByPiSessionId(run.parent_session_id) ?? store.getPiSessionLinkByPiSessionPath(run.parent_session_id)
          : null;
        const topicId = directTopicId ?? link?.topic_id ?? null;
        const topic = topicId ? store.getTopic(topicId) : null;
        const iso = (value: number | string | null | undefined): string | null => {
          if (value === null || value === undefined) return null;
          const date = new Date(value);
          return Number.isNaN(date.getTime()) ? null : date.toISOString();
        };
        return {
          runId: run.run_key ?? run.run_id, state: run.state, executionState: run.execution_state,
          outcomeState: run.outcome_state ?? null, effectsState: run.effects_state ?? null,
          deliveryState: run.delivery_state ?? null, executionTarget: run.execution_target ?? null,
          blocking: run.blocking, reason: run.reason ?? null,
          parentSessionId: run.parent_session_id ?? null, topicId, topicTitle: topic?.title ?? null,
          postId: run.origin?.postId ?? null, startedAt: iso(run.started_at), updatedAt: iso(run.updated_at)
        };
      });
      let retention;
      try {
        const summary = await codex.getSubagentRetention();
        retention = retentionDashboard(summary);
      } catch (retentionError) {
        retention = unavailableRetentionDashboard(retentionError);
      }
      subagents = {
        activeCount: workload.active_count, uncertainCount: workload.uncertain_count,
        effectsUnknownCount: workload.effects_unknown_count ?? runs.filter((run) => run.effectsState === 'unknown').length, runs,
        groups: groupSubagentRuns(runs), omitted: workload.omitted,
        blockerCount: workload.blocker_count ?? Math.max(workload.active_count, workload.uncertain_count),
        omittedBlockerCount: workload.omitted_blocker_count ?? 0,
        available: true, error: null, retention,
      };
    } catch (err) {
      subagents = { activeCount: 0, uncertainCount: 0, effectsUnknownCount: 0, runs: [], groups: { blockers: [], pendingDelivery: [], history: [] }, omitted: 0, blockerCount: 0, omittedBlockerCount: 0, available: false, error: err instanceof Error ? err.message : 'Agentd subagent workload unavailable' };
    }

    return {
      jobs,
      queue,
      subagents,
      settings: {
        maxConcurrentTurns: codex.maxConcurrentTurns,
        activeTurnsCount: codex.listActiveTurns().length
      }
    };
  });

  app.patch('/admin/robot/settings', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, AdminUpdateRobotSettingsRequestSchema, request.body);

    if (body.maxConcurrentTurns !== undefined) {
      const value = Number(body.maxConcurrentTurns);
      if (!Number.isFinite(value) || value < 1 || value > 100) {
        throw app.httpErrors.badRequest('maxConcurrentTurns must be between 1 and 100');
      }
      codex.setMaxConcurrentTurns(value);
      store.setSystemSetting('maxConcurrentTurns', String(value));
    }

    return {
      maxConcurrentTurns: codex.maxConcurrentTurns
    };
  });
}
