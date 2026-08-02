import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { MessageTemplateService } from '@irrigationreal/codex-forum-core';

import { createAdapterRegistry } from './adapters/adapterRegistry';
import { AgentBridge } from './agentBridge';
import { assertCorsCredentialsConfiguration, isTrustedCookieRequest } from './auth/csrf';
import { SqliteOneTimeLinkIssuer } from './auth/oneTimeLinks';
import { loadFeatureFlags } from './config';
import { ForumQueries } from './core/queries';
import { createCoreServices } from './core/services';
import { bootstrap, migrate, openDb } from './db';
import { EchsClient } from './echsClient';
import { InMemoryMessageTamperLayer } from './messageTamper';
import { createModelCatalog } from './modelCatalog';
import { SqliteForumAnalyticsReadModel } from './readModels/analyticsReadModel';
import { SqliteStatsReadModel } from './readModels/statsReadModel';
import { SqliteMessageTemplateRepository } from './repositories/sqliteMessageTemplateRepository';
import { registerAdapterRoutes } from './routes/adapterRoutes';
import { registerAdminRoutes } from './routes/adminRoutes';
import { registerAnalyticsRoutes } from './routes/analyticsRoutes';
import { registerAttachmentRoutes } from './routes/attachmentRoutes';
import { registerAuthRoutes } from './routes/authRoutes';
import { registerChatRoutes } from './routes/chatRoutes';
import { registerForumRoutes } from './routes/forumRoutes';
import { registerMessageTemplateRoutes } from './routes/messageTemplateRoutes';
import { registerNotificationRoutes } from './routes/notificationRoutes';
import { registerProfileRoutes } from './routes/profileRoutes';
import { registerRobotRoutes } from './routes/robotRoutes';
import { registerSearchRoutes } from './routes/searchRoutes';
import { registerSystemRoutes } from './routes/systemRoutes';
import { registerTenantRoutes } from './routes/tenantRoutes';
import { registerWebhookRoutes } from './routes/webhookRoutes';
import {
  API_BASE_URL,
  API_PREFIX,
  AVATARS_DIR,
  BASE_INSTRUCTIONS,
  BASE_URL,
  BOOTSTRAP_ADMIN_DISPLAY_NAME,
  BOOTSTRAP_ADMIN_PASSWORD,
  BOOTSTRAP_ADMIN_USERNAME,
  CORS_CREDENTIALS,
  CORS_ORIGINS,
  DB_PATH,
  DEFAULT_WEB_IDENTITY_AVATAR_URL,
  DEFAULT_WEB_IDENTITY_DISPLAY_NAME,
  DEFAULT_WEB_IDENTITY_ID,
  DEFAULT_WEB_IDENTITY_USERNAME,
  DEVELOPER_INSTRUCTIONS,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  ECHS_API_TOKEN,
  ECHS_BASE_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER_URL,
  MATRIX_USER_ID,
  MAX_ATTACHMENT_BYTES,
  MAX_CONCURRENT_TURNS,
  MAX_REQUEST_BODY_BYTES,
  MODEL,
  MODEL_CATALOG_TTL_MS,
  MONIKA_PI_SYNC_ENABLED,
  MONIKA_PI_SYNC_INTERVAL_MS,
  PASSWORD_LOGIN_ENABLED,
  PORT,
  PROMPT_ENHANCER_ENABLED,
  REASONING_EFFORT,
  REDIS_URL,
  TRUST_PROXY,
  TTS_AVAILABLE,
  TTS_MAX_CHARS,
  TTS_SCRIPT,
  UPLOADS_DIR,
  UPLOAD_TEMP_DIR,
  USER_FILES_DIR,
  WORK_DIR,
} from './runtimeConfig';
import { AnalyticsService } from './services/analyticsService';
import { AutoRunDirector } from './services/autoRunDirector';
import { CompactionService } from './services/compactionService';
import { getEmailService } from './services/emailService';
import { PiSessionSyncService } from './services/piSessionSyncService';
import { PostDispatchService } from './services/postDispatchService';
import { WebhookService } from './services/webhookService';
import { ForumStore } from './store';
import { RedisStreamBus, createStreamBus } from './streamBus';
import { createPersonaPrefacePlugin, createPromptEnhancerPlugin } from './tamperPlugins';
import { createAccessHelpers } from './utils/access';
import { hashPassword } from './utils/auth';
import { rateLimitKeyForRequest } from './utils/rateLimit';

import type { MessageTamperContext } from '@irrigationreal/codex-forum-core';
import type { FastifyPluginAsync } from 'fastify';

assertCorsCredentialsConfiguration(CORS_ORIGINS, CORS_CREDENTIALS);
const featureFlags = loadFeatureFlags();
const { db } = openDb({ path: DB_PATH });
migrate(db);
const messageTemplateService = new MessageTemplateService(new SqliteMessageTemplateRepository(db));
const bootstrapResult = bootstrap(db, {
  defaultWebIdentityId: DEFAULT_WEB_IDENTITY_ID,
  defaultWebIdentityUsername: DEFAULT_WEB_IDENTITY_USERNAME,
  defaultWebIdentityDisplayName: DEFAULT_WEB_IDENTITY_DISPLAY_NAME,
  defaultWebIdentityAvatarUrl: DEFAULT_WEB_IDENTITY_AVATAR_URL,
});
const store = new ForumStore(db);
void createCoreServices(db);
void new ForumQueries(db);
void new SqliteStatsReadModel(db);
const analyticsReadModel = new SqliteForumAnalyticsReadModel(db);
const recoveredRobotStates = store.resetRobotActivities('idle');
if (recoveredRobotStates > 0) {
  console.warn(`[RobotStop] source=startup_reset count=${recoveredRobotStates}`);
  console.warn(`Reset ${recoveredRobotStates} robot state(s) to idle on startup.`);
}
const bus = createStreamBus(featureFlags.useRedisStreamBus, REDIS_URL ?? undefined);
if (featureFlags.useRedisStreamBus && !REDIS_URL) {
  console.warn(
    'CODEX_FORUM_REDIS_STREAM_BUS is enabled but no REDIS_URL provided; falling back to in-memory stream bus.'
  );
}
if (bus instanceof RedisStreamBus) {
  await bus.connect();
}

if (!ECHS_BASE_URL) {
  throw new Error('MONIKA_AGENTD_BASE_URL or CODEX_FORUM_ECHS_BASE_URL is required for agent backend mode.');
}

const CHAT_EXPIRY_CLEANUP_INTERVAL_MS = 60_000;
const cleanupExpiredChatMessages = () => {
  const result = store.cleanupExpiredChatMessages();
  if (result.deleted > 0) {
    for (const expired of result.expiredMessages) {
      bus.emit(expired.roomId, {
        type: 'chat_message_expired',
        data: { roomId: expired.roomId, messageId: expired.id },
      });
    }
  }
};
cleanupExpiredChatMessages();
setInterval(cleanupExpiredChatMessages, CHAT_EXPIRY_CLEANUP_INTERVAL_MS);

const autoRunDirector = new AutoRunDirector(store, bus, {
  workDir: WORK_DIR,
  apiBaseUrl: API_BASE_URL,
  defaultWorker: 'echs',
  defaultModel: MODEL,
  defaultReasoningEffort: REASONING_EFFORT ?? null,
  autoStartOnAssistantReply: false,
  echs: ECHS_BASE_URL
    ? {
        baseUrl: ECHS_BASE_URL,
        apiToken: ECHS_API_TOKEN,
      }
    : null,
});

// Bootstrap admin account if it doesn't exist
async function bootstrapAdminAccount(): Promise<void> {
  if (!PASSWORD_LOGIN_ENABLED) return;
  if (!BOOTSTRAP_ADMIN_USERNAME || !BOOTSTRAP_ADMIN_PASSWORD) {
    return;
  }
  const adminUsername = BOOTSTRAP_ADMIN_USERNAME.trim();
  if (!adminUsername) {
    return;
  }
  const adminPassword = BOOTSTRAP_ADMIN_PASSWORD;
  if (adminPassword.length < 8 || adminPassword.length > 1024) {
    throw new Error('CODEX_FORUM_BOOTSTRAP_ADMIN_PASSWORD must be between 8 and 1024 characters');
  }
  const adminDisplayName = BOOTSTRAP_ADMIN_DISPLAY_NAME.trim() || adminUsername;
  const existing = store.getIdentityByUsername(adminUsername);
  if (existing) {
    if (existing.kind !== 'admin') {
      throw new Error(
        `Refusing to promote non-admin identity ${existing.id} that already owns bootstrap username ${adminUsername}`
      );
    }
    return;
  }
  // Never adopt an identity by display name: public users control display names.
  // Create a distinct bootstrap administrator instead.
  const passwordHash = await hashPassword(adminPassword);
  const identity = store.createIdentityWithPassword(adminDisplayName, adminUsername, passwordHash, 'admin');
  console.log(`Created admin account: ${identity.display_name} (${identity.id})`);
}
await bootstrapAdminAccount();
if (!PASSWORD_LOGIN_ENABLED && !store.hasWebAuthnAdmin()) {
  throw new Error(
    'CODEX_FORUM_PASSWORD_LOGIN_ENABLED=0 requires at least one admin account with a registered WebAuthn credential'
  );
}
const normalizeApiPrefix = (prefix: string): string => {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};
const apiPrefix = normalizeApiPrefix(API_PREFIX);
const linkIssuer = new SqliteOneTimeLinkIssuer(db, `${BASE_URL}${apiPrefix}`);
const webhookService = new WebhookService(store);
const emailService = getEmailService();
const tamperLayer = new InMemoryMessageTamperLayer<MessageTamperContext>();
tamperLayer.register(
  createPromptEnhancerPlugin({
    store,
    enabledByDefault: PROMPT_ENHANCER_ENABLED,
    defaultPriority: 5,
    defaultOnlyFirstMessage: true,
  })
);
tamperLayer.register(
  createPersonaPrefacePlugin({
    store,
    enabledByDefault: true,
    defaultPriority: 4,
    defaultOnlyFirstMessage: true,
  })
);
const echsClient = new EchsClient({ baseUrl: ECHS_BASE_URL, apiToken: ECHS_API_TOKEN });
const modelCatalog = createModelCatalog({
  echsClient,
  fallbackModels: [MODEL],
  cacheTtlMs: MODEL_CATALOG_TTL_MS,
});
const codex = new AgentBridge(store, bus, {
  model: MODEL,
  reasoningEffort: REASONING_EFFORT,
  workDir: WORK_DIR,
  apiBaseUrl: API_BASE_URL,
  baseInstructions: BASE_INSTRUCTIONS,
  developerInstructions: DEVELOPER_INSTRUCTIONS,
  tamperLayer,
  maxConcurrentTurns: MAX_CONCURRENT_TURNS,
  autoRunDirector,
  echs: {
    baseUrl: ECHS_BASE_URL,
    apiToken: ECHS_API_TOKEN,
  },
  tts: TTS_AVAILABLE
    ? {
        enabled: true,
        scriptPath: TTS_SCRIPT,
        uploadsDir: UPLOADS_DIR,
        maxChars: Number.isFinite(TTS_MAX_CHARS) ? TTS_MAX_CHARS : 2500,
      }
    : { enabled: false, scriptPath: TTS_SCRIPT, uploadsDir: UPLOADS_DIR },
});

const analyticsService = new AnalyticsService(analyticsReadModel, (input) => codex.getAnalytics(input));

// The Director should be able to kick the robot forward by posting a directive.
autoRunDirector.setRobotDispatcher(({ topicId, body, parentPostId, model, reasoningEffort }) =>
  codex.sendUserMessage(topicId, body, parentPostId, { model: model ?? null, reasoningEffort: reasoningEffort ?? null })
);

await codex.start();

const postDispatchService = new PostDispatchService(store, codex, {
  maxConcurrent: Math.max(1, Math.min(10, MAX_CONCURRENT_TURNS)),
});
const compactionService = new CompactionService(store, codex, postDispatchService);

const piSessionSync = MONIKA_PI_SYNC_ENABLED
  ? new PiSessionSyncService(db, {
      agentdBaseUrl: ECHS_BASE_URL,
      apiToken: ECHS_API_TOKEN,
      intervalMs: MONIKA_PI_SYNC_INTERVAL_MS,
    })
  : null;
piSessionSync?.start();

// Load persisted maxConcurrentTurns from database
const savedMaxConcurrentTurns = store.getSystemSetting('maxConcurrentTurns');
if (savedMaxConcurrentTurns) {
  const parsed = Number(savedMaxConcurrentTurns);
  if (Number.isFinite(parsed) && parsed > 0) {
    codex.setMaxConcurrentTurns(parsed);
  }
}

try {
  const { reattached, missing } = await codex.reconcileLoadedThreads();
  const superseded = store.reconcilePostDispatchGenerations();
  if (reattached > 0 || missing > 0 || superseded > 0) {
    console.log(
      `Startup reconciliation reattached ${reattached} loaded conversation(s), marked ${missing} unloaded, and superseded ${superseded} stale dispatch(es).`
    );
  }
} catch (err) {
  console.warn(
    'Passive startup reconciliation failed; durable dispatch processing remains stopped:',
    err instanceof Error ? err.message : err
  );
  throw err;
}
const recoveredCompactions = compactionService.start();
postDispatchService.start();
if (recoveredCompactions > 0) {
  console.warn(`Requeued ${recoveredCompactions} interrupted compaction operation(s) for canonical reconciliation.`);
}

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES, trustProxy: TRUST_PROXY });
const access = createAccessHelpers(app, store);
app.setErrorHandler((error, _request, reply) => {
  const errObj = error as Record<string, unknown>;
  const statusCode = typeof errObj['statusCode'] === 'number' ? errObj['statusCode'] : 500;
  let code: string = 'internal_error';
  if (errObj['validation']) {
    code = 'validation_error';
  } else {
    switch (statusCode) {
      case 400:
        code = 'validation_error';
        break;
      case 401:
        code = 'unauthorized';
        break;
      case 403:
        code = 'forbidden';
        break;
      case 404:
        code = 'not_found';
        break;
      case 409:
        code = 'conflict';
        break;
      case 429:
        code = 'rate_limited';
        break;
      default:
        code = 'internal_error';
    }
  }
  if (statusCode >= 500) {
    app.log.error(error);
  }
  reply.status(statusCode).send({
    code,
    message: error instanceof Error ? error.message : String(error),
    details: errObj['validation'] ? { validation: errObj['validation'] } : undefined,
  });
});
app.addHook('onClose', async () => {
  piSessionSync?.stop();
  const postDispatchStop = postDispatchService.stop();
  await piSessionSync?.waitForIdle();
  await compactionService.stop();
  await postDispatchStop;
  await autoRunDirector.stop();
  await codex.stop();
  if (bus instanceof RedisStreamBus) {
    await bus.close();
  }
  try {
    db.close();
  } catch {
    // ignore duplicate close attempts during shutdown
  }
});

await app.register(cors, {
  origin: CORS_ORIGINS ?? true,
  credentials: CORS_CREDENTIALS,
});
await app.register(helmet, {
  // We render a Vue SPA and also intentionally allow some HTML rendering in posts
  // (sanitized client-side). Keep this conservative and avoid breaking the UI.
  contentSecurityPolicy: false,
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('x-content-type-options', 'nosniff');
  return payload;
});
await app.register(sensible);
const trustedOrigin = new URL(BASE_URL).origin;
app.addHook('onRequest', async (request) => {
  const auth = access.getCurrentUser(request);
  if (!isTrustedCookieRequest({ method: request.method, origin: request.headers.origin, trustedOrigin, auth })) {
    throw app.httpErrors.forbidden('Invalid request origin');
  }
});
await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES } });

// Ensure uploads directory exists
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!existsSync(UPLOAD_TEMP_DIR)) {
  mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
}
if (!existsSync(AVATARS_DIR)) {
  mkdirSync(AVATARS_DIR, { recursive: true });
}
if (!existsSync(USER_FILES_DIR)) {
  mkdirSync(USER_FILES_DIR, { recursive: true });
}
// Serve static files from uploads directory.
// Security note: do NOT expose the entire uploads root publicly.
// Only avatars are served as static assets; other uploads must go through authenticated routes.
await app.register(fastifyStatic, {
  root: AVATARS_DIR,
  prefix: '/uploads/avatars/',
  decorateReply: false,
});

// Serve the built Vue application when the Docker image includes it. API routes
// are registered below and keep their normal behavior; unknown non-API GETs fall
// back to index.html for client-side routing.
const publicDir = process.env['CODEX_FORUM_PUBLIC_DIR'] ?? resolve(process.cwd(), '../../public');
const publicIndex = join(publicDir, 'index.html');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    decorateReply: false,
  });
}

// Root health check (kept unprefixed for container health checks)
// Avoid duplicate registration when API_PREFIX is empty (system routes already register /healthz).
if (apiPrefix) {
  app.get('/healthz', async () => ({ ok: true }));
}

if (featureFlags.enableRateLimiting) {
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => rateLimitKeyForRequest(request, access),
  });
}

const adapterRegistry = createAdapterRegistry({
  store,
  bus,
  codex,
  defaultForumId: bootstrapResult.forumId,
  discord: {
    token: DISCORD_BOT_TOKEN,
    guildId: DISCORD_GUILD_ID,
  },
  matrix: {
    homeserverUrl: MATRIX_HOMESERVER_URL,
    accessToken: MATRIX_ACCESS_TOKEN,
    userId: MATRIX_USER_ID,
  },
});

const forumDeploymentStatus = () => {
  const activeTurns = codex.listActiveTurns().length;
  const queuedTurns = codex.listQueuedTurns().length;
  const piSync = piSessionSync?.getStatus() ?? { enabled: false, running: false, intervalMs: null };
  const blockers = [] as Array<Record<string, unknown>>;
  if (activeTurns > 0) blockers.push({ code: 'active_robot_turns', count: activeTurns });
  if (queuedTurns > 0) blockers.push({ code: 'queued_robot_turns', count: queuedTurns });
  if (piSync.running) blockers.push({ code: 'pi_session_sync_running' });
  const activeCompactions = store.countActiveCompactionOperations();
  if (activeCompactions > 0) blockers.push({ code: 'active_compactions', count: activeCompactions });
  const blockingRobotStates = store
    .listRobotStates()
    .filter((state) => !['idle', 'stopped', 'error'].includes(state.activity));
  if (blockingRobotStates.length > 0) {
    blockers.push({ code: 'non_idle_robot_states', count: blockingRobotStates.length });
  }
  return {
    safeToStop: blockers.length === 0,
    blockers,
    robot: { activeTurns, queuedTurns },
    piSessionSync: piSync,
  };
};

const registerApiRoutes: FastifyPluginAsync = async (api) => {
  registerSystemRoutes({ app: api, modelCatalog, access, deploymentStatus: forumDeploymentStatus });
  registerAuthRoutes({ app: api, store, featureFlags, linkIssuer, emailService, access });
  registerAdminRoutes({ app: api, store, db, access, codex, piSessionSync });
  registerAnalyticsRoutes({ app: api, access, service: analyticsService });
  registerForumRoutes({
    app: api,
    store,
    featureFlags,
    codex,
    webhookService,
    bus,
    postDispatchService,
    compactionService,
    access,
    webIdentityId: bootstrapResult.webIdentityId,
  });
  registerChatRoutes({
    app: api,
    store,
    access,
    bus,
  });
  registerNotificationRoutes({ app: api, store, bus, access });
  registerAttachmentRoutes({ app: api, store, access });
  registerRobotRoutes({ app: api, store, codex, bus, access, autoRunDirector });
  registerProfileRoutes({ app: api, store, access });
  registerMessageTemplateRoutes({ app: api, access, service: messageTemplateService });
  registerSearchRoutes({ app: api, store, featureFlags, access });
  registerAdapterRoutes({
    app: api,
    getDiscordBridge: adapterRegistry.getDiscordBridge,
    getMatrixBridge: adapterRegistry.getMatrixBridge,
    defaultForumId: bootstrapResult.forumId,
    access,
  });
  registerTenantRoutes({ app: api, store, access });
  registerWebhookRoutes({ app: api, store, access });
};

if (apiPrefix) {
  await app.register(registerApiRoutes, { prefix: apiPrefix });
} else {
  await app.register(registerApiRoutes);
}

app.setNotFoundHandler((request, reply) => {
  const url = request.url ?? '';
  const wantsHtml = String(request.headers.accept ?? '').includes('text/html');
  const isApi = apiPrefix ? url.startsWith(apiPrefix + '/') || url === apiPrefix : false;
  if (request.method === 'GET' && wantsHtml && !isApi && existsSync(publicIndex)) {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(readFileSync(publicIndex, 'utf8'));
  }
  return reply.status(404).send({ code: 'not_found', message: 'Not Found' });
});

await app.listen({ port: PORT, host: '0.0.0.0' });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down forum server');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Forum shutdown failed');
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
