import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { EchsClient } from './echsClient';
import { InMemoryMessageTamperLayer } from './messageTamper';
import { renderPersonaIndexMarkdown, safePersonaKey } from './personaPrompt';
import { buildTtsStoragePath, extractRobotTtsMarker, generateTtsMp3 } from './tts';
import { truncateText } from './utils/automation';

import type {
  MessageTamperContext,
  MessageTamperLayer,
  MessageTamperPlugin,
  MessageTamperTrailEntry,
} from '@irrigationreal/codex-forum-core';

import type { EchsConversationRecord, EchsEvent } from './echsClient';
import type { ForumStore } from './store';
import type { StreamBusInterface } from './streamBus';

const REDACTION_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
  { pattern: /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi, replacement: '$1=[REDACTED]' },
  { pattern: /\b(secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: '$1=[REDACTED]' },
  { pattern: /\b(token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}["']?/gi, replacement: '$1=[REDACTED]' },
  {
    pattern: /\b(aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  { pattern: /\b(aws[_-]?access[_-]?key[_-]?id)\s*[:=]\s*["']?[A-Z0-9]{16,}["']?/gi, replacement: '$1=[REDACTED]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  {
    pattern: /\b(private[_-]?key)\s*[:=]\s*["']?-----BEGIN[^-]+-----[^-]+-----END[^-]+-----["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  {
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern: /\b(database[_-]?url|db[_-]?url|connection[_-]?string)\s*[:=]\s*["']?[^\s"']+["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  { pattern: /mongodb(\+srv)?:\/\/[^\s"']+/gi, replacement: '[REDACTED_MONGODB_URI]' },
  { pattern: /postgres(ql)?:\/\/[^\s"']+/gi, replacement: '[REDACTED_POSTGRES_URI]' },
  { pattern: /redis:\/\/[^\s"']+/gi, replacement: '[REDACTED_REDIS_URI]' },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(sk-[A-Za-z0-9]{32,})/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { pattern: /\b(ANTHROPIC[_-]?API[_-]?KEY)\s*[:=]\s*["']?[^\s"']+["']?/gi, replacement: '$1=[REDACTED]' },
];

interface RedactionResult {
  text: string;
  redacted: boolean;
}

function redactSensitiveData(text: string): RedactionResult {
  let result = text;
  let redacted = false;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    const newResult = result.replace(pattern, replacement);
    if (newResult !== result) {
      redacted = true;
      result = newResult;
    }
  }
  return { text: result, redacted };
}

function writePersonaSoulFiles(opts: { cwd: string; personas: Array<{ key: string; soul: string | null }> }): void {
  const baseDir = join(opts.cwd, '.codex-forum', 'personas');
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch {
    return;
  }

  for (const persona of opts.personas) {
    const soul = persona.soul?.trim();
    if (!soul) continue;
    const path = join(baseDir, `${safePersonaKey(persona.key)}.md`);
    try {
      writeFileSync(path, soul, 'utf8');
    } catch {
      // ignore write errors; the persona preview is still injected into the prompt
    }
  }
}

function buildThreadMoveOverlay(opts: {
  fromForumName: string;
  toForumName: string;
  movedBy: string;
  movedAt: string;
  forumPrePrompt: string | null;
  personas: Array<{ key: string; displayName: string; description: string | null; soul: string | null }>;
}): string {
  const instructions = opts.forumPrePrompt?.trim()
    ? `New forum instructions:\n${opts.forumPrePrompt.trim()}`
    : 'New forum instructions: (none)';
  const personaIndex = renderPersonaIndexMarkdown(
    opts.personas.map((p) => ({ key: p.key, displayName: p.displayName, description: p.description, soul: p.soul }))
  ).trimEnd();

  return [
    '[THREAD MOVED NOTICE]',
    `This thread was moved from "${opts.fromForumName}" to "${opts.toForumName}" by ${opts.movedBy} on ${opts.movedAt}.`,
    'AI agents: the working directory context has changed. Files that were previously available may no longer exist.',
    '',
    instructions,
    '',
    '[PERSONA INDEX]',
    personaIndex,
    '[/PERSONA INDEX]',
    '[/THREAD MOVED NOTICE]',
  ].join('\n');
}

function writeRequesterMetadataFile(opts: {
  cwd: string;
  topicId: string;
  parentPostId: string | null;
  requesterIdentityId: string | null;
  requestedAtIso: string;
  store: ForumStore;
}): void {
  const baseDir = join(opts.cwd, '.codex-forum');
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch {
    return;
  }

  const requester = opts.requesterIdentityId ? opts.store.getIdentity(opts.requesterIdentityId) : null;
  const requesterPrivateEmail = requester ? opts.store.getIdentityPrivateEmail(requester.id) : null;
  const topicIdentities = opts.store
    .listIdentities(opts.topicId, 1, 500)
    .filter((identity) => identity.kind !== 'robot')
    .map((identity) => {
      const privateEmail = opts.store.getIdentityPrivateEmail(identity.id);
      return {
        identityId: identity.id,
        displayName: identity.display_name,
        username: identity.username ?? null,
        kind: identity.kind,
        hasRobotOnlyEmail: Boolean(privateEmail),
        robotOnlyEmail: privateEmail,
      };
    });

  const payload = {
    requestedAt: opts.requestedAtIso,
    topicId: opts.topicId,
    parentPostId: opts.parentPostId,
    nonRobotParticipants: topicIdentities,
    requester: requester
      ? {
          identityId: requester.id,
          displayName: requester.display_name,
          username: requester.username ?? null,
          kind: requester.kind,
          hasRobotOnlyEmail: Boolean(requesterPrivateEmail),
          robotOnlyEmail: requesterPrivateEmail,
        }
      : null,
  };

  try {
    writeFileSync(join(baseDir, 'requester.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // ignore write errors
  }
}

function clampPositiveInt(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.floor(value);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.json': return 'application/json';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

interface ArtifactRequest {
  path: string;
  filename?: string | null;
  mimeType?: string | null;
}

function parseMarkerAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    attrs[match[1] ?? ''] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function consumeStandaloneMarkers(text: string, consume: (line: string) => boolean): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && consume(line.trim())) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractArtifactMarkers(text: string): { cleanedText: string; artifacts: ArtifactRequest[] } {
  const artifacts: ArtifactRequest[] = [];
  const cleanedText = consumeStandaloneMarkers(text, (line) => {
    const match = /^\[artifact\s+([^\]]+)\]$/i.exec(line);
    if (!match) return false;
    const attrs = parseMarkerAttrs(match[1] ?? '');
    const artifactPath = attrs['path'] ?? attrs['file'] ?? null;
    if (!artifactPath) return false;
    artifacts.push({
      path: artifactPath,
      filename: attrs['filename'] ?? attrs['name'] ?? null,
      mimeType: attrs['mime'] ?? attrs['mimeType'] ?? null,
    });
    return true;
  });
  return { cleanedText, artifacts };
}

function extractForumAttachmentRefs(text: string): { cleanedText: string; ids: string[] } {
  const ids: string[] = [];
  const cleanedText = consumeStandaloneMarkers(text, (line) => {
    const match = /^\[forum-attachment\s+([^\]]+)\]$/i.exec(line);
    if (!match) return false;
    const attrs = parseMarkerAttrs(match[1] ?? '');
    const id = attrs['id'] ?? attrs['pendingAttachmentId'] ?? null;
    if (!id) return false;
    ids.push(id);
    return true;
  });
  return { cleanedText, ids };
}

function formatBytes(sizeBytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, sizeBytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function truncateWithMarker(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  return `${clipped}\n\n${marker} (omitted ${omitted} chars)`;
}

function formatForumPostEnvelope(opts: {
  postId: string;
  createdAt: string;
  parentPostId?: string | null;
  flags?: string[] | null;
  author: {
    displayName: string;
    username: string | null;
    identityId: string;
    kind: string | null;
  };
  body: string;
  maxPostChars: number;
  attachments?: Array<{ id: string; filename: string; sizeBytes: number; url: string; mimeType?: string; storagePath?: string; sha256?: string | null; postId?: string }>;
}): string {
  const flags = opts.flags?.filter(Boolean) ?? [];
  const flagText = flags.length > 0 ? ` flags=${flags.join(',')}` : '';
  const authorParts = [opts.author.displayName];
  if (opts.author.username) {
    authorParts.push(`(@${opts.author.username})`);
  }
  authorParts.push(`(${opts.author.identityId})`);
  if (opts.author.kind) {
    authorParts.push(`[${opts.author.kind}]`);
  }

  const lines: string[] = [];
  lines.push(`[POST id=${opts.postId}${flagText}]`);
  lines.push(`Author: ${authorParts.join(' ')}`);
  lines.push(`Created: ${opts.createdAt}`);
  if (opts.parentPostId) {
    lines.push(`Parent: ${opts.parentPostId}`);
  }
  lines.push('');
  lines.push(truncateWithMarker(opts.body ?? '', opts.maxPostChars, '[POST BODY TRUNCATED]'));

  const attachments = opts.attachments ?? [];
  if (attachments.length > 0) {
    lines.push('');
    lines.push(`Attachments (${attachments.length}):`);
    for (const attachment of attachments) {
      lines.push(
        `- ${attachment.filename} (${formatBytes(attachment.sizeBytes)}) id=${attachment.id} url=${attachment.url}`
      );
    }
  }

  lines.push('[/POST]');
  return lines.join('\n');
}

const AGENT_GUIDANCE_FILES = ['AGENTS.md'] as const;

function readAgentGuidanceFile(cwd: string, filename: string, maxChars: number): string | null {
  const filePath = join(cwd, filename);
  if (!existsSync(filePath)) return null;
  try {
    const contents = readFileSync(filePath, 'utf8');
    return truncateWithMarker(contents, maxChars, `[${filename} TRUNCATED]`);
  } catch {
    return null;
  }
}

function buildAgentGuidanceInstructions(cwd: string, maxChars: number): string | null {
  const entries = AGENT_GUIDANCE_FILES.map((filename) => {
    const contents = readAgentGuidanceFile(cwd, filename, maxChars);
    if (!contents) return null;
    return [`<FILE name="${filename}">`, contents, `</FILE>`].join('\n');
  }).filter(Boolean) as string[];

  if (entries.length === 0) return null;

  return [
    '<AGENT_GUIDANCE>',
    'AGENTS.md Contents',
    'These files are already provided below. Do not re-open them unless explicitly asked.',
    '',
    entries.join('\n\n'),
    '</AGENT_GUIDANCE>',
  ].join('\n');
}

export interface EchsBridgeConfig {
  model: string;
  reasoningEffort?: string | null;
  workDir: string;
  apiBaseUrl?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  echs: {
    baseUrl: string;
    apiToken?: string | null;
  };
  tamperLayer?: MessageTamperLayer<MessageTamperContext>;
  autoRunDirector?: {
    handleAssistantReply: (opts: { topicId: string; postId: string; text: string }) => void | Promise<void>;
  };
  tts?: {
    enabled: boolean;
    scriptPath: string;
    uploadsDir: string;
    maxChars?: number;
  };
  maxConcurrentTurns?: number;
  maxTurnChars?: number;
  maxPostChars?: number;
}

interface ThreadContext {
  topicId: string;
  sessionId: string;
  activeThreadId: string | null;
  lastUserPostId: string | null;
  turnParentPostId: string | null;
  planId: string | null;
  reasoningSummary: string;
  reasoningBackfillAttempted: boolean;
  reasoningBackfillRetries: number;
  model: string;
  reasoningEffort: string | null;
  currentTurnId: string | null;
  turnStartedAt: number | null;
  lastAssistantAt: number | null;
  lastUsage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  activeSubagents: Map<string, { task: string; startedAt: number }>;
  /** Timestamp of last SSE event received (including keepalives). */
  lastStreamEventAt: number | null;
}

interface PlanContext {
  topicId: string;
  sessionId: string;
  parentPostId: string | null;
}

interface QueuedTurn {
  topicId: string;
  sessionId: string;
  body: string;
  parentPostId: string | null;
  options?: { model?: string | null; reasoningEffort?: string | null; mode?: 'queue' | 'steer' };
  queuedAt: string;
}

const ROBOT_HEARTBEAT_INTERVAL_MS = 60_000;

export class EchsBridge {
  private readonly client: EchsClient;
  private threadMap = new Map<string, ThreadContext>();
  private toolRunByCallId = new Map<string, string>();
  private spawnToolRunByAgentId = new Map<string, string>();
  private reasoningBackfillRetriesByThread = new Map<string, number>();
  private assistantBackfillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly personaBlockRegex = /\[\[persona:([^\]\n]+)\]\][\s\S]*?\[\[\/persona\]\]/i;
  private readonly tamperLayer: MessageTamperLayer<MessageTamperContext>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthPollTimer: ReturnType<typeof setInterval> | null = null;
  private threadHealthTimer: ReturnType<typeof setInterval> | null = null;
  private echs_queue_depth: number | null = null;
  private echs_active_threads: number | null = null;
  private activeTurnThreads = new Set<string>();
  private turnQueue: QueuedTurn[] = [];
  private drainingQueue = false;
  private inflightDispatches = 0;
  private _maxConcurrentTurns: number;
  private subscriptions = new Map<
    string,
    { close: () => void; ready: Promise<void>; lastEventId: string | null; options: { lastEventId?: string | null } }
  >();

  constructor(
    private readonly store: ForumStore,
    private readonly bus: StreamBusInterface,
    private readonly config: EchsBridgeConfig
  ) {
    this.client = new EchsClient(config.echs);
    const configuredLimit = config.maxConcurrentTurns;
    this._maxConcurrentTurns =
      typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit > 0
        ? Math.floor(configuredLimit)
        : 10;

    this.tamperLayer =
      config.tamperLayer ??
      new InMemoryMessageTamperLayer<MessageTamperContext>({
        throwOnError: false,
      });
  }

  registerTamperPlugin(plugin: MessageTamperPlugin<MessageTamperContext>): void {
    this.tamperLayer.register(plugin);
  }

  get maxConcurrentTurns(): number {
    return this._maxConcurrentTurns;
  }

  setMaxConcurrentTurns(value: number): void {
    if (Number.isFinite(value) && value > 0) {
      this._maxConcurrentTurns = Math.floor(value);
      void this.processTurnQueue();
    }
  }

  async start(): Promise<void> {
    this.startHeartbeat();
    this.startHealthPoll();
    this.startThreadHealthCheck();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.healthPollTimer) clearInterval(this.healthPollTimer);
    if (this.threadHealthTimer) clearInterval(this.threadHealthTimer);
    this.heartbeatTimer = null;
    this.healthPollTimer = null;
    this.threadHealthTimer = null;

    for (const timer of this.assistantBackfillTimers.values()) {
      clearTimeout(timer);
    }
    this.assistantBackfillTimers.clear();

    for (const sub of this.subscriptions.values()) {
      try {
        sub.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.subscriptions.clear();
  }

  getEchsHealth(): { queue_depth: number | null; active_threads: number | null } {
    return { queue_depth: this.echs_queue_depth, active_threads: this.echs_active_threads };
  }
  async getTopicContext(topicId: string): Promise<Record<string, unknown> | null> {
    const session = this.store.getSessionByTopic(topicId);
    if (!session) return null;
    const threadId = session.agent_thread_id ?? null;
    if (threadId) {
      const live = await this.client.getConversationContext(threadId);
      const liveContext = (live as any)?.context ? ((live as any).context as Record<string, unknown>) : (live as Record<string, unknown> | null);
      if ((liveContext as any)?.exact) return liveContext;
    }
    const link = this.store.getPiSessionLinkByTopic(topicId);
    if (!link?.pi_session_id) return null;
    const historical = await this.client.getPiSessionContext(link.pi_session_id);
    return (historical as any)?.context ? ((historical as any).context as Record<string, unknown>) : historical;
  }


  listQueuedTurns(): Array<Pick<QueuedTurn, 'topicId' | 'sessionId' | 'parentPostId' | 'queuedAt'>> {
    return this.turnQueue.map((turn) => ({
      topicId: turn.topicId,
      sessionId: turn.sessionId,
      parentPostId: turn.parentPostId,
      queuedAt: turn.queuedAt,
    }));
  }

  listActiveTurns(): Array<{
    threadId: string;
    topicId: string;
    sessionId: string;
    turnId: string;
    parentPostId: string | null;
  }> {
    const active: Array<{
      threadId: string;
      topicId: string;
      sessionId: string;
      turnId: string;
      parentPostId: string | null;
    }> = [];
    for (const [threadId, ctx] of this.threadMap.entries()) {
      if (!ctx.currentTurnId) continue;
      active.push({
        threadId: ctx.activeThreadId ?? threadId,
        topicId: ctx.topicId,
        sessionId: ctx.sessionId,
        turnId: ctx.currentTurnId,
        parentPostId: ctx.lastUserPostId,
      });
    }
    return active;
  }

  private async openTopicConversation(topicId: string, opts?: { model?: string | null; reasoningEffort?: string | null }): Promise<{ sessionId: string; conversationId: string; link: ReturnType<ForumStore['getPiSessionLinkByTopic']> }> {
    const session = this.store.ensureSession({ topicId });
    const link = this.store.getPiSessionLinkByTopic(topicId);
    const topic = this.store.getTopic(topicId);
    const forum = topic ? this.store.getForum(topic.forum_id) : null;
    const cwd = forum?.cwd ?? this.config.workDir;
    let conversationId = session.agent_thread_id ?? null;
    if (conversationId) {
      const existing = await this.client.getConversation(conversationId);
      if (!existing) {
        this.cleanupDeadThread(conversationId, topicId);
        conversationId = null;
      }
    }
    if (!conversationId) {
      if (link) {
        const conversation = await this.client.openConversation({ piSessionId: link.pi_session_id, piSessionPath: link.pi_session_path, cwd });
        conversationId = conversation.conversation_id;
      } else {
        const conversation = await this.client.createConversationRecord({
          cwd,
          model: opts?.model ?? this.config.model,
          ...(opts?.reasoningEffort ?? this.config.reasoningEffort ? { reasoning: opts?.reasoningEffort ?? this.config.reasoningEffort } : {}),
        });
        conversationId = conversation.conversation_id;
        if (conversation.session_id && conversation.session_path) {
          this.store.upsertPiSessionLink({
            piSessionId: conversation.session_id,
            piSessionPath: conversation.session_path,
            topicId,
            sessionId: session.id,
            cwd: conversation.cwd ?? cwd,
            kind: 'normal',
            metadata: { source: 'forum-created' },
          });
        }
      }
      this.store.setSessionAgentThread(session.id, 'echs', conversationId);
    }
    return { sessionId: session.id, conversationId, link };
  }

  async generateHandoffDraft(topicId: string, opts: { goal: string; model?: string | null; reasoningEffort?: string | null; systemPrompt?: string | null }): Promise<{ source?: unknown; goal: string; draft: string; model?: string | null; reasoning?: string | null }> {
    const opened = await this.openTopicConversation(topicId, { model: opts.model ?? null, reasoningEffort: opts.reasoningEffort ?? null });
    return this.client.generateHandoffDraft(opened.conversationId, {
      goal: opts.goal,
      model: opts.model ?? null,
      reasoning: opts.reasoningEffort ?? null,
      systemPrompt: opts.systemPrompt ?? null,
    });
  }

  async createLinkedHandoffConversation(topicId: string, opts: {
    parentPiSessionId?: string | null;
    parentPiSessionPath?: string | null;
    cwd: string;
    model?: string | null;
    reasoningEffort?: string | null;
  }): Promise<EchsConversationRecord> {
    const session = this.store.ensureSession({ topicId });
    const conversation = await this.client.createConversationRecord({
      cwd: opts.cwd || this.config.workDir,
      model: opts.model ?? this.config.model,
      ...(opts.reasoningEffort ? { reasoning: opts.reasoningEffort } : {}),
      parentPiSessionId: opts.parentPiSessionId ?? null,
      parentPiSessionPath: opts.parentPiSessionPath ?? null,
      lineageKind: 'handoff',
      lineageSource: 'forum',
    });
    if (conversation.session_id && conversation.session_path) {
      this.store.upsertPiSessionLink({
        piSessionId: conversation.session_id,
        piSessionPath: conversation.session_path,
        topicId,
        sessionId: session.id,
        cwd: conversation.cwd ?? opts.cwd ?? this.config.workDir,
        kind: 'normal',
        metadata: { source: 'forum-handoff' },
        parentPiSessionId: opts.parentPiSessionId ?? null,
        parentPiSessionPath: opts.parentPiSessionPath ?? null,
        lineageKind: 'handoff',
        lineageSource: 'forum',
      });
    }
    this.store.setSessionAgentThread(session.id, 'echs', conversation.conversation_id);
    return conversation;
  }

  async isThreadLoaded(threadId: string): Promise<boolean> {
    const conversation = await this.client.getConversation(threadId);
    return Boolean(conversation);
  }

  /** Return stream liveness info for a topic (null if no active thread context). */
  getStreamLiveness(topicId: string): { lastStreamEventAt: string | null; streamAlive: boolean } | null {
    for (const ctx of this.threadMap.values()) {
      if (ctx.topicId === topicId) {
        const lastAt = ctx.lastStreamEventAt;
        const alive = lastAt != null && Date.now() - lastAt < 45_000;
        return {
          lastStreamEventAt: lastAt ? new Date(lastAt).toISOString() : null,
          streamAlive: alive,
        };
      }
    }
    return null;
  }

  async pauseActiveThreads(reason = 'deploy'): Promise<{ paused: number; skipped: number }> {
    let paused = 0;
    let skipped = 0;
    const active = this.listActiveTurns();
    for (const item of active) {
      try {
        await this.interruptTopic(item.topicId);
        paused += 1;
      } catch {
        skipped += 1;
      }
    }
    if (active.length === 0) {
      skipped = 0;
    }
    if (reason) {
      console.log(`[ECHS] pauseActiveThreads reason=${reason} paused=${paused} skipped=${skipped}`);
    }
    return { paused, skipped };
  }

  async resumeAllThreads(opts?: { sinceMs?: number }): Promise<{ resumed: number; skipped: number }> {
    const sessions = this.store.listSessionsWithThreads({
      ...(opts?.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
      backend: 'echs',
    });
    let resumed = 0;
    let skipped = 0;
    for (const session of sessions) {
      const threadId = session.agent_thread_id ?? null;
      if (!threadId) {
        skipped += 1;
        continue;
      }
      const conversation = await this.client.getConversation(threadId);
      if (!conversation) {
        console.warn(
          `[ECHS] resumeAllThreads: conversation missing for threadId=${threadId} topicId=${session.topic_id}, resetting`
        );
        this.store.clearSessionAgentThread(session.id);
        this.store.setRobotActivity(session.topic_id, 'idle');
        this.emitState(session.topic_id);
        skipped += 1;
        continue;
      }
      const activeThreadId = conversation.active_thread_id ?? null;
      let threadStatus: string | null = null;
      if (activeThreadId) {
        try {
          const threadState = await this.client.getThread(activeThreadId);
          threadStatus = threadState?.state?.status ?? null;
        } catch {
          threadStatus = null;
        }
      }
      this.threadMap.set(threadId, {
        topicId: session.topic_id,
        sessionId: session.id,
        activeThreadId,
        lastUserPostId: session.last_dispatched_post_id ?? null,
        turnParentPostId: session.last_dispatched_post_id ?? null,
        planId: this.store.getRobotState(session.topic_id)?.current_plan_id ?? null,
        reasoningSummary: '',
        reasoningBackfillAttempted: false,
        reasoningBackfillRetries: 0,
        model: this.config.model,
        reasoningEffort: this.config.reasoningEffort ?? null,
        currentTurnId: null,
        turnStartedAt: null,
        lastAssistantAt: null,
        lastUsage: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        activeSubagents: new Map(),
        lastStreamEventAt: null,
      });
      await this.ensureSubscribed(threadId);
      // Update stale last_dispatched_post_id if missing.
      if (!session.last_dispatched_post_id) {
        const latestPostId = this.store.getLatestPostId(session.topic_id);
        if (latestPostId) {
          this.store.setSessionLastDispatchedPostId(session.id, latestPostId);
        }
      }
      // If thread is running, keep robot state fresh.
      const status = threadStatus;
      if (status === 'running') {
        this.store.upsertRobotState({
          topicId: session.topic_id,
          sessionId: session.id,
          activity: 'thinking',
          model: this.config.model,
          reasoningEffort: this.config.reasoningEffort ?? null,
          currentPlanId: this.store.getRobotState(session.topic_id)?.current_plan_id ?? null,
        });
        this.emitState(session.topic_id);
      }
      resumed += 1;
    }
    return { resumed, skipped };
  }

  async sendUserMessage(
    topicId: string,
    body: string,
    parentPostId: string | null,
    options?: { model?: string | null; reasoningEffort?: string | null }
  ): Promise<void> {
    const session = this.store.ensureSession({ topicId });
    const turn: QueuedTurn = {
      topicId,
      sessionId: session.id,
      body,
      parentPostId,
      ...(options ? { options } : {}),
      queuedAt: new Date().toISOString(),
    };
    if (this.shouldQueueTurn()) {
      this.enqueueTurn(turn);
      return;
    }
    await this.dispatchUserMessage(turn);
  }

  async steerUserMessage(
    topicId: string,
    body: string,
    parentPostId: string | null,
    options?: { model?: string | null; reasoningEffort?: string | null }
  ): Promise<void> {
    const session = this.store.ensureSession({ topicId });
    const turn: QueuedTurn = {
      topicId,
      sessionId: session.id,
      body,
      parentPostId,
      options: { ...(options ?? {}), mode: 'steer' },
      queuedAt: new Date().toISOString(),
    };
    if (this.shouldQueueTurn()) {
      this.enqueueTurn(turn);
      return;
    }
    await this.dispatchUserMessage(turn);
  }

  async dispatchPostToAgent(
    topicId: string,
    postId: string,
    options?: { mode?: 'queue' | 'steer'; model?: string | null; reasoningEffort?: string | null }
  ): Promise<void> {
    const post = this.store.getPost(postId);
    if (!post || post.topic_id !== topicId) {
      throw new Error('post not found for dispatch');
    }
    const session = this.store.ensureSession({ topicId });
    const turn: QueuedTurn = {
      topicId,
      sessionId: session.id,
      body: post.body,
      parentPostId: post.id,
      options: { model: options?.model ?? null, reasoningEffort: options?.reasoningEffort ?? null, mode: options?.mode ?? 'queue' },
      queuedAt: new Date().toISOString(),
    };
    await this.dispatchUserMessage(turn);
  }

  async closeTopic(topicId: string): Promise<{ ok: boolean; message: string }> {
    const session = this.store.getSessionByTopic(topicId);
    const threadId = session?.agent_thread_id ?? null;
    if (!session || !threadId) {
      return { ok: false, message: 'No active Pi conversation for topic.' };
    }
    try {
      await this.client.closeConversation(threadId);
      this.cleanupDeadThread(threadId, topicId);
      this.store.clearSessionAgentThread(session.id);
      this.store.setRobotActivity(topicId, 'idle');
      this.emitState(topicId);
      return { ok: true, message: 'Session closed; Pi session_shutdown memory save requested.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Close failed.' };
    }
  }

  async interruptTopic(topicId: string): Promise<{ ok: boolean; message: string }> {
    const session = this.store.getSessionByTopic(topicId);
    const threadId = session?.agent_thread_id ?? null;
    if (!threadId) {
      return { ok: false, message: 'No active ECHS thread for topic.' };
    }
    try {
      await this.client.interruptConversation(threadId);
      return { ok: true, message: 'Interrupt requested.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Interrupt failed.' };
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.touchActiveRobotStates();
    }, ROBOT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private startHealthPoll(): void {
    if (this.healthPollTimer) return;
    const poll = async () => {
      try {
        const health = await this.client.checkHealth();
        this.echs_queue_depth = health?.queue_depth ?? null;
        this.echs_active_threads = health?.active_threads ?? null;
      } catch {
        this.echs_queue_depth = null;
        this.echs_active_threads = null;
      }
    };
    void poll();
    this.healthPollTimer = setInterval(() => {
      void poll();
    }, 30_000);
    this.healthPollTimer.unref?.();
  }

  private startThreadHealthCheck(): void {
    if (this.threadHealthTimer) return;
    this.threadHealthTimer = setInterval(() => {
      void this.verifyActiveThreadHealth();
    }, 30_000);
    this.threadHealthTimer.unref?.();
  }

  /**
   * Detect stale/dead SSE streams and resync with ECHS.
   *
   * ECHS sends `: keepalive` every 15 seconds.  If we haven't received
   * any SSE data (including keepalives) for 45s the stream is dead.
   * For truly active threads where the stream is alive but robot state
   * is out-of-sync, we poll ECHS directly to reconcile.
   */
  private async verifyActiveThreadHealth(): Promise<void> {
    const now = Date.now();
    for (const [threadId, ctx] of this.threadMap.entries()) {
      const state = this.store.getRobotState(ctx.topicId);
      if (!state || state.activity === 'idle') continue;

      // Two staleness thresholds:
      // 1. Stream dead: no SSE event (including keepalives) for >45s
      // 2. Soft stale: robot non-idle for >2min — poll ECHS to verify
      const streamDeadMs = 45_000;
      const softStaleMs = 2 * 60 * 1000;
      const lastEvent = ctx.lastStreamEventAt ?? 0;
      const streamAge = now - lastEvent;
      const lastUpdate = state.last_updated_at ? new Date(state.last_updated_at).getTime() : 0;
      const stateAge = now - lastUpdate;

      const streamDead = lastEvent > 0 && streamAge > streamDeadMs;
      const softStale = stateAge > softStaleMs;

      if (!streamDead && !softStale) continue;

      if (streamDead) {
        console.warn(
          `[ECHS] healthCheck: stream dead for ${Math.round(streamAge / 1000)}s threadId=${threadId} topicId=${ctx.topicId}`
        );
      }

      try {
        const conversation = await this.client.getConversation(threadId);
        if (!conversation) {
          console.warn(`[ECHS] healthCheck: conversation gone threadId=${threadId} topicId=${ctx.topicId}`);
          this.cleanupDeadThread(threadId, ctx.topicId);
          continue;
        }
        // Poll the actual thread status from ECHS
        const activeThreadId = conversation.active_thread_id;
        if (activeThreadId) {
          try {
            const threadState = await this.client.getThread(activeThreadId);
            if (threadState?.state?.status === 'idle') {
              console.warn(
                `[ECHS] healthCheck: ECHS idle but bridge active threadId=${threadId} topicId=${ctx.topicId}, resyncing`
              );
              this.store.setRobotActivity(ctx.topicId, 'idle');
              ctx.currentTurnId = null;
              ctx.turnStartedAt = null;
              this.activeTurnThreads.delete(threadId);
              this.emitState(ctx.topicId);
            }
          } catch {
            // Thread query failed — don't reset, just skip
          }
        }

        // If stream is dead, close and resubscribe so we get fresh events
        if (streamDead) {
          const sub = this.subscriptions.get(threadId);
          if (sub) {
            console.warn(`[ECHS] healthCheck: resubscribing dead stream threadId=${threadId}`);
            sub.close();
            this.subscriptions.delete(threadId);
            await this.ensureSubscribed(threadId, { replay: true });
          }
        }
      } catch (err) {
        console.warn(`[ECHS] healthCheck error for ${threadId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private cleanupDeadThread(threadId: string, topicId: string): void {
    const session = this.store.getSessionByTopic(topicId);
    if (session) {
      this.store.clearSessionAgentThread(session.id);
    }
    this.store.setRobotActivity(topicId, 'idle');
    this.threadMap.delete(threadId);
    this.activeTurnThreads.delete(threadId);
    const sub = this.subscriptions.get(threadId);
    if (sub) {
      sub.close();
      this.subscriptions.delete(threadId);
    }
    this.emitState(topicId);
  }

  private touchActiveRobotStates(): void {
    if (this.threadMap.size === 0 && this.turnQueue.length === 0) {
      return;
    }
    const topicIds = new Set<string>();
    for (const ctx of this.threadMap.values()) {
      topicIds.add(ctx.topicId);
    }
    for (const queued of this.turnQueue) {
      topicIds.add(queued.topicId);
    }
    for (const topicId of topicIds) {
      const state = this.store.getRobotState(topicId);
      if (!state || state.activity === 'idle') {
        continue;
      }
      if (state.activity === 'waiting') {
        const stillQueued = this.turnQueue.some((turn) => turn.topicId === topicId);
        if (!stillQueued) {
          continue;
        }
      }
      this.store.setRobotActivity(topicId, state.activity);
    }
  }

  private shouldQueueTurn(): boolean {
    if (this.turnQueue.length > 0 || this.drainingQueue) {
      return true;
    }
    const inFlight = this.activeTurnThreads.size + this.inflightDispatches;
    return inFlight >= this._maxConcurrentTurns;
  }

  private enqueueTurn(turn: QueuedTurn): void {
    this.turnQueue.push(turn);

    const model = turn.options?.model ?? this.config.model;
    const reasoningEffort = turn.options?.reasoningEffort ?? this.config.reasoningEffort ?? null;
    const currentPlanId = this.store.getRobotState(turn.topicId)?.current_plan_id ?? null;

    this.store.upsertRobotState({
      topicId: turn.topicId,
      sessionId: turn.sessionId,
      activity: 'waiting',
      model,
      reasoningEffort,
      currentPlanId,
    });
    this.emitState(turn.topicId);
    void this.processTurnQueue();
  }

  private async processTurnQueue(): Promise<void> {
    if (this.drainingQueue) return;
    this.drainingQueue = true;
    try {
      while (this.turnQueue.length > 0) {
        const inFlight = this.activeTurnThreads.size + this.inflightDispatches;
        if (inFlight >= this._maxConcurrentTurns) {
          break;
        }
        const next = this.turnQueue.shift();
        if (!next) break;
        try {
          await this.dispatchUserMessage(next);
        } catch (err) {
          console.warn('Failed to dispatch queued turn:', err instanceof Error ? err.message : err);
          const state = this.store.getRobotState(next.topicId);
          if (state) {
            this.store.setRobotActivity(next.topicId, 'idle');
            this.emitState(next.topicId);
          }
        }
      }
    } finally {
      this.drainingQueue = false;
      if (
        this.turnQueue.length > 0 &&
        this.activeTurnThreads.size + this.inflightDispatches < this._maxConcurrentTurns
      ) {
        void this.processTurnQueue();
      }
    }
  }

  private scheduleAssistantBackfill(
    threadId: string,
    turn: { topicId: string; sessionId: string; parentPostId: string | null }
  ): void {
    const existing = this.assistantBackfillTimers.get(threadId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.assistantBackfillTimers.delete(threadId);
      const ctx = this.threadMap.get(threadId);
      if (!ctx || ctx.currentTurnId) {
        return;
      }
      if (ctx.lastAssistantAt && ctx.turnStartedAt && ctx.lastAssistantAt >= ctx.turnStartedAt) {
        return;
      }
      void this.ensureAssistantBackfill(threadId, ctx, ctx.turnStartedAt, ctx.turnParentPostId ?? turn.parentPostId);
    }, 30_000);
    timer.unref?.();
    this.assistantBackfillTimers.set(threadId, timer);
  }

  private async dispatchUserMessage(turn: QueuedTurn): Promise<void> {
    this.inflightDispatches += 1;
    try {
      const { topicId, body, parentPostId, options } = turn;
      const session = this.store.getSession(turn.sessionId) ?? this.store.ensureSession({ topicId });
      const piSessionLink = this.store.getPiSessionLinkByTopic(topicId);
      const model = options?.model ?? this.config.model;
      const reasoningEffort = options?.reasoningEffort ?? this.config.reasoningEffort ?? null;
      let threadId = session.agent_thread_id;
      let isFirstMessage = !threadId;
      const topic = this.store.getTopic(topicId);
      const forum = topic ? this.store.getForum(topic.forum_id) : null;
      const cwd = forum?.cwd ?? this.config.workDir;
      const forumId = topic?.forum_id ?? null;
      const now = new Date().toISOString();
      const pendingMove = forumId ? this.store.getPendingTopicMove(topicId) : null;
      let pendingMoveToClear: string | null = null;

      const actorId = parentPostId ? (this.store.getPost(parentPostId)?.author_id ?? null) : null;

      if (threadId) {
        const conversation = await this.client.getConversation(threadId);
        if (!conversation) {
          // ECHS conversation is gone — clean up stale references
          this.cleanupDeadThread(threadId, topicId);
          threadId = null;
          isFirstMessage = true;
        }
      }
      writeRequesterMetadataFile({
        cwd,
        topicId,
        parentPostId,
        requesterIdentityId: actorId,
        requestedAtIso: now,
        store: this.store,
      });

      const maxPostChars = clampPositiveInt(this.config.maxPostChars, 80_000);
      const maxTurnChars = clampPositiveInt(this.config.maxTurnChars, 240_000);
      let preludeText: string | null = null;

      const attributionHint =
        'Attribution hint: read `.codex-forum/requester.json` for the latest requester info (use for Co-authored-by trailer when making commits).';

      const triggerPost = parentPostId ? this.store.getPost(parentPostId) : null;
      const triggerAuthor = triggerPost ? this.store.getIdentity(triggerPost.author_id) : null;
      const triggerBody = triggerPost?.body ?? body;
      let userBodyForEchs = truncateWithMarker(
        triggerBody,
        maxPostChars,
        '[POST TRUNCATED: consider uploading a file or attachment instead of pasting extremely long text]'
      );
      const personas = forumId ? this.store.listRobotPersonas(forumId) : [];
      if (forumId && personas.length > 0) {
        writePersonaSoulFiles({ cwd, personas: personas.map((p) => ({ key: p.key, soul: p.soul })) });
      }

      const buildBaseInstructions = () => {
        const forumPrePrompt = forum?.pre_prompt?.trim() ? `Forum instructions:\n${forum.pre_prompt.trim()}` : null;
        const personaIndex = forumId
          ? [
              'If you want to write as multiple personas in one reply, use one or more blocks like:',
              '[[persona:<persona_key>]]',
              '...message content...',
              '[[/persona]]',
              '',
              'Only use persona keys from the injected persona index/update blocks.',
              '',
              renderPersonaIndexMarkdown(
                personas.map((p) => ({
                  key: p.key,
                  displayName: p.displayName,
                  description: p.description,
                  soul: p.soul,
                }))
              ),
            ].join('\n')
          : null;
        const agentGuidance = buildAgentGuidanceInstructions(cwd, Math.min(maxTurnChars, 80_000));
        const baseInstructions = [
          agentGuidance,
          this.config.baseInstructions,
          this.config.developerInstructions,
          forumPrePrompt,
          personaIndex,
          topic?.title ? `Thread title: ${topic.title}` : null,
          [
            'Forum protocol:',
            '- This is a forum topic with multiple participants; each inbound turn may come from a different author.',
            '- Inbound turns may include [FORUM TURN] / [POST] metadata blocks; treat them as authoritative context.',
            '- Do not quote metadata blocks in your public reply; respond to the latest [POST] unless instructed otherwise.',
          ].join('\n'),
          [
            'Commit attribution:',
            '- The latest forum requester metadata is written to `.codex-forum/requester.json` (updated per user request).',
            '- If you create git commits in response to a forum request and the requester has a robot-only email set, add exactly one trailer line:',
            '  Co-authored-by: <forum_username> <requester_email>',
            '- If the requester has no robot-only email set, do not add a co-author trailer.',
          ].join('\n'),
        ]
          .filter(Boolean)
          .join('\n\n');
        return baseInstructions.length > 0 ? baseInstructions : null;
      };

      const createConversation = async () => {
        const instructions = buildBaseInstructions();
        let conversationId: string;
        if (piSessionLink) {
          const conversation = await this.client.openConversation({
            piSessionId: piSessionLink.pi_session_id,
            piSessionPath: piSessionLink.pi_session_path,
            cwd,
          });
          conversationId = conversation.conversation_id;
        } else {
          conversationId = await this.client.createConversation({
            model,
            ...(reasoningEffort ? { reasoning: reasoningEffort } : {}),
            cwd,
            ...(instructions != null ? { instructions } : {}),
          });
          const conversation = await this.client.getConversation(conversationId);
          if (conversation?.session_id && conversation.session_path) {
            this.store.upsertPiSessionLink({
              piSessionId: conversation.session_id,
              piSessionPath: conversation.session_path,
              topicId,
              sessionId: session.id,
              cwd: conversation.cwd ?? cwd,
              kind: 'normal',
              metadata: { source: 'forum-created' },
            });
          }
        }
        this.store.setSessionAgentThread(session.id, 'echs', conversationId);

        if (forumId) {
          this.store.setSessionPersonasSyncedAt(session.id, now);
        }
        if (pendingMove) {
          pendingMoveToClear = pendingMove.id;
        }
        return conversationId;
      };

      if (!threadId) {
        threadId = await createConversation();
      } else {
        if (forumId) {
          if (pendingMove) {
            const fromForum = this.store.getForum(pendingMove.fromForumId);
            const movedByIdentity = this.store.getIdentity(pendingMove.movedBy);
            const moveOverlay = buildThreadMoveOverlay({
              fromForumName: fromForum?.name ?? 'unknown forum',
              toForumName: forum?.name ?? 'unknown forum',
              movedBy: movedByIdentity?.display_name ?? 'admin',
              movedAt: pendingMove.movedAt,
              forumPrePrompt: forum?.pre_prompt ?? null,
              personas,
            });
            preludeText = moveOverlay;
            this.store.setSessionPersonasSyncedAt(session.id, now);
            pendingMoveToClear = pendingMove.id;
          } else {
            const sessionRow = this.store.getSession(session.id);
            const lastSynced = sessionRow?.personas_synced_at ?? null;
            const needsFullIndex = !lastSynced;
            const updated = needsFullIndex ? personas : this.store.listRobotPersonasUpdatedSince(forumId, lastSynced);
            if (updated.length > 0) {
              const updateHeader = needsFullIndex ? '[PERSONA INDEX]' : '[PERSONA UPDATE]';
              const updateFooter = needsFullIndex ? '[/PERSONA INDEX]' : '[/PERSONA UPDATE]';
              const updateText = renderPersonaIndexMarkdown(
                updated.map((p) => ({
                  key: p.key,
                  displayName: p.displayName,
                  description: p.description,
                  soul: p.soul,
                }))
              );
              preludeText = `${updateHeader}\n${updateText}${updateFooter}`;
              this.store.setSessionPersonasSyncedAt(session.id, now);
            }
          }
        }
      }

      const lastDispatchedPostId = session.last_dispatched_post_id ?? null;
      const catchupPosts =
        parentPostId && topic
          ? this.store.listPostsBetween(topicId, { afterPostId: lastDispatchedPostId, beforePostId: parentPostId })
          : [];
      let catchupText =
        catchupPosts.length > 0
          ? this.formatCatchupContext({
              topicId,
              posts: catchupPosts,
              maxPostChars,
              apiBaseUrl: this.config.apiBaseUrl ?? null,
            })
          : null;

      if (catchupText && isFirstMessage) {
        catchupText = [
          `[THREAD CONTEXT: ${topic?.title ?? topicId}]`,
          'You are currently in the thread above; you are "robot".',
          catchupText,
        ].join('\n');
      }

      const triggerAuthorName = triggerAuthor?.display_name ?? 'unknown';
      const triggerAuthorUsername = triggerAuthor?.username ?? null;
      const triggerAuthorKind = triggerAuthor?.kind ?? null;
      const triggerPostId = triggerPost?.id ?? parentPostId ?? 'unknown';
      const triggerPostCreatedAt = triggerPost?.created_at ?? now;
      const triggerPostParentId = triggerPost?.parent_post_id ?? null;
      const triggerFlags: string[] = [];
      if (triggerPost?.silent) triggerFlags.push('silent');
      if (triggerPost?.deleted_at) triggerFlags.push('deleted');
      const triggerAttachments = triggerPost
        ? this.store.listAttachmentsByPost(triggerPost.id).map((attachment) => ({
            id: attachment.id,
            postId: attachment.post_id,
            filename: attachment.filename,
            mimeType: attachment.mime_type,
            sizeBytes: attachment.size_bytes,
            storagePath: attachment.storage_path,
            sha256: attachment.sha256 ?? null,
            url: this.config.apiBaseUrl?.trim()
              ? `${this.config.apiBaseUrl.trim().replace(/\/$/, '')}/attachments/${attachment.id}`
              : `/attachments/${attachment.id}`,
          }))
        : [];

      const forumTurnMetadata = [
        '[FORUM TURN]',
        `topicId=${topicId}`,
        ...(topic?.title ? [`topicTitle=${topic.title}`] : []),
        `postId=${triggerPostId}`,
        ...(triggerPostParentId ? [`parentPostId=${triggerPostParentId}`] : []),
        '[/FORUM TURN]',
      ].join('\n');

      const buildTriggerEnvelope = (bodyText: string) =>
        formatForumPostEnvelope({
          postId: triggerPostId,
          createdAt: triggerPostCreatedAt,
          parentPostId: triggerPostParentId,
          flags: triggerFlags,
          author: {
            displayName: triggerAuthorName,
            username: triggerAuthorUsername,
            identityId: triggerAuthor?.id ?? actorId ?? 'unknown',
            kind: triggerAuthorKind,
          },
          body: bodyText,
          maxPostChars,
          attachments: triggerAttachments,
        });

      let triggerEnvelope = buildTriggerEnvelope(userBodyForEchs);
      let turnBlock = `${forumTurnMetadata}\n\n${triggerEnvelope}`;
      let envelopeOverhead = turnBlock.length - userBodyForEchs.length;
      const prefixParts = [attributionHint, preludeText ? preludeText : null].filter(Boolean);
      const prefix = prefixParts.join('\n\n');

      if (prefix.length + envelopeOverhead + userBodyForEchs.length > maxTurnChars) {
        const allowed = Math.max(200, maxTurnChars - prefix.length - envelopeOverhead);
        userBodyForEchs = truncateWithMarker(
          userBodyForEchs,
          allowed,
          '[POST TRUNCATED: exceeded per-turn size limit; ask the user to upload a file]'
        );
        triggerEnvelope = buildTriggerEnvelope(userBodyForEchs);
        turnBlock = `${forumTurnMetadata}\n\n${triggerEnvelope}`;
        envelopeOverhead = turnBlock.length - userBodyForEchs.length;
      }

      let middle = '';
      if (catchupText) {
        const remaining = maxTurnChars - prefix.length - turnBlock.length;
        const allowed = Math.max(0, remaining - 2);
        const clippedCatchup =
          allowed > 0
            ? truncateWithMarker(catchupText, allowed, '[CATCH-UP CONTEXT TRUNCATED: exceeded per-turn size limit]')
            : '[CATCH-UP CONTEXT OMITTED: exceeded per-turn size limit]';
        middle = clippedCatchup;
      }

      let messageBody = [prefix, middle, turnBlock].filter(Boolean).join('\n\n');

      const existingCtx = this.threadMap.get(threadId);
      const threadCtx: ThreadContext = {
        topicId,
        sessionId: session.id,
        activeThreadId: existingCtx?.activeThreadId ?? null,
        lastUserPostId: parentPostId,
        turnParentPostId: parentPostId,
        planId: null,
        reasoningSummary: '',
        reasoningBackfillAttempted: false,
        reasoningBackfillRetries: 0,
        model,
        reasoningEffort,
        currentTurnId: null,
        turnStartedAt: null,
        lastAssistantAt: existingCtx?.lastAssistantAt ?? null,
        lastUsage: existingCtx?.lastUsage ?? null,
        totalInputTokens: existingCtx?.totalInputTokens ?? 0,
        totalOutputTokens: existingCtx?.totalOutputTokens ?? 0,
        activeSubagents: existingCtx?.activeSubagents ?? new Map(),
        lastStreamEventAt: existingCtx?.lastStreamEventAt ?? null,
      };
      this.threadMap.set(threadId, threadCtx);

      this.store.upsertRobotState({
        topicId,
        sessionId: session.id,
        activity: 'thinking',
        model,
        reasoningEffort,
        currentPlanId: null,
      });
      this.emitState(topicId);

      this.bus.emit(topicId, { type: 'assistant_reset', data: { reason: 'new_turn' } });

      const tamperContext: MessageTamperContext = {
        topicId,
        sessionId: session.id,
        forumId,
        parentPostId,
        actorId,
        metadata: { isFirstMessage },
      };

      const tampered = await this.tamperLayer.run({
        stage: 'inbound.user_to_codex',
        direction: 'inbound',
        text: messageBody,
        context: tamperContext,
      });
      messageBody = tampered.text;
      this.persistTamperTrail({
        topicId,
        sessionId: session.id,
        postId: parentPostId,
        sessionMessageId: null,
        trail: tampered.trail,
      });

      const configure: Record<string, unknown> = {
        cwd,
        workdir: cwd,
        model,
        reasoning: reasoningEffort,
      };
      const requestedMode = options?.mode ?? 'queue';
      const resolveEnqueueMode = (targetThreadId: string, firstMessage: boolean): 'queue' | 'steer' => {
        const canSteer = requestedMode === 'steer' && !firstMessage && this.activeTurnThreads.has(targetThreadId);
        return canSteer ? 'steer' : 'queue';
      };
      await this.ensureSubscribed(threadId, { replay: isFirstMessage });
      let enqueueMode = resolveEnqueueMode(threadId, isFirstMessage);
      let enqueueResult: Awaited<ReturnType<EchsClient['enqueueConversationMessage']>>;
      try {
        enqueueResult = await this.client.enqueueConversationMessage(threadId, messageBody, {
          mode: enqueueMode,
          configure,
          attachments: triggerAttachments,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('conversation not found') || message.includes('ECHS 404')) {
          console.warn(`[ECHS] conversation missing for topic ${topicId}; recreating thread`);
          this.threadMap.delete(threadId);
          this.activeTurnThreads.delete(threadId);
          threadId = await createConversation();
          isFirstMessage = true;
          threadCtx.activeThreadId = null;
          this.threadMap.set(threadId, threadCtx);
          await this.ensureSubscribed(threadId, { replay: true });
          enqueueMode = resolveEnqueueMode(threadId, isFirstMessage);
          enqueueResult = await this.client.enqueueConversationMessage(threadId, messageBody, {
            mode: enqueueMode,
            configure,
            attachments: triggerAttachments,
          });
        } else {
          throw err;
        }
      }
      const messageId = enqueueResult.messageId;
      this.schedulePlanSync(threadId);
      if (parentPostId) {
        this.store.setSessionLastDispatchedPostId(session.id, parentPostId);
      }
      const ctx = this.threadMap.get(threadId);
      if (ctx) {
        ctx.currentTurnId = messageId;
        if (enqueueResult.threadId) {
          ctx.activeThreadId = enqueueResult.threadId;
        }
        ctx.turnStartedAt = Date.now();
      }
      this.activeTurnThreads.add(threadId);
      this.scheduleAssistantBackfill(threadId, {
        topicId,
        sessionId: session.id,
        parentPostId,
      });
      if (pendingMoveToClear) {
        this.store.clearTopicMovePrompt(pendingMoveToClear);
      }
    } finally {
      this.inflightDispatches = Math.max(0, this.inflightDispatches - 1);
    }
  }

  private async ensureSubscribed(threadId: string, opts?: { replay?: boolean }): Promise<void> {
    const existing = this.subscriptions.get(threadId);
    if (existing) {
      await this.waitForSubscriptionReady(existing.ready);
      return;
    }
    const options = { lastEventId: (opts?.replay ? '0' : null) as string | null };
    const subscription = this.client.subscribeConversation(
      threadId,
      (event) => this.handleEvent(threadId, event),
      options
    );
    this.subscriptions.set(threadId, {
      close: subscription.close,
      ready: subscription.ready,
      lastEventId: null,
      options,
    });
    await this.waitForSubscriptionReady(subscription.ready);
  }

  private async waitForSubscriptionReady(ready: Promise<void>): Promise<void> {
    const timeoutMs = 8000;
    try {
      await Promise.race([
        ready,
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch {
      // Ignore readiness failures; we will retry on reconnect.
    }
  }

  private handleEvent(threadId: string, event: EchsEvent): void {
    const ctx = this.threadMap.get(threadId);
    if (!ctx) return;

    // Track stream liveness — updated on every event including keepalives.
    ctx.lastStreamEventAt = Date.now();

    // Keepalive comments from ECHS are only for liveness tracking.
    if (event.event === '__keepalive') return;

    try {
      this._processEvent(threadId, ctx, event);
    } catch (err) {
      console.error(
        `[ECHS] handleEvent error thread=${threadId} event=${event.event}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private _processEvent(threadId: string, ctx: ThreadContext, event: EchsEvent): void {
    const eventData = event.data as any;
    const activeThreadId = eventData?.thread_id ?? eventData?.threadId ?? null;
    if (activeThreadId) {
      ctx.activeThreadId = activeThreadId;
    }

    const sub = this.subscriptions.get(threadId);
    if (sub && event.id) {
      sub.lastEventId = event.id;
      sub.options.lastEventId = event.id;
    }

    switch (event.event) {
      case 'turn_started': {
        const data = event.data as any;
        ctx.currentTurnId = data?.message_id ?? data?.messageId ?? ctx.currentTurnId;
        ctx.turnStartedAt = Date.now();
        this.activeTurnThreads.add(threadId);
        this.store.upsertRobotState({
          topicId: ctx.topicId,
          sessionId: ctx.sessionId,
          activity: 'thinking',
          model: ctx.model,
          reasoningEffort: ctx.reasoningEffort,
          currentPlanId: ctx.planId,
        });
        this.emitState(ctx.topicId);
        break;
      }
      case 'turn_delta': {
        const data = event.data as any;
        if (data?.content) {
          this.bus.emit(ctx.topicId, { type: 'assistant_delta', data: { delta: data.content } });
        }
        break;
      }
      case 'reasoning_delta': {
        const data = event.data as any;
        const delta = typeof data?.delta === 'string' ? data.delta : '';
        if (delta) {
          this.handleReasoningDelta(ctx, delta);
        }
        break;
      }
      case 'item_started': {
        const data = event.data as any;
        const item = data?.item;
        if (!item?.type) break;
        if (item.type === 'function_call' || item.type === 'local_shell_call') {
          const callId = item.call_id ?? item.id;
          const tool = mapEchsToolName(item.name ?? item.type);
          const command = formatEchsToolCommand(item);
          const toolRun = this.store.createToolRun({
            topicId: ctx.topicId,
            sessionId: ctx.sessionId,
            tool,
            parentPostId: ctx.lastUserPostId,
            command,
            outputSummary: null,
            visibility: 'internal',
          });
          if (callId) {
            this.toolRunByCallId.set(callId, toolRun.id);
          }
          // Notify the client that a new tool started — this arrives before
          // the state event and lets the client record checkpoints for
          // reasoning/text interleaving.
          this.bus.emit(ctx.topicId, {
            type: 'tool_started',
            data: { toolRunId: toolRun.id, tool, callId: callId ?? null },
          });
          if (ctx.currentTurnId !== null) {
            this.store.upsertRobotState({
              topicId: ctx.topicId,
              sessionId: ctx.sessionId,
              activity: 'running_tools',
              model: ctx.model,
              reasoningEffort: ctx.reasoningEffort,
              currentPlanId: ctx.planId,
            });
            this.emitState(ctx.topicId);
          }
        }
        break;
      }
      case 'tool_updated': {
        const data = event.data as any;
        const callId = data?.call_id ?? data?.callId;
        if (callId) {
          const toolRunId = this.toolRunByCallId.get(callId);
          if (toolRunId) {
            const rawSummary = summarizeToolResult(data?.partial_result ?? data?.partialResult);
            const { text: summary, redacted } = redactSensitiveData(rawSummary);
            this.store.updateToolRun(toolRunId, {
              output_summary: truncateText(summary, 1000),
              redactions_applied: redacted ? 1 : 0,
            });
            this.emitState(ctx.topicId);
          }
        }
        break;
      }
      case 'tool_completed': {
        const data = event.data as any;
        const callId = data?.call_id ?? data?.callId;
        if (callId) {
          const toolRunId = this.toolRunByCallId.get(callId);
          if (toolRunId) {
            const rawSummary = summarizeToolResult(data?.result);
            const { text: summary, redacted } = redactSensitiveData(rawSummary);
            this.store.updateToolRun(toolRunId, {
              finished_at: new Date().toISOString(),
              exit_code: data?.is_error || data?.isError ? 1 : null,
              output_summary: truncateText(summary, 1000),
              redactions_applied: redacted ? 1 : 0,
            });
            // Detect spawn_agent completion by checking for agent_id in result
            const parsedResult = typeof data?.result === 'string' ? safeJsonParse(data.result) : data?.result;
            const agentId = parsedResult?.agent_id ?? null;
            if (agentId && typeof agentId === 'string') {
              this.spawnToolRunByAgentId.set(agentId, toolRunId);
              // Overwrite raw JSON with cleaner placeholder
              this.store.updateToolRun(toolRunId, {
                output_summary: `Subagent started (${agentId}). Awaiting completion…`,
              });
            }
          }
        }
        if (ctx.currentTurnId !== null) {
          this.store.upsertRobotState({
            topicId: ctx.topicId,
            sessionId: ctx.sessionId,
            activity: 'thinking',
            model: ctx.model,
            reasoningEffort: ctx.reasoningEffort,
            currentPlanId: ctx.planId,
          });
          this.emitState(ctx.topicId);
        }
        break;
      }
      case 'item_completed': {
        const data = event.data as any;
        const item = data?.item;
        if (item?.type === 'reasoning' && !ctx.reasoningSummary) {
          const summary = extractReasoningSummary(item);
          if (summary) {
            this.handleReasoningDelta(ctx, summary);
          }
        }
        if (item?.type === 'message' && item?.role === 'assistant') {
          const text = extractAssistantText(item);
          if (text?.trim()) {
            this.persistAssistantMessage(threadId, ctx, text).catch(() => undefined);
            void this.syncReasoningFromHistory(threadId, ctx);
            void this.forceReasoningBackfill(threadId);
            setTimeout(() => {
              void this.forceReasoningBackfill(threadId);
            }, 6000);
          }
        }
        break;
      }
      case 'turn_completed': {
        const turnStartedAt = ctx.turnStartedAt;
        const turnParentPostId = ctx.turnParentPostId;
        ctx.currentTurnId = null;
        ctx.turnStartedAt = null;
        void this.forceReasoningBackfill(threadId);
        this.store.upsertRobotState({
          topicId: ctx.topicId,
          sessionId: ctx.sessionId,
          activity: 'idle',
          model: ctx.model,
          reasoningEffort: ctx.reasoningEffort,
          currentPlanId: ctx.planId,
        });
        this.emitState(ctx.topicId);
        this.activeTurnThreads.delete(threadId);
        void this.processTurnQueue();
        setTimeout(() => {
          void this.ensureAssistantBackfill(threadId, ctx, turnStartedAt, turnParentPostId);
        }, 1000);
        break;
      }
      case 'turn_interrupted': {
        ctx.currentTurnId = null;
        ctx.turnStartedAt = null;
        this.store.upsertRobotState({
          topicId: ctx.topicId,
          sessionId: ctx.sessionId,
          activity: 'idle',
          model: ctx.model,
          reasoningEffort: ctx.reasoningEffort,
          currentPlanId: ctx.planId,
        });
        this.emitState(ctx.topicId);
        this.bus.emit(ctx.topicId, { type: 'assistant_reset', data: { reason: 'interrupted' } });
        this.activeTurnThreads.delete(threadId);
        void this.processTurnQueue();
        break;
      }
      case 'turn_usage': {
        const data = event.data as any;
        const usage = data?.usage;
        if (usage && typeof usage === 'object') {
          ctx.lastUsage = {
            input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
            output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
            total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          };
          if (typeof usage.input_tokens === 'number') {
            ctx.totalInputTokens += usage.input_tokens;
          }
          if (typeof usage.output_tokens === 'number') {
            ctx.totalOutputTokens += usage.output_tokens;
          }
          this.emitState(ctx.topicId);
        }
        break;
      }
      case 'session_compacted': {
        const data = event.data as any;
        const newThreadId = data?.thread_id ?? null;
        if (newThreadId) {
          ctx.activeThreadId = newThreadId;
          this.store.setSessionAgentThread(ctx.sessionId, 'echs', newThreadId);
          console.log(
            `[ECHS] context compacted conversation=${threadId} topic=${ctx.topicId} new_thread=${newThreadId}`
          );
        }
        break;
      }
      case 'turn_error': {
        const data = event.data as any;
        const errorValue = data?.error ?? 'unknown error';
        const errorMsg = typeof errorValue === 'string' ? errorValue : safeJson(errorValue);
        console.error(`[ECHS] turn_error topic=${ctx.topicId} thread=${threadId} error=${errorMsg}`);
        const failedTurnId = ctx.currentTurnId;
        ctx.currentTurnId = null;
        ctx.turnStartedAt = null;
        this.store.setRobotTurnError(ctx.topicId, {
          message: errorMsg,
          postId: ctx.turnParentPostId ?? ctx.lastUserPostId ?? null,
          turnId: failedTurnId,
        });
        this.emitState(ctx.topicId);
        this.bus.emit(ctx.topicId, {
          type: 'assistant_error',
          data: { error: errorMsg, thread_id: threadId },
        });
        this.activeTurnThreads.delete(threadId);
        void this.processTurnQueue();
        break;
      }
      case 'subagent_spawned': {
        const data = event.data as any;
        const agentId = data?.agent_id;
        const task = data?.task ?? '';
        if (agentId) {
          ctx.activeSubagents.set(agentId, { task, startedAt: Date.now() });
          this.emitState(ctx.topicId);
        }
        break;
      }
      case 'subagent_down': {
        const data = event.data as any;
        const agentId = data?.agent_id;
        if (agentId) {
          ctx.activeSubagents.delete(agentId);
          void this.enrichSubagentToolRun(agentId, ctx);
          this.emitState(ctx.topicId);
        }
        break;
      }
      case 'events_gap': {
        const data = event.data as any;
        console.warn(
          `[ECHS] events_gap topic=${ctx.topicId} thread=${threadId} oldest_available=${data?.oldest_available} requested_after=${data?.requested_after}`
        );
        const turnStartedAt = ctx.turnStartedAt;
        const turnParentPostId = ctx.turnParentPostId;
        void this.ensureAssistantBackfill(threadId, ctx, turnStartedAt, turnParentPostId);
        void this.syncReasoningFromHistory(threadId, ctx);
        break;
      }
      default:
        break;
    }
  }

  private resolvePlanContext(threadId: string, ctx: ThreadContext | null): PlanContext | null {
    if (ctx) {
      return {
        topicId: ctx.topicId,
        sessionId: ctx.sessionId,
        parentPostId: ctx.lastUserPostId ?? null,
      };
    }
    const session = this.store.getSessionByAgentThreadId(threadId);
    if (!session) return null;
    const parentPostId =
      this.store.getLatestHumanPostId(session.topic_id) ?? this.store.getLatestPostId(session.topic_id);
    return {
      topicId: session.topic_id,
      sessionId: session.id,
      parentPostId,
    };
  }

  private upsertPlanForSummary(planContext: PlanContext, summary: string, preferredPlanId?: string | null): string {
    const parentPostId = planContext.parentPostId ?? null;
    let plan = preferredPlanId ? this.store.getPlan(preferredPlanId) : null;
    if (plan && parentPostId && plan.parent_post_id !== parentPostId) {
      plan = null;
    }
    if (!plan && parentPostId) {
      const existing = this.store
        .listPlansBySession(planContext.sessionId, 25)
        .find((row) => row.parent_post_id === parentPostId);
      if (existing) {
        plan = existing;
      }
    }
    if (!plan) {
      const created = this.store.createPlan({
        topicId: planContext.topicId,
        sessionId: planContext.sessionId,
        content: summary,
        summary,
        parentPostId,
        visibility: 'internal',
      });
      return created.id;
    }
    this.store.updatePlan(plan.id, summary, summary);
    return plan.id;
  }

  private upsertRobotStateForPlan(
    planContext: PlanContext,
    planId: string,
    opts?: { activity?: string; model?: string | null; reasoningEffort?: string | null }
  ): void {
    const current = this.store.getRobotState(planContext.topicId);
    this.store.upsertRobotState({
      topicId: planContext.topicId,
      sessionId: planContext.sessionId,
      activity: opts?.activity ?? current?.activity ?? 'idle',
      model: opts?.model ?? current?.model ?? this.config.model,
      reasoningEffort: opts?.reasoningEffort ?? current?.reasoning_effort ?? this.config.reasoningEffort ?? null,
      currentPlanId: planId,
    });
  }

  private ensurePlanForSummary(ctx: ThreadContext, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    const planContext = {
      topicId: ctx.topicId,
      sessionId: ctx.sessionId,
      parentPostId: ctx.lastUserPostId ?? null,
    };
    const planId = this.upsertPlanForSummary(planContext, summary, ctx.planId);
    ctx.planId = planId;
    this.upsertRobotStateForPlan(planContext, planId, {
      activity: 'thinking',
      model: ctx.model,
      reasoningEffort: ctx.reasoningEffort,
    });
  }

  private handleReasoningDelta(ctx: ThreadContext, delta: string): void {
    ctx.reasoningSummary += delta;
    this.ensurePlanForSummary(ctx, ctx.reasoningSummary);
    this.emitState(ctx.topicId);
    this.bus.emit(ctx.topicId, { type: 'reasoning_delta', data: { delta } });
  }

  private schedulePlanSync(threadId: string): void {
    const delayMs = 2000;
    setTimeout(() => {
      void this.forceReasoningBackfill(threadId);
    }, delayMs);
  }

  private async forceReasoningBackfill(threadId: string): Promise<void> {
    const ctx = this.threadMap.get(threadId) ?? null;
    const planContext = this.resolvePlanContext(threadId, ctx);
    if (!planContext) return;
    const getRetries = () =>
      ctx ? ctx.reasoningBackfillRetries : (this.reasoningBackfillRetriesByThread.get(threadId) ?? 0);
    const setRetries = (value: number) => {
      if (ctx) {
        ctx.reasoningBackfillRetries = value;
      } else {
        this.reasoningBackfillRetriesByThread.set(threadId, value);
      }
    };
    const scheduleRetry = () => {
      const retries = getRetries();
      if (retries >= 5) return;
      const next = retries + 1;
      setRetries(next);
      const delayMs = 2000 * next;
      setTimeout(() => {
        void this.forceReasoningBackfill(threadId);
      }, delayMs);
    };
    try {
      const synced = await this.syncReasoningFromHistory(threadId, ctx, planContext);
      if (synced) {
        setRetries(0);
        if (!ctx) {
          this.reasoningBackfillRetriesByThread.delete(threadId);
        }
        return;
      }
      scheduleRetry();
    } catch {
      // Swallow: streaming may have already captured reasoning.
      scheduleRetry();
    }
  }

  private async backfillReasoningSummary(threadId: string, ctx: ThreadContext): Promise<void> {
    if (ctx.planId || ctx.reasoningSummary.trim() || ctx.reasoningBackfillAttempted) {
      return;
    }
    ctx.reasoningBackfillAttempted = true;
    const scheduleRetry = () => {
      if (ctx.planId || ctx.reasoningSummary.trim()) return;
      if (ctx.reasoningBackfillRetries >= 3) return;
      ctx.reasoningBackfillRetries += 1;
      const delayMs = 250 * ctx.reasoningBackfillRetries;
      setTimeout(() => {
        void this.backfillReasoningSummary(threadId, ctx);
      }, delayMs);
    };
    try {
      const synced = await this.syncReasoningFromHistory(threadId, ctx);
      if (synced) {
        ctx.reasoningBackfillAttempted = false;
        return;
      }
      ctx.reasoningBackfillAttempted = false;
      scheduleRetry();
    } catch {
      // Ignore backfill errors; future turns can attempt again.
      ctx.reasoningBackfillAttempted = false;
      scheduleRetry();
    }
  }

  private emitState(topicId: string): void {
    const state = this.store.getRobotState(topicId);
    if (!state) {
      return;
    }
    const plan = state.current_plan_id ? this.store.getPlan(state.current_plan_id) : null;
    const toolRuns = this.store.listToolRuns(topicId, 10).map((run) => ({
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
    }));

    let usage: ThreadContext['lastUsage'] | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let subagentCount: number | undefined;
    for (const ctx of this.threadMap.values()) {
      if (ctx.topicId === topicId) {
        usage = ctx.lastUsage ?? undefined;
        totalInputTokens = ctx.totalInputTokens || undefined;
        totalOutputTokens = ctx.totalOutputTokens || undefined;
        subagentCount = ctx.activeSubagents.size || undefined;
        break;
      }
    }

    this.bus.emit(topicId, {
      type: 'state',
      data: {
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
        currentPlan: plan
          ? {
              id: plan.id,
              content: plan.content,
              summary: plan.summary,
              parentPostId: plan.parent_post_id,
              visibility: plan.visibility,
              createdAt: plan.created_at,
              updatedAt: plan.updated_at,
            }
          : null,
        recentToolRuns: toolRuns,
        usage,
        totalInputTokens,
        totalOutputTokens,
        subagentCount,
      },
    });
  }

  private async persistAssistantMessage(
    threadId: string,
    ctx: ThreadContext,
    text: string,
    opts?: { parentPostId?: string | null }
  ): Promise<void> {
    let finalText = text;

    const topic = this.store.getTopic(ctx.topicId);
    const forumId = topic?.forum_id ?? null;

    const tamperContext: MessageTamperContext = {
      topicId: ctx.topicId,
      sessionId: ctx.sessionId,
      forumId,
      parentPostId: opts?.parentPostId ?? ctx.lastUserPostId,
      actorId: null,
    };

    const stage1 = await this.tamperLayer.run({
      stage: 'outbound.codex_to_forum',
      direction: 'outbound',
      text: finalText,
      context: tamperContext,
    });
    finalText = stage1.text;

    finalText = this.applyDefaultPersona(ctx.topicId, finalText);

    const stage2 = await this.tamperLayer.run({
      stage: 'outbound.forum_post_body',
      direction: 'outbound',
      text: finalText,
      context: tamperContext,
    });
    finalText = stage2.text;

    const robotIdentity = this.store.getIdentityByKind('robot');
    if (!robotIdentity) {
      return;
    }
    const { cleanedText: withoutArtifacts, artifacts } = extractArtifactMarkers(finalText);
    const { cleanedText: withoutForumRefs, ids: pendingAttachmentIds } = extractForumAttachmentRefs(withoutArtifacts);
    const { cleanedText, requested } = extractRobotTtsMarker(withoutForumRefs);
    const duplicatePost = this.store.findRecentDuplicatePost({
      topicId: ctx.topicId,
      authorId: robotIdentity.id,
      body: cleanedText,
    });
    if (duplicatePost) {
      if (requested) {
        this.attachTtsToPost(duplicatePost.id, cleanedText).catch(() => undefined);
      }
      if (pendingAttachmentIds.length > 0) {
        this.attachPendingAttachmentsToPost(duplicatePost.id, ctx.topicId, pendingAttachmentIds).catch((err: unknown) => {
          console.warn('Pending attachment link failed for post ' + duplicatePost.id + ': ' + (err instanceof Error ? err.message : String(err)));
        });
      }
      if (artifacts.length > 0) {
        this.attachArtifactsToPost(duplicatePost.id, artifacts).catch((err: unknown) => {
          console.warn('Artifact attachment failed for post ' + duplicatePost.id + ': ' + (err instanceof Error ? err.message : String(err)));
        });
      }
      ctx.lastAssistantAt = Date.now();
      return;
    }

    const sessionMessage = this.store.createSessionMessage(ctx.sessionId, 'assistant', finalText, 'public');
    const post = this.store.createPost({
      topicId: ctx.topicId,
      body: cleanedText,
      authorId: robotIdentity.id,
      parentPostId: opts?.parentPostId ?? ctx.lastUserPostId,
      sourceMessageId: sessionMessage.id,
    });
    if (requested) {
      this.attachTtsToPost(post.id, cleanedText).catch(() => undefined);
    }
    if (pendingAttachmentIds.length > 0) {
      this.attachPendingAttachmentsToPost(post.id, ctx.topicId, pendingAttachmentIds).catch((err: unknown) => {
        console.warn('Pending attachment link failed for post ' + post.id + ': ' + (err instanceof Error ? err.message : String(err)));
      });
    }
    if (artifacts.length > 0) {
      this.attachArtifactsToPost(post.id, artifacts).catch((err) => {
        console.warn('Artifact attachment failed for post ' + post.id + ': ' + (err instanceof Error ? err.message : String(err)));
      });
    }

    this.persistTamperTrail({
      topicId: ctx.topicId,
      sessionId: ctx.sessionId,
      postId: post.id,
      sessionMessageId: sessionMessage.id,
      trail: [...stage1.trail, ...stage2.trail],
    });

    this.bus.emit(ctx.topicId, { type: 'assistant_message', data: { text: finalText } });
    void this.syncReasoningFromHistory(threadId, ctx);
    ctx.lastAssistantAt = Date.now();

    if (this.config.autoRunDirector) {
      void this.config.autoRunDirector.handleAssistantReply({
        topicId: ctx.topicId,
        postId: post.id,
        text: cleanedText,
      });
    }
  }

  private getLatestAssistantSessionMessage(sessionId: string): { content: string; created_at: string } | null {
    const messages = this.store.listSessionMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.role === 'assistant') {
        return message;
      }
    }
    return null;
  }

  private normalizeAssistantText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private async enrichSubagentToolRun(agentId: string, ctx: ThreadContext): Promise<void> {
    const toolRunId = this.spawnToolRunByAgentId.get(agentId);
    if (!toolRunId) return;
    try {
      const history = await this.client.getThreadHistory(agentId);
      if (!history?.items || !Array.isArray(history.items)) return;
      const summary = summarizeSubagentHistory(history.items);
      if (summary) {
        this.store.updateToolRun(toolRunId, {
          output_summary: truncateText(summary, 2000),
        });
        this.emitState(ctx.topicId);
      }
    } catch (err) {
      console.warn(`[ECHS] enrichSubagentToolRun failed for ${agentId}:`, err);
    } finally {
      this.spawnToolRunByAgentId.delete(agentId);
    }
  }

  private async ensureAssistantBackfill(
    threadId: string,
    ctx: ThreadContext,
    turnStartedAt: number | null,
    turnParentPostId: string | null
  ): Promise<void> {
    if (!turnStartedAt) return;
    if (ctx.lastAssistantAt && ctx.lastAssistantAt >= turnStartedAt) return;

    const latestSessionAssistant = this.getLatestAssistantSessionMessage(ctx.sessionId);
    if (latestSessionAssistant) {
      const latestAt = Date.parse(latestSessionAssistant.created_at);
      if (!Number.isNaN(latestAt) && latestAt >= turnStartedAt) {
        ctx.lastAssistantAt = latestAt;
        return;
      }
    }

    const history = await this.client.getConversationHistory(threadId);
    const items = Array.isArray(history?.items) ? history.items : [];
    if (items.length === 0) return;

    let latestText: string | null = null;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i] as any;
      if (item?.type === 'message' && item?.role === 'assistant') {
        const text = extractAssistantText(item);
        if (text?.trim()) {
          latestText = text;
          break;
        }
      }
    }
    if (!latestText) return;

    if (latestSessionAssistant) {
      const normalizedExisting = this.normalizeAssistantText(latestSessionAssistant.content);
      const normalizedLatest = this.normalizeAssistantText(latestText);
      if (normalizedExisting === normalizedLatest) {
        return;
      }
    }

    await this.persistAssistantMessage(threadId, ctx, latestText, { parentPostId: turnParentPostId });
  }

  private async syncReasoningFromHistory(
    threadId: string,
    ctx: ThreadContext | null,
    planContextOverride?: PlanContext | null
  ): Promise<boolean> {
    const planContext = planContextOverride ?? this.resolvePlanContext(threadId, ctx);
    if (!planContext) return false;
    const history = await this.client.getConversationHistory(threadId);
    const items = history?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return false;
    }
    const filtered = items.filter((item) => item && typeof item === 'object' && (item as any).type !== 'session_break');
    const summary = extractLatestReasoningSummary(filtered);
    if (!summary) {
      return false;
    }
    if (ctx) {
      ctx.reasoningSummary = summary;
    }
    const planId = this.upsertPlanForSummary(planContext, summary, ctx?.planId ?? null);
    if (ctx) {
      ctx.planId = planId;
    }
    this.upsertRobotStateForPlan(planContext, planId, {
      ...(ctx?.currentTurnId ? { activity: 'thinking' } : {}),
      ...(ctx?.model ? { model: ctx.model } : {}),
      ...(ctx?.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
    });
    return true;
  }

  private persistTamperTrail(opts: {
    topicId: string;
    sessionId: string;
    postId: string | null;
    sessionMessageId: string | null;
    trail: MessageTamperTrailEntry[];
  }): void {
    if (opts.trail.length === 0) return;
    for (const entry of opts.trail) {
      this.store.createMessageTamper({
        topicId: opts.topicId,
        sessionId: opts.sessionId,
        postId: opts.postId,
        sessionMessageId: opts.sessionMessageId,
        direction: entry.direction,
        stage: entry.stage,
        pluginKey: entry.pluginKey,
        pluginPriority: entry.pluginPriority,
        inputText: entry.inputText,
        outputText: entry.outputText,
        changed: entry.changed,
        error: entry.error ?? null,
        durationMs: entry.durationMs,
      });
    }
  }

  private applyDefaultPersona(topicId: string, text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return text;

    const topic = this.store.getTopic(topicId);
    if (!topic) return text;

    const personas = this.store.listRobotPersonas(topic.forum_id);
    if (personas.length !== 1) return text;
    if (this.personaBlockRegex.test(text)) return text;

    const personaKey = personas[0]?.key;
    if (!personaKey) return text;

    return `[[persona:${personaKey}]]\n${trimmed}\n[[/persona]]`;
  }

  private async attachPendingAttachmentsToPost(postId: string, topicId: string, ids: string[]): Promise<void> {
    for (const id of [...new Set(ids)]) {
      const pending = this.store.getPendingAttachment(id);
      if (!pending) {
        console.warn('Pending attachment not found: ' + id);
        continue;
      }
      if (pending.topic_id !== topicId) {
        console.warn('Pending attachment topic mismatch: ' + id);
        continue;
      }
      if (new Date(pending.expires_at).getTime() <= Date.now()) {
        this.store.deletePendingAttachment(id);
        console.warn('Pending attachment expired: ' + id);
        continue;
      }
      this.store.createAttachment({
        postId,
        filename: pending.filename,
        mimeType: pending.mime_type,
        sizeBytes: pending.size_bytes,
        storagePath: pending.storage_path,
        sha256: pending.sha256 ?? null,
      });
      this.store.deletePendingAttachment(id);
    }
  }

  private async attachArtifactsToPost(postId: string, artifacts: ArtifactRequest[]): Promise<void> {
    const uploadsDir = this.config.tts?.uploadsDir;
    if (!uploadsDir) return;
    const allowedRoot = resolve(this.config.workDir);
    for (const artifact of artifacts) {
      const sourcePath = resolve(artifact.path);
      if (!isPathWithin(allowedRoot, sourcePath)) {
        console.warn('Skipping artifact outside workDir: ' + sourcePath);
        continue;
      }
      let filename = basename(artifact.filename?.trim() || basename(sourcePath)).replace(/[\r\n"]/g, '');
      let mimeType = artifact.mimeType?.trim() || guessMimeType(filename);
      let sizeBytes = 0;
      let sha256: string | null = null;
      const ext = extname(filename);
      const storageName = ext ? 'artifact_' + randomUUID() + ext : 'artifact_' + randomUUID();
      const storagePath = join(uploadsDir, storageName);

      if (existsSync(sourcePath)) {
        const stat = statSync(sourcePath);
        if (!stat.isFile() || stat.size <= 0) continue;
        copyFileSync(sourcePath, storagePath);
        sizeBytes = statSync(storagePath).size;
        sha256 = sha256File(storagePath);
      } else {
        const resolved = await this.client.resolveArtifact({
          path: artifact.path,
          filename: artifact.filename ?? null,
          mimeType: artifact.mimeType ?? null,
        });
        filename = resolved.filename.replace(/[\r\n"]/g, '');
        mimeType = resolved.mimeType;
        writeFileSync(storagePath, Buffer.from(resolved.dataBase64, 'base64'));
        sizeBytes = statSync(storagePath).size;
        sha256 = resolved.sha256;
      }

      this.store.createAttachment({
        postId,
        filename,
        mimeType,
        sizeBytes,
        storagePath,
        sha256,
      });
    }
  }

  private async attachTtsToPost(postId: string, text: string): Promise<void> {
    const ttsConfig = this.config.tts;
    if (!ttsConfig?.enabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const hash = createHash('sha256').update(trimmed).digest('hex');
    const storageId = `tts_${hash}`;
    const storagePath = buildTtsStoragePath(ttsConfig.uploadsDir, storageId);
    const filename = `${storageId}.mp3`;

    if (!existsSync(storagePath)) {
      const result = await generateTtsMp3({
        scriptPath: ttsConfig.scriptPath,
        text: trimmed,
        outPath: storagePath,
        ...(ttsConfig.maxChars !== undefined && { maxChars: ttsConfig.maxChars }),
      });
      if (!result.ok) {
        console.warn(`TTS generation failed for post ${postId}: ${result.error ?? 'unknown error'}`);
        return;
      }
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(storagePath).size;
    } catch {
      sizeBytes = 0;
    }

    if (sizeBytes <= 0) {
      return;
    }

    this.store.createAttachment({
      postId,
      filename,
      mimeType: 'audio/mpeg',
      sizeBytes,
      storagePath,
      sha256: sha256File(storagePath),
    });
  }

  private formatCatchupContext(opts: {
    topicId: string;
    posts: Array<{
      id: string;
      author_id: string;
      body: string;
      created_at: string;
      deleted_at: string | null;
      silent: number;
      parent_post_id: string | null;
    }>;
    maxPostChars: number;
    apiBaseUrl: string | null;
  }): string {
    const lines: string[] = [];
    lines.push('[CATCH-UP CONTEXT]');
    lines.push(
      [
        'The posts below were created after the last dispatched robot turn and were not included in the robot context at the time.',
        'They may include posts explicitly marked as silent (no robot response).',
        'If any instructions conflict, follow the latest post that triggered this turn.',
      ].join(' ')
    );
    lines.push('');

    const apiBase = opts.apiBaseUrl?.trim() ? opts.apiBaseUrl.trim().replace(/\/$/, '') : null;

    for (const post of opts.posts) {
      const author = this.store.getIdentity(post.author_id);
      const flags: string[] = [];
      if (post.silent) flags.push('silent');
      if (post.deleted_at) flags.push('deleted');
      const attachments = this.store.listAttachmentsByPost(post.id).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        postId: attachment.post_id,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
        storagePath: attachment.storage_path,
        sha256: attachment.sha256 ?? null,
        url: apiBase ? `${apiBase}/attachments/${attachment.id}` : `/attachments/${attachment.id}`,
      }));
      lines.push(
        formatForumPostEnvelope({
          postId: post.id,
          createdAt: post.created_at,
          parentPostId: post.parent_post_id ?? null,
          flags,
          author: {
            displayName: author?.display_name ?? 'unknown',
            username: author?.username ?? null,
            identityId: author?.id ?? post.author_id,
            kind: author?.kind ?? null,
          },
          body: post.body ?? '',
          maxPostChars: opts.maxPostChars,
          attachments,
        })
      );
      lines.push('');
    }

    lines.push('[/CATCH-UP CONTEXT]');
    return lines.join('\n').trim();
  }
}

function extractAssistantText(item: any): string {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  return '';
}

function extractReasoningSummary(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractReasoningSummary).join('');
  }
  if (typeof value === 'object') {
    if (typeof value.delta === 'string') return value.delta;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.summary) return extractReasoningSummary(value.summary);
  }
  return '';
}

function extractLatestReasoningSummary(items: any[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'reasoning') continue;
    const summary = extractReasoningSummary(item);
    if (summary) return summary;
    break;
  }
  return '';
}

function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const text = result.map(summarizeToolResult).filter(Boolean).join('\n');
    return text || safeJson(result);
  }
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record['content'])) {
      const text = record['content']
        .map((part) => {
          if (part && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string') {
            return String((part as Record<string, unknown>)['text']);
          }
          return summarizeToolResult(part);
        })
        .filter(Boolean)
        .join('\n');
      if (text.trim()) return text;
    }
    if (typeof record['text'] === 'string') return record['text'];
    if (typeof record['output'] === 'string') return record['output'];
    if (typeof record['result'] === 'string') return record['result'];
    return safeJson(result);
  }
  return String(result);
}

function mapEchsToolName(name: string): string {
  const key = name.toLowerCase();
  if (['exec_command', 'write_stdin', 'shell', 'local_shell', 'bash', 'exec'].includes(key)) return 'exec';
  if (key === 'apply_patch' || key === 'edit' || key === 'write') return 'apply_patch';
  if (['read', 'grep', 'find', 'ls', 'read_file', 'grep_files', 'list_dir'].includes(key)) return 'read';
  if (['web_search', 'websearch', 'browser', 'open', 'click', 'screenshot'].includes(key)) return 'web';
  if (key.startsWith('forum_')) return 'mcp';
  if (['spawn_agent', 'send_input', 'wait', 'close_agent', 'blackboard_read', 'blackboard_write'].includes(key))
    return 'agent';
  return 'other';
}

function formatEchsToolCommand(item: any): string | null {
  if (!item) return null;
  if (item.type === 'local_shell_call') {
    const command = item?.action?.command;
    if (Array.isArray(command)) {
      return command.join(' ');
    }
    if (typeof command === 'string') return command;
  }
  if (item.type === 'function_call') {
    const args = typeof item.arguments === 'string' ? item.arguments : safeJson(item.arguments);
    return args ? `${item.name} ${truncateText(String(args), 1000)}` : (item.name ?? null);
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeSubagentHistory(items: unknown[]): string {
  const toolCounts = new Map<string, number>();
  let lastAssistantText = '';
  for (const item of items) {
    const it = item as any;
    if (it?.type === 'function_call' || it?.type === 'local_shell_call') {
      const name = it.name ?? it.type;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
    if (it?.type === 'message' && it?.role === 'assistant') {
      const text = extractAssistantText(it);
      if (text?.trim()) lastAssistantText = text.trim();
    }
  }
  const parts: string[] = [];
  if (toolCounts.size > 0) {
    const toolSummary = Array.from(toolCounts.entries())
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(', ');
    parts.push(`Tools: ${toolSummary}`);
  }
  if (lastAssistantText) {
    const lines = lastAssistantText.split('\n').filter((l) => l.trim());
    parts.push(lines.slice(0, 5).join('\n'));
  }
  return parts.join('\n\n');
}
